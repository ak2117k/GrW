import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { costInr, loadPrices, type ModelPrice } from '../budget/model-prices';
import { AnthropicApiProvider } from '../providers/anthropic-api.provider';
import { ClaudeCliProvider, type ClaudeCliTransport } from '../providers/claude-cli.provider';
import type { ProviderAdapter, ProviderResult } from '../providers/provider.types';
import { readAiConfig } from '../routes/route-config';
import type { MessagesTransport, TransportMessage, TransportRequest } from '../transport.types';
import type { AiCallRow } from './ai-call.repository';
import { currentAiCallContext } from './ai-call-context';

/**
 * Stored request / response text cap, in UTF-8 bytes, EACH. A sentinel packet
 * plus its system prompt is tens of KB; the reply is a few KB, so the response
 * is in practice always stored whole and the cap only bounds a runaway.
 */
export const AI_CALL_TEXT_CAP_BYTES = 60 * 1024;

const ERROR_MESSAGE_MAX = 2000;

export interface CappedText {
  text: string;
  bytes: number;
  truncated: boolean;
}

/** `text` cut to at most `maxBytes` UTF-8 bytes (never mid-character). */
export function capUtf8(text: string, maxBytes: number): CappedText {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  const cut = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8');
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return { text: cut.replace(/�+$/, ''), bytes, truncated: true };
}

export function systemText(req: TransportRequest): string {
  return (req.system ?? []).map((s) => s.text).join('\n\n');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The stored request: the user turn first (it is the per-call evidence), then
 * as much of the system prompt as still fits in the cap. The system prompt is a
 * versioned constant, so its sha256 identifies it even when it is cut.
 *
 * `includeSystem: false` stores the system prompt BY HASH only (`system: null`,
 * `systemStored: 'by-hash'`): its text is in an earlier row with the same
 * `systemSha256`. The sentinel prompt is ~25 KB and identical on every call, so
 * repeating it would more than double the ledger's growth.
 */
export function requestRecord(
  req: TransportRequest,
  cap = AI_CALL_TEXT_CAP_BYTES,
  includeSystem = true,
): Record<string, unknown> {
  const system = systemText(req);
  const user = (req.messages ?? []).map((m) => m.content).join('\n\n');
  const u = capUtf8(user, cap);
  const s = includeSystem ? capUtf8(system, Math.max(0, cap - Buffer.byteLength(u.text, 'utf8'))) : null;
  const schema = req.output_config?.format?.schema;
  // Messages-API shaped (`system[]`, `messages[].content`), as the gateway stores it, so the
  // corpus importer (ai-engine/src/corpus/sentinel_records.py) reads both kinds of row alike.
  // The output schema is a code constant: stored by hash only.
  return {
    model: req.model,
    max_tokens: req.max_tokens,
    output_config: {
      effort: req.output_config?.effort ?? null,
      schemaSha256: schema ? sha256(JSON.stringify(schema)) : null,
    },
    system: s ? [{ type: 'text', text: s.text }] : [],
    messages: [{ role: 'user', content: u.text }],
    systemSha256: sha256(system),
    systemStored: s ? 'full' : 'by-hash',
    bytes: { system: Buffer.byteLength(system, 'utf8'), user: u.bytes },
    truncated: { system: s ? s.truncated : false, user: u.truncated },
  };
}

/** The stored response: the reply text (capped), its stop reason and the reported usage. */
export function responseRecord(result: ProviderResult, cap = AI_CALL_TEXT_CAP_BYTES): Record<string, unknown> {
  const text = (result.message.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const t = capUtf8(text, cap);
  return {
    stop_reason: result.message.stop_reason ?? null,
    content: [{ type: 'text', text: t.text }],
    bytes: t.bytes,
    truncated: t.truncated,
    usage: {
      input_tokens: result.meta.inputTokens,
      output_tokens: result.meta.outputTokens,
      cache_creation_input_tokens: result.meta.cacheCreationInputTokens,
      cache_read_input_tokens: result.meta.cacheReadInputTokens,
    },
  };
}

export interface RecordedTransportDeps {
  adapter: ProviderAdapter;
  audit: { insert(row: AiCallRow): Promise<void> };
  /** The `ai_calls.job` label for a request (e.g. `sentinel.judge`, `news.ideas`). */
  jobOf: (req: TransportRequest) => string;
  /** API prices, for `costInr` on billed calls. A missing price records 0. */
  prices?: Map<string, ModelPrice>;
  now?: () => number;
}

/**
 * A `MessagesTransport` that writes ONE `ai_calls` row per call — success or
 * failure — for the direct (gateway-off) LLM paths: the trade sentinel's judge
 * / overnight / thesis calls and the overnight-scorecard news ideas.
 *
 * BEHAVIOUR-PRESERVING. The request is handed to the provider adapter
 * untouched, the provider's message is returned BY REFERENCE, and an error is
 * rethrown as the ORIGINAL instance, so callers that classify SDK errors by
 * class see exactly what they saw before.
 *
 * FIRE-AND-FORGET. The row is built and written after the provider answers and
 * is never awaited: a slow, hung or failing database cannot delay, change or
 * fail the call. A failed write is logged and counted in `auditWriteFailures`.
 */
export class RecordedTransport implements MessagesTransport {
  private readonly logger = new Logger(RecordedTransport.name);
  auditWriteFailures = 0;
  /**
   * System prompts this process has already written IN FULL (untruncated). Marked only after the
   * insert succeeded, so a prompt is never stored by-hash before its text is in the table. A
   * restart writes each prompt in full once more.
   */
  private readonly systemsStored = new Set<string>();

  readonly messages: { create(params: TransportRequest): Promise<TransportMessage> };

  constructor(readonly deps: RecordedTransportDeps) {
    this.messages = { create: (params) => this.call(params) };
  }

  private async call(req: TransportRequest): Promise<TransportMessage> {
    const now = this.deps.now ?? Date.now;
    const ctx = currentAiCallContext();
    const startedAt = now();
    let result: ProviderResult;
    try {
      result = await this.deps.adapter.send(req);
    } catch (err) {
      this.record(req, ctx, Math.max(0, now() - startedAt), { error: err });
      throw err;
    }
    this.record(req, ctx, Math.max(0, now() - startedAt), { result });
    return result.message;
  }

  private record(
    req: TransportRequest,
    ctx: ReturnType<typeof currentAiCallContext>,
    latencyMs: number,
    outcome: { result: ProviderResult } | { error: unknown },
  ): void {
    const fail = (e: unknown): void => {
      this.auditWriteFailures++;
      this.logger.error(`ai_calls write failed: ${(e as Error)?.message ?? String(e)}`);
    };
    try {
      const ok = 'result' in outcome ? outcome.result : null;
      const err = 'error' in outcome ? outcome.error : null;
      const sysHash = sha256(systemText(req));
      const request = requestRecord(req, AI_CALL_TEXT_CAP_BYTES, !this.systemsStored.has(sysHash));
      const storedWhole = request.systemStored === 'full' && !(request.truncated as { system: boolean }).system;
      let cost = 0;
      if (ok?.meta.billed) {
        const price = this.deps.prices?.get(req.model);
        if (price) {
          cost = costInr(
            price,
            ok.meta.inputTokens ?? 0,
            ok.meta.outputTokens ?? 0,
            ok.meta.cacheCreationInputTokens ?? 0,
            ok.meta.cacheReadInputTokens ?? 0,
          );
        }
      }
      const row: AiCallRow = {
        job: this.deps.jobOf(req),
        provider: this.deps.adapter.name,
        model: req.model,
        effort: req.output_config?.effort ?? null,
        priority: 0,
        userId: ctx.userId ?? null,
        positionId: ctx.positionId ?? null,
        setupId: ctx.setupId ?? null,
        decisionRecordId: ctx.decisionRecordId ?? null,
        requestHash: createHash('sha256').update(JSON.stringify(req)).digest('hex'),
        request,
        response: ok ? responseRecord(ok) : null,
        errorClass: err === null ? null : errorClass(err),
        errorMessage: err === null ? null : errorMessage(err),
        stopReason: ok ? (ok.message.stop_reason ?? null) : null,
        inputTokens: ok ? ok.meta.inputTokens : null,
        outputTokens: ok ? ok.meta.outputTokens : null,
        costInr: cost,
        latencyMs: Math.round(latencyMs),
        queuedMs: 0,
        fallbackFrom: null,
      };
      this.deps.audit.insert(row).then(() => {
        if (storedWhole) this.systemsStored.add(sysHash);
      }, fail);
    } catch (e) {
      fail(e);
    }
  }
}

function errorClass(err: unknown): string {
  if (err && typeof err === 'object' && err.constructor && err.constructor.name) return err.constructor.name;
  return typeof err;
}

function errorMessage(err: unknown): string {
  const msg = err && typeof err === 'object' && 'message' in err ? (err as Error).message : err;
  return String(msg).slice(0, ERROR_MESSAGE_MAX);
}

/** `AI_CALLS_RECORD` — anything but `off`/`false`/`0` records (the default). */
export function aiCallsRecordingOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0');
}

/** The API price table, or an empty map when it cannot be read (cost then records 0). */
function safePrices(): Map<string, ModelPrice> {
  try {
    return loadPrices(readAiConfig('ai-model-prices.json'));
  } catch {
    return new Map();
  }
}

/**
 * The direct (gateway-off) transport for one LLM caller: the shared CLI
 * transport when `cli`, else a fresh Anthropic SDK client — wrapped in a
 * {@link RecordedTransport} unless `AI_CALLS_RECORD=off`, which binds exactly
 * the unwrapped transport.
 */
export function directRecordedTransport(opts: {
  judge: 'api' | 'cli' | 'bedrock';
  cli: ClaudeCliTransport;
  apiKey: string | undefined;
  record: boolean;
  audit: { insert(row: AiCallRow): Promise<void> };
  jobOf: (req: TransportRequest) => string;
}): MessagesTransport {
  const isCli = opts.judge === 'cli';
  if (!opts.record) {
    return isCli ? opts.cli : (new Anthropic({ apiKey: opts.apiKey }) as unknown as MessagesTransport);
  }
  const adapter: ProviderAdapter = isCli
    ? new ClaudeCliProvider(opts.cli)
    : new AnthropicApiProvider(new Anthropic({ apiKey: opts.apiKey }) as never);
  return new RecordedTransport({ adapter, audit: opts.audit, jobOf: opts.jobOf, prices: safePrices() });
}
