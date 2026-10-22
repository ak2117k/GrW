import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APIConnectionError, APIError, RateLimitError } from '@anthropic-ai/sdk';
import type { ContextPacket } from './context-packet.service';
import type { MessagesTransport, TransportMessage } from './llm-transport';
import {
  SENTINEL_EFFORT_ROUTINE,
  SENTINEL_EFFORT_TRIGGERED,
  SENTINEL_MODEL,
  SENTINEL_MODEL_ROUTINE,
  sentinelCompositePromptVersion,
  sentinelSystemPrompt,
  type SentinelPromptOptions,
} from '../prompts/sentinel-system-prompt';
import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { parseNewsEventsConfig } from '../../news-events/config';
import { lessonsModeFrom } from '../../self-review/lessons/lessons.logic';
import type { WakeTrigger } from './tripwire.service';
import {
  SENTINEL_OVERNIGHT_COMPOSITE_PROMPT_VERSION,
  overnightPromptFor,
} from '../prompts/sentinel-overnight-prompt';
import type { OvernightPacket } from '../overnight/overnight-packet.types';
import { parseExitTriggerProposal, type ExitTriggerProposal } from './exit-trigger-proposal';

/**
 * The effort values the API accepts. Narrowed here rather than left as `string`
 * because these are env-overridable: an operator typo would otherwise reach the
 * API as an invalid enum and fail every judgement at request time. `effortOr`
 * falls back to the compiled default instead.
 */
type Effort = 'low' | 'medium' | 'high';
const EFFORTS: readonly string[] = ['low', 'medium', 'high'];
function effortOr(raw: string | undefined, fallback: Effort): Effort {
  const value = raw?.trim().toLowerCase();
  return EFFORTS.includes(value ?? '') ? (value as Effort) : fallback;
}

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
  /**
   * The level at which this trade is wrong, machine-readable (v6). Optional on
   * the TYPE because pre-v6 replies and stored verdicts have no such key; the
   * schema requires it, so a live v6 reply carries it (possibly null).
   */
  exitTrigger?: ExitTriggerProposal | null;
  /** Set when the reply's exitTrigger was malformed; exitTrigger is then null. */
  exitTriggerProblem?: string;
}

/**
 * Nullable via `anyOf`, NOT `type: [...]` — see NULLABLE_PRICE in thesis.service.ts:
 * type arrays are outside the structured-outputs subset.
 */
const EXIT_TRIGGER_SCHEMA = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: {
        instrument: { type: 'string', enum: ['UNDERLYING', 'PREMIUM'] },
        op: { type: 'string', enum: ['BELOW', 'ABOVE'] },
        price: { type: 'number' },
      },
      required: ['instrument', 'op', 'price'],
      additionalProperties: false,
    },
  ],
} as const;

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
    exitTrigger: EXIT_TRIGGER_SCHEMA,
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
    'exitTrigger',
  ],
  additionalProperties: false,
} as const;

/** The overnight verdict set — deliberately disjoint from the live one. */
export const OVERNIGHT_VERDICTS = ['HOLD_OVERNIGHT', 'EXIT_AT_OPEN', 'TIGHTEN_AT_OPEN'] as const;
export type OvernightVerdictKind = (typeof OVERNIGHT_VERDICTS)[number];

/**
 * What the overnight review returns. No `reviewIn` (the next look is the next
 * window or the next session, not a model's choice) and no `recoveryAvailable`
 * (a live-session concept); instead, the three things a trader needs before the
 * bell: the risk, the level that changes the call, and the open plan.
 */
export interface OvernightVerdict {
  verdict: OvernightVerdictKind;
  confidence: 'low' | 'medium' | 'high';
  thesisStatus: 'INTACT' | 'WEAKENING' | 'BROKEN';
  overnightRisk: string;
  changeMindLevel: string;
  openPlan: string;
  evidence: string[];
}

export const OVERNIGHT_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...OVERNIGHT_VERDICTS] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    thesisStatus: { type: 'string', enum: ['INTACT', 'WEAKENING', 'BROKEN'] },
    overnightRisk: { type: 'string' },
    changeMindLevel: { type: 'string' },
    openPlan: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'confidence', 'thesisStatus', 'overnightRisk', 'changeMindLevel', 'openPlan', 'evidence'],
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

  constructor(
    @Inject(ANTHROPIC_CLIENT) private readonly client: MessagesTransport,
    // Optional so every existing test double that constructs this with one
    // argument keeps working, and so a container without ConfigModule still
    // boots — the compiled defaults are then used, which are the correct tiers.
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * Composite on purpose — the verdict prompt AND the thesis prompt that filled
   * the packet's `thesis` block. See `SENTINEL_COMPOSITE_PROMPT_VERSION`.
   */
  get promptVersion(): string {
    return sentinelCompositePromptVersion(this.promptOptions);
  }

  /**
   * Which optional parts of the live prompt are true for this process — the
   * prompt must never describe behaviour that is switched off.
   *  - cues: MARKET_CUES_ENABLED (below).
   *  - triggers: SENTINEL_TRIGGERS_ENABLED exactly 'true', the same test the
   *    executor's trigger watcher uses; off ⇒ no claim that an exitTrigger is executed.
   *  - discipline: EXIT_DISCIPLINE_ENABLED, parsed exactly as the tick source,
   *    the cycle and the executor's gate parse it (ON unless exactly 'false').
   *  - news: NEWS_EVENTS_V2_ENABLED exactly 'true' (parseNewsEventsConfig().rendering);
   *    'observe' and typos are off — the news-off text and stamp.
   *  - lessons: SELF_REVIEW_LESSONS resolves to 'on' (lessonsModeFrom — the default when
   *    unset), the same parse LessonsService uses to decide whether memory.lessons is
   *    filled. No ConfigService at all ⇒ off (no lessons reader is wired either).
   */
  private get promptOptions(): SentinelPromptOptions {
    return {
      cues: this.cuesOn,
      triggers: String(this.config?.get<string>('SENTINEL_TRIGGERS_ENABLED') ?? '') === 'true',
      discipline: parseExitDisciplineConfig({
        EXIT_DISCIPLINE_ENABLED: this.config?.get<string>('EXIT_DISCIPLINE_ENABLED') ?? undefined,
      }).enabled,
      news: parseNewsEventsConfig({
        NEWS_EVENTS_V2_ENABLED: this.config?.get<string>('NEWS_EVENTS_V2_ENABLED') ?? undefined,
      }).rendering,
      lessons: !!this.config && lessonsModeFrom(this.config.get<string>('SELF_REVIEW_LESSONS')) === 'on',
      // The judge gate's packet delta + held marker: on unless SENTINEL_PACKET_DELTA is exactly
      // 'false' (parsed as parseJudgeGateConfig parses it). No ConfigService at all ⇒ off.
      delta: !!this.config && String(this.config.get<string>('SENTINEL_PACKET_DELTA') ?? '').trim().toLowerCase() !== 'false',
    };
  }

  /**
   * MARKET_CUES_ENABLED, read the way MarketCuesService reads it. Off (or no
   * config): the v2 live prompt and stamp, unchanged from before the cues — the
   * packet's macro blocks are then the v2 ones too.
   */
  private get cuesOn(): boolean {
    return String(this.config?.get<string>('MARKET_CUES_ENABLED') ?? '').trim().toLowerCase() === 'true';
  }

  /** Stamped on overnight rows — a different prompt, so a different version. */
  get overnightPromptVersion(): string {
    return SENTINEL_OVERNIGHT_COMPOSITE_PROMPT_VERSION;
  }

  /** The stamp for THIS packet's prompt: the scorecard variant when it carries overnight.scorecard. */
  overnightPromptVersionFor(packet: OvernightPacket): string {
    return overnightPromptFor(packet).version;
  }

  /**
   * The model and effort for this wake, chosen by WHY the agent was woken.
   *
   * Env-overridable so cost can be retuned from the dashboard without a deploy.
   * A blank or unset variable falls back to the compiled default rather than to
   * an empty model id, which the API would reject at request time — a
   * misconfiguration must not turn into a silent outage of the judge.
   *
   * See `SENTINEL_MODEL_ROUTINE` for why the split is by difficulty, not
   * importance, and why a FIRE never gets the cheaper tier.
   */
  private tierFor(trigger: WakeTrigger): { model: string; effort: Effort } {
    const raw = (key: string) => this.config?.get<string>(key);
    const pick = (key: string, fallback: string) => raw(key)?.trim() || fallback;
    return trigger === 'FIRE'
      ? {
          model: pick('SENTINEL_MODEL_TRIGGERED', SENTINEL_MODEL),
          effort: effortOr(raw('SENTINEL_EFFORT_TRIGGERED'), SENTINEL_EFFORT_TRIGGERED),
        }
      : {
          // SENTINEL_ROUTINE_MODEL (judge gate, 2026-10-22) wins over the older SENTINEL_MODEL_ROUTINE.
          model: pick('SENTINEL_ROUTINE_MODEL', pick('SENTINEL_MODEL_ROUTINE', SENTINEL_MODEL_ROUTINE)),
          effort: effortOr(raw('SENTINEL_EFFORT_ROUTINE'), SENTINEL_EFFORT_ROUTINE),
        };
  }

  /**
   * `trigger` defaults to 'FIRE' — the EXPENSIVE tier. A caller that forgets to
   * say why it woke the agent gets the better model and the higher bill, never
   * the cheaper model on a decision that might have mattered. Cost control is
   * allowed to fail towards spending money; it is not allowed to fail towards a
   * worse judgement on a live trade.
   */
  async judge(packet: ContextPacket, trigger: WakeTrigger = 'FIRE'): Promise<Verdict> {
    const tier = this.tierFor(trigger);
    let response: TransportMessage;
    try {
      // Deliberately NO server-side `fallbacks`: a refusal that quietly reran on
      // a different model would change the serving model without changing the
      // packet, and Task 13's replay diff would attribute the behaviour change
      // to the prompt. A refusal must surface as a refusal.
      response = await this.client.messages.create({
        model: tier.model,
        max_tokens: MAX_TOKENS,
        output_config: {
          effort: tier.effort,
          format: {
            type: 'json_schema',
            schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        system: [
          {
            type: 'text',
            text: sentinelSystemPrompt(this.promptOptions),
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

  /**
   * The OVERNIGHT review: its own prompt, its own schema and its own validation,
   * so nothing about live-session judging or parsing moves (`judge` above is
   * untouched). Always the triggered tier — it runs about twice a day per
   * position, and it is the one judgement the trader cannot act on until the
   * bell.
   */
  async judgeOvernight(packet: OvernightPacket): Promise<OvernightVerdict> {
    const tier = this.tierFor('FIRE');
    let response: TransportMessage;
    try {
      response = await this.client.messages.create({
        model: tier.model,
        max_tokens: MAX_TOKENS,
        output_config: {
          effort: tier.effort,
          format: {
            type: 'json_schema',
            schema: OVERNIGHT_VERDICT_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        system: [
          {
            type: 'text',
            // o4 unless the packet carries overnight.scorecard (then o5).
            text: overnightPromptFor(packet).text,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: JSON.stringify(packet) }],
      });
    } catch (err) {
      this.logger.error(`sentinel agent (overnight): ${this.describeFailure(err)}`);
      throw err;
    }
    return this.validateOvernight(this.extractJson(response), packet);
  }

  /**
   * The overnight invariants. Same citation check as live — every path must be
   * in THIS packet — plus: the verdict must be one of the overnight set, at
   * least one citation must be an overnight input (the night is the point of
   * the review), and the risk, the change-of-mind level and the open plan must
   * all be stated.
   */
  private validateOvernight(raw: unknown, packet: OvernightPacket): OvernightVerdict {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('sentinel agent: overnight reply is not a verdict object — rejected');
    }
    const v = raw as OvernightVerdict;
    if (!(OVERNIGHT_VERDICTS as readonly string[]).includes(v.verdict)) {
      throw new Error(`sentinel agent: "${String(v.verdict)}" is not an overnight verdict — rejected`);
    }
    if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
      throw new Error('sentinel agent: overnight verdict cites no evidence — rejected');
    }
    const known = packetPaths(packet);
    const invented = v.evidence.filter((c) => typeof c !== 'string' || !citesRealPath(c, known));
    if (invented.length > 0) {
      throw new Error(
        `sentinel agent: overnight verdict cites evidence that is not in the packet: ${invented.join(', ')} — rejected`,
      );
    }
    if (!v.evidence.some((c) => normaliseCitation(c).startsWith('overnight.'))) {
      throw new Error('sentinel agent: overnight verdict cites no overnight input (overnight.*) — rejected');
    }
    for (const field of ['overnightRisk', 'changeMindLevel', 'openPlan'] as const) {
      if (typeof v[field] !== 'string' || v[field].trim() === '') {
        throw new Error(`sentinel agent: overnight verdict states no ${field} — rejected`);
      }
    }
    if (v.verdict === 'EXIT_AT_OPEN' && v.confidence === 'low') {
      throw new Error('sentinel agent: EXIT_AT_OPEN requires medium or high confidence — rejected');
    }
    return v;
  }

  private describeFailure(err: unknown): string {
    if (err instanceof RateLimitError) return 'rate limited by the Anthropic API';
    if (err instanceof APIConnectionError) return 'could not reach the Anthropic API';
    if (err instanceof APIError) return `Anthropic API error (status ${String(err.status)})`;
    // Transport-neutral: the CLI transport throws plain Errors that no SDK class
    // matches, and calling those "the Anthropic API" would send an operator
    // debugging an expired OAuth session to look at an API key.
    return `failure calling the judge transport: ${String(err)}`;
  }

  private extractJson(response: TransportMessage): unknown {
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

    // Ruling R12: shape-checked here (the CLI cannot enforce the schema); a bad
    // trigger never costs the verdict. An ABSENT key (pre-v6 reply) is left
    // exactly as it was — no key is added.
    const parsed = parseExitTriggerProposal(raw as Record<string, unknown>);
    if (parsed.kind === 'proposal') v.exitTrigger = parsed.proposal;
    else if (parsed.kind === 'none') v.exitTrigger = null;
    else if (parsed.kind === 'malformed') {
      v.exitTrigger = null;
      v.exitTriggerProblem = parsed.problem;
      this.logger.warn(`sentinel agent: exitTrigger ignored (${parsed.problem}) — verdict kept`);
    }
    return v;
  }
}
