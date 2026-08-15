import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { APIConnectionError, APIError, RateLimitError } from '@anthropic-ai/sdk';
import type { ContextPacket } from './context-packet.service';
import {
  SENTINEL_COMPOSITE_PROMPT_VERSION,
  SENTINEL_MODEL,
  SENTINEL_SYSTEM_PROMPT,
} from '../prompts/sentinel-system-prompt';

export const ANTHROPIC_CLIENT = 'ANTHROPIC_CLIENT';

export interface Verdict {
  verdict: 'HOLD' | 'EXIT_ARMED' | 'EXIT_NOW' | 'ESCALATE';
  confidence: 'low' | 'medium' | 'high';
  thesisStatus: 'INTACT' | 'WEAKENING' | 'BROKEN';
  recoveryAvailable: boolean;
  reason: string;
  evidence: string[];
  invalidationPoint: string;
  reviewIn: number;
}

/** Structured-output schema. `additionalProperties: false` and full `required` are mandatory. */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['HOLD', 'EXIT_ARMED', 'EXIT_NOW', 'ESCALATE'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    thesisStatus: { type: 'string', enum: ['INTACT', 'WEAKENING', 'BROKEN'] },
    recoveryAvailable: { type: 'boolean' },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    invalidationPoint: { type: 'string' },
    reviewIn: { type: 'integer' },
  },
  required: [
    'verdict',
    'confidence',
    'thesisStatus',
    'recoveryAvailable',
    'reason',
    'evidence',
    'invalidationPoint',
    'reviewIn',
  ],
  additionalProperties: false,
} as const;

/**
 * `max_tokens` caps THINKING PLUS RESPONSE on this model, and thinking is on by
 * default. The verdict itself is a few hundred tokens; the rest of this budget
 * is headroom for the reasoning that produced it. Lowering it truncates the
 * thinking and the verdict together — the failure looks like a malformed reply,
 * not like a budget problem.
 */
const MAX_TOKENS = 16000;

/**
 * Every field path the packet actually has, split into two sets.
 *
 * `known` is the enumerated structure. `opaque` is where enumeration stops —
 * a block (anything carrying `available`), a block's `value`, an array, or a
 * scalar leaf. Beyond an opaque path the shape belongs to the evidence SOURCE,
 * not to the packet, so `flow.oiWalls.now.callWall` is a legitimate citation
 * even though the packet type calls that whole subtree `Prisma.InputJsonValue`.
 *
 * The distinction is what makes the check bite: an unknown child of an
 * ENUMERATED group — `money.rsi`, `position.iv` — is an invented field and is
 * rejected, while an unknown child of an opaque one is simply undecidable and
 * is allowed.
 */
type PacketPaths = { known: Set<string>; opaque: Set<string> };

function isBlock(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'available' in value;
}

function packetPaths(
  packet: unknown,
  prefix = '',
  out: PacketPaths = { known: new Set(), opaque: new Set() },
): PacketPaths {
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) return out;
  for (const [key, value] of Object.entries(packet as Record<string, unknown>)) {
    // A key present with an `undefined` value carries no information — treat it
    // as absent, so a citation of it is an invention like any other.
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out.known.add(path);
    const enumerable =
      typeof value === 'object' && value !== null && !Array.isArray(value) && key !== 'value';
    if (!enumerable) {
      out.opaque.add(path);
      continue;
    }
    if (isBlock(value)) out.opaque.add(path);
    packetPaths(value, path, out);
  }
  return out;
}

/**
 * `structure.nearestSupport.value`, `memory[0].verdict` and `money.netPnl (₹6080)`
 * all normalise to a real path. The trailing parenthetical is the common one:
 * a model quoting the value it read alongside the path it read it from is
 * citing correctly, and discarding the whole verdict over the annotation would
 * be a rejection with no trading meaning.
 */
function normaliseCitation(citation: string): string {
  return citation
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\[\d+\]/g, '')
    .replace(/^\.+|\.+$/g, '')
    .trim();
}

function citesRealPath(citation: string, paths: PacketPaths): boolean {
  const segments = normaliseCitation(citation).split('.');
  if (segments.length === 0 || segments[0] === '') return false;
  let path = '';
  for (const segment of segments) {
    const next = path ? `${path}.${segment}` : segment;
    // First mismatch decides: legitimate only if the matched prefix is a point
    // past which the packet stops describing its own structure.
    if (!paths.known.has(next)) return path !== '' && paths.opaque.has(path);
    path = next;
  }
  return true;
}

/**
 * A pure function from evidence to verdict. It holds no broker access and takes
 * no action — which is what makes it replayable: capture a packet, re-run it,
 * and compare. An agent with side effects cannot be backtested, and this one
 * must be before it is ever allowed near real money.
 */
@Injectable()
export class SentinelAgentService {
  private readonly logger = new Logger(SentinelAgentService.name);

  constructor(@Inject(ANTHROPIC_CLIENT) private readonly client: Anthropic) {}

  /**
   * Composite on purpose — the verdict prompt AND the thesis prompt that filled
   * the packet's `thesis` block. See `SENTINEL_COMPOSITE_PROMPT_VERSION`.
   */
  get promptVersion(): string {
    return SENTINEL_COMPOSITE_PROMPT_VERSION;
  }

  async judge(packet: ContextPacket): Promise<Verdict> {
    let response: Anthropic.Message;
    try {
      // Deliberately NO server-side `fallbacks`: a refusal that quietly reran on
      // a different model would change the serving model without changing the
      // packet, and Task 13's replay diff would attribute the behaviour change
      // to the prompt. A refusal must surface as a refusal.
      response = await this.client.messages.create({
        model: SENTINEL_MODEL,
        max_tokens: MAX_TOKENS,
        output_config: {
          effort: 'high',
          format: {
            type: 'json_schema',
            schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        system: [
          {
            type: 'text',
            text: SENTINEL_SYSTEM_PROMPT,
            // Identical on every call, and the packet rides in the user turn —
            // so the whole prefix is cacheable across every position, every tick.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: JSON.stringify(packet) }],
      });
    } catch (err) {
      // Classified by the SDK's exception CLASSES, never by message text: a
      // provider wording change must not silently reclassify a rate limit as an
      // unknown failure. The original error is rethrown so the caller can branch
      // on the same types — a transport failure must never become a verdict.
      this.logger.error(`sentinel agent: ${this.describeFailure(err)}`);
      throw err;
    }

    return this.validate(this.extractJson(response), packet);
  }

  private describeFailure(err: unknown): string {
    if (err instanceof RateLimitError) return 'rate limited by the Anthropic API';
    if (err instanceof APIConnectionError) return 'could not reach the Anthropic API';
    if (err instanceof APIError) return `Anthropic API error (status ${String(err.status)})`;
    return `unexpected failure calling the Anthropic API: ${String(err)}`;
  }

  private extractJson(response: Anthropic.Message): unknown {
    if (response.stop_reason === 'refusal') {
      throw new Error('sentinel agent: the model refused this packet — no verdict recorded');
    }
    // A truncated reply is a BUDGET failure, and it must not be reported as a
    // parse failure: Task 13 reads "could not parse" as a prompt regression and
    // someone rewrites a prompt that was fine. Thinking and response share
    // `max_tokens`, so deep reasoning is what exhausts it.
    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        `sentinel agent: reply truncated at the ${MAX_TOKENS}-token cap (thinking plus response) — no verdict recorded`,
      );
    }
    if (response.stop_reason === 'model_context_window_exceeded') {
      throw new Error(
        'sentinel agent: the packet plus reply exceeded the model context window — no verdict recorded',
      );
    }
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('sentinel agent: could not parse reply — no text block returned');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`sentinel agent: could not parse reply as JSON: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Schema validation is the API's job; these are the SEMANTIC invariants the
   * schema cannot express. A verdict that cites nothing, cites something that is
   * not in the packet, or claims certainty it has not earned, is rejected rather
   * than recorded — a bad verdict in the corpus poisons every future replay run.
   */
  private validate(raw: unknown, packet: ContextPacket): Verdict {
    // `JSON.parse('null')` and `JSON.parse('"hold"')` both parse. Reject them
    // here so every rejection leaves Task 12 a stated reason rather than a bare
    // TypeError from the first property read.
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('sentinel agent: reply is not a verdict object — rejected');
    }
    const v = raw as Verdict;

    if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
      throw new Error('sentinel agent: verdict cites no evidence — rejected');
    }
    // The citation must point at THIS packet. Prose that merely sounds like a
    // field path ("rsi divergence") is the exact failure the evidence field
    // exists to make structurally hard, so it is a rejection, not a warning.
    const known = packetPaths(packet);
    const invented = v.evidence.filter((c) => !citesRealPath(c, known));
    if (invented.length > 0) {
      throw new Error(
        `sentinel agent: verdict cites evidence that is not in the packet: ${invented.join(', ')} — rejected`,
      );
    }
    if (v.verdict === 'EXIT_NOW' && v.confidence !== 'high') {
      throw new Error('sentinel agent: EXIT_NOW requires high confidence — rejected');
    }
    if (
      v.recoveryAvailable === false &&
      !(v.thesisStatus === 'BROKEN' && v.confidence === 'high')
    ) {
      throw new Error(
        'sentinel agent: recovery declared unavailable without a broken thesis at high confidence — rejected',
      );
    }
    if (typeof v.invalidationPoint !== 'string' || v.invalidationPoint.trim() === '') {
      throw new Error('sentinel agent: verdict states no invalidation point — rejected');
    }
    if (typeof v.reason !== 'string' || v.reason.trim() === '') {
      throw new Error('sentinel agent: verdict states no reason — rejected');
    }
    // A non-positive review interval would have the runner re-ask immediately,
    // forever — the schema's `integer` permits 0 and negatives.
    if (!Number.isFinite(v.reviewIn) || v.reviewIn <= 0) {
      throw new Error(`sentinel agent: reviewIn must be a positive number of seconds — rejected`);
    }

    return v;
  }
}
