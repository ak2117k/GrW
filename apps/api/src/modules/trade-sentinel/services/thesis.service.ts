import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { APIConnectionError, APIError, RateLimitError } from '@anthropic-ai/sdk';
import {
  SentinelThesisRepository,
  THESIS_SOURCE_INFERRED,
  THESIS_SOURCE_USER,
  type ThesisDraft,
  type UserThesisPatch,
} from '../repositories/sentinel-thesis.repository';
import { ANTHROPIC_CLIENT } from './sentinel-agent.service';
import { SENTINEL_MODEL } from '../prompts/sentinel-system-prompt';
import {
  CHART_CONTEXT_SHIM,
  absent,
  present,
  type Block,
  type ChartContextShim,
  type StoredThesis,
  type TickSnapshot,
} from './context-packet.service';
import type { Side } from '../charges';
import type { RosterEntry } from './roster.service';

/**
 * A price the model may decline to give.
 *
 * `anyOf`, NOT `type: ['number', 'null']`. The structured-outputs subset covers
 * scalar `type` values plus `enum`/`const`/`anyOf`/`allOf`/`$ref`; JSON Schema
 * type ARRAYS are not in it, so the array form risks a 400 on the first live
 * call — and nothing in this stage makes a live call, so it would surface in
 * production rather than in CI. `required` still lists all five: the model must
 * answer for every price, and `null` is how it declines.
 */
const NULLABLE_PRICE = { anyOf: [{ type: 'number' }, { type: 'null' }] } as const;

/** Structured-output schema. `additionalProperties: false` and a full `required` are mandatory. */
export const THESIS_SCHEMA = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['LONG', 'SHORT'] },
    reason: { type: 'string' },
    levelPrice: NULLABLE_PRICE,
    targetPrice: NULLABLE_PRICE,
    invalidation: NULLABLE_PRICE,
  },
  required: ['direction', 'reason', 'levelPrice', 'targetPrice', 'invalidation'],
  additionalProperties: false,
} as const;

/**
 * `max_tokens` caps THINKING PLUS RESPONSE, and thinking is on by default. The
 * thesis itself is a couple of hundred tokens; the rest is headroom for reading
 * the structure. Lowering it truncates the thinking and the thesis together, and
 * that failure looks like a malformed reply rather than a budget problem — hence
 * the explicit `max_tokens` branch in {@link ThesisService.parseReply}.
 *
 * Half the sentinel agent's budget: this is a one-shot read of a handful of
 * facts, not a running judgement over a nine-block packet.
 */
export const THESIS_MAX_TOKENS = 8000;

/**
 * The stable phrase every degraded thesis carries. Downstream (and the user's
 * "is this right?" prompt) keys off it, so it must not drift into the cause text.
 */
const UNKNOWN_REASON_PREFIX = 'thesis could not be inferred';

const THESIS_PROMPT = `You are reading a trade someone has already placed, to work out what they were most plausibly trading.

You receive one JSON object: the instrument, the side, the entry price, the entry time, the quantity, and the market structure around that instrument. The structure field is a block: either {available: true, value, source, at} or {available: false, reason}. When it is unavailable you CANNOT see the levels — say so and return nulls rather than inventing a level book.

State what the entry appears to have been: a level reclaim, a breakout, a pullback buy, a mean reversion, a fade of supply. Then give the price it hinges on, the target it implies, and the price that would prove it wrong.

Rules:
- "reason" is one sentence a trader would recognise, in their own terms ("bought the retest of the 1450 shelf"), not a description of the data you were given.
- "levelPrice", "targetPrice" and "invalidation" are prices on the same scale as the structure you were shown. Return null for any you cannot support — a guessed level is worse than no level, because it will be treated as the thing this trade hinges on.
- If the structure does not support a confident read at all, say that plainly in "reason" and return null for all three prices.
- Do not hedge across both directions. One thesis, the most plausible one.`;

/**
 * A thesis plus the one thing about forming it that the row cannot hold.
 *
 * `modelDirectionDisagreed` is deliberately optional and NEVER `false`. It is a
 * property of the inference EVENT, not of the position, and there is no column
 * for it — so on any later tick, where no inference ran, a `false` would not
 * mean "the model agreed", it would mean "nobody asked". Absent is the honest
 * encoding, and it is the same present-or-stated-absent discipline the context
 * packet uses.
 *
 * It sits here rather than on `StoredThesis` for that reason: `StoredThesis` is
 * what `find()` reconstructs from the row, and it must not carry a field the row
 * cannot round-trip. `EnsuredThesis` is assignable to `StoredThesis`, so the
 * packet builder is unaffected and simply ignores the extra.
 */
export type EnsuredThesis = StoredThesis & { modelDirectionDisagreed?: true };

/** Everything the model is allowed to see about the position. */
type InferenceRequest = {
  symbol: string;
  side: Side;
  entryPrice: number;
  entryTime: string;
  qty: number;
  structure: Block<unknown>;
};

/**
 * "Reversed" only means something relative to an expectation. A trade the
 * platform opened has its thesis on record; a trade placed by hand in the Angel
 * One app arrives as a bare symbol, quantity and price. Identical price action
 * confirms one thesis and destroys another — a drop back into a range kills a
 * breakout buy and IS the setup for a mean-reversion buy — so without a thesis
 * "has it turned?" has no answer, and the agent forms one on first sight.
 *
 * Two rules govern this service and neither bends:
 *
 * 1. INFERENCE MUST NEVER BLOCK WATCHING. Every failure path here — the API
 *    down, a refusal, a truncated reply, garbage JSON, even the store itself
 *    unreachable — returns a thesis that honestly says it is unknown. A position
 *    going unwatched because a thesis call failed is strictly worse than one
 *    watched with an unknown thesis.
 * 2. A USER CORRECTION OUTRANKS INFERENCE, permanently. Enforced in the
 *    repository's write predicate, and reinforced here by not calling the API at
 *    all once a stored thesis exists.
 */
@Injectable()
export class ThesisService {
  private readonly logger = new Logger(ThesisService.name);

  constructor(
    private readonly repo: SentinelThesisRepository,
    @Inject(ANTHROPIC_CLIENT) private readonly client: Anthropic,
    @Inject(CHART_CONTEXT_SHIM) private readonly chartContext: ChartContextShim,
  ) {}

  /**
   * The thesis for this position, forming one if there is none — or if the one
   * on record is the honest-unknown placeholder. Never throws: see rule 1.
   */
  async ensureFor(entry: RosterEntry, tick: TickSnapshot): Promise<EnsuredThesis> {
    const { userId } = entry;
    let existing: StoredThesis | null;
    try {
      existing = await this.repo.find(entry.trackerId);
    } catch (err) {
      // Unable to read whether a USER correction exists. Inferring now would
      // spend a call that cannot be persisted anyway, and would race a
      // correction we cannot see — so state the unknown and keep watching.
      const cause = this.describeFailure(err);
      this.logger.warn(`thesis lookup failed for ${entry.symbol} (${entry.trackerId}): ${cause}`);
      return asStored(unknownDraft(userId, tick.side, cause));
    }

    if (existing && !isRetryable(existing)) return existing;

    const { draft, directionDisagreed } = await this.infer(entry, tick, userId);
    let saved: StoredThesis;
    try {
      saved = await this.repo.upsertInferred(entry.trackerId, draft);
    } catch (err) {
      // Unpersisted, so the next tick infers again — but this tick still has a
      // thesis and the position stays watched.
      const cause = this.describeFailure(err);
      this.logger.warn(`thesis write failed for ${entry.symbol} (${entry.trackerId}): ${cause}`);
      saved = asStored(draft);
    }
    return directionDisagreed ? { ...saved, modelDirectionDisagreed: true } : saved;
  }

  /**
   * A user stating what they were actually trading. Unlike inference this DOES
   * throw on failure: a user is watching, and a silent no-op would leave them
   * believing a wrong thesis had been fixed. Tenant-scoped — see the repository.
   */
  async correct(
    trackerId: string,
    userId: string,
    patch: UserThesisPatch,
  ): Promise<StoredThesis> {
    return this.repo.overrideByUser(trackerId, userId, patch);
  }

  private async infer(
    entry: RosterEntry,
    tick: TickSnapshot,
    userId: string,
  ): Promise<{ draft: ThesisDraft; directionDisagreed: boolean }> {
    try {
      const request: InferenceRequest = {
        symbol: entry.symbol,
        side: tick.side,
        entryPrice: tick.entryPrice,
        entryTime: tick.entryTime.toISOString(),
        qty: tick.qty,
        structure: await this.structureFor(entry.symbol),
      };

      const response = await this.client.messages.create({
        model: SENTINEL_MODEL,
        max_tokens: THESIS_MAX_TOKENS,
        output_config: {
          effort: 'medium',
          format: {
            type: 'json_schema',
            schema: THESIS_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        system: [
          {
            type: 'text',
            text: THESIS_PROMPT,
            // Identical on every call; the position rides in the user turn, so
            // the whole prefix caches across every position and every user.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: JSON.stringify(request) }],
      });

      const parsed = this.parseReply(response);

      // Side is an observed fact off the broker's position, not something to
      // infer. A thesis whose direction disagrees inverts every later "has it
      // turned?" read, so the fact wins — but the disagreement is a signal in
      // its own right, and arguably a more useful one than the thesis prose:
      // "the structure at entry reads as a short setup, but you are long" is
      // worth putting in front of the user. It is returned as well as logged.
      const directionDisagreed = parsed.direction !== tick.side;
      if (directionDisagreed) {
        this.logger.warn(
          `thesis direction ${parsed.direction} disagrees with the ${tick.side} position on ` +
            `${entry.symbol} (${entry.trackerId}) — keeping the broker's side`,
        );
      }

      return {
        directionDisagreed,
        draft: {
          userId,
          direction: tick.side,
          reason: parsed.reason,
          levelPrice: parsed.levelPrice,
          targetPrice: parsed.targetPrice,
          invalidation: parsed.invalidation,
        },
      };
    } catch (err) {
      const cause = this.describeFailure(err);
      this.logger.warn(`thesis inference failed for ${entry.symbol} (${entry.trackerId}): ${cause}`);
      // No reading happened, so there is no disagreement to report — as opposed
      // to a disagreement that did not occur.
      return { draft: unknownDraft(userId, tick.side, cause), directionDisagreed: false };
    }
  }

  /**
   * The level book AS A BLOCK — present with its own provenance, or absent with
   * a reason. Never omitted: handed a request with no structure key, the model
   * reasons fluently from the prices alone and sounds exactly as confident.
   * Same discipline as the context packet.
   */
  private async structureFor(symbol: string): Promise<Block<unknown>> {
    try {
      const sourced = await this.chartContext.levelsFor(symbol);
      if (!sourced || sourced.value === null || sourced.value === undefined) {
        return absent('no level book for this symbol — the structure at entry cannot be read');
      }
      return present(sourced.value, sourced.source, sourced.at ?? new Date().toISOString());
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      return absent(`the level book could not be loaded: ${cause}`);
    }
  }

  /** Classified by SDK exception CLASS, never by message text. */
  private describeFailure(err: unknown): string {
    if (err instanceof RateLimitError) return 'rate limited by the Anthropic API';
    if (err instanceof APIConnectionError) return 'could not reach the Anthropic API';
    if (err instanceof APIError) return `Anthropic API error (status ${String(err.status)})`;
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Throws a STATED cause for every malformed reply; `infer` turns whatever
   * comes out into the unknown thesis's reason. The stop_reason branches matter
   * because a truncated reply otherwise surfaces as "not JSON", which reads as a
   * prompt regression when it is a budget problem.
   */
  private parseReply(response: Anthropic.Message): {
    direction: Side;
    reason: string;
    levelPrice: number | null;
    targetPrice: number | null;
    invalidation: number | null;
  } {
    if (response.stop_reason === 'refusal') {
      throw new Error('the model refused to read this position');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        `the reply was truncated at the ${THESIS_MAX_TOKENS}-token cap (thinking plus response)`,
      );
    }
    if (response.stop_reason === 'model_context_window_exceeded') {
      throw new Error('the request exceeded the model context window');
    }

    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('the reply carried no text block');

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`the reply was not JSON: ${text.slice(0, 120)}`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('the reply was not a thesis object');
    }

    const body = raw as Record<string, unknown>;
    const direction = body.direction;
    if (direction !== 'LONG' && direction !== 'SHORT') {
      throw new Error(`the reply gave direction ${JSON.stringify(direction)}, not LONG or SHORT`);
    }
    if (typeof body.reason !== 'string' || body.reason.trim() === '') {
      throw new Error('the reply stated no reason');
    }

    return {
      direction,
      reason: body.reason.trim(),
      levelPrice: price(body.levelPrice, 'levelPrice'),
      targetPrice: price(body.targetPrice, 'targetPrice'),
      invalidation: price(body.invalidation, 'invalidation'),
    };
  }
}

/**
 * Whether a thesis already on record should be thrown away and inferred again.
 *
 * Without this, rule 1 is satisfied in the letter and defeated in the spirit: a
 * thirty-second API outage writes the honest-unknown placeholder, `find()`
 * returns it forever after, and the position is watched for the rest of its life
 * against a thesis that cannot answer the only question this service exists to
 * answer. The placeholder is a STOPGAP, and nothing was treating it as one.
 *
 * The prefix is the marker — which is what `UNKNOWN_REASON_PREFIX` was always
 * for. Two guards keep it honest:
 *  - `source !== 'USER'`, so a correction is never re-inferred over, even in the
 *    (absurd) case that a user typed the placeholder text themselves.
 *  - `startsWith`, not `includes`, so a real thesis that happens to discuss the
 *    phrase mid-sentence is not discarded.
 *
 * Cost: while the API is down this re-infers once per tick per position, capped
 * by SENTINEL_MAX_WATCHED. That is the correct trade — the alternative is a
 * permanently blind watch — but it is why the failure is logged every time, and
 * why it is EXPORTED: the caller owns the retry cadence, because only the caller
 * knows how often it ticks, and it needs this exact predicate to hold back
 * precisely the calls that would re-infer and no others. See
 * `THESIS_RETRY_COOLDOWN_MS` in the cycle.
 */
export function isRetryable(existing: StoredThesis): boolean {
  return (
    existing.source !== THESIS_SOURCE_USER && existing.reason.startsWith(UNKNOWN_REASON_PREFIX)
  );
}

/**
 * A finite number or an explicit null — nothing else. An explicit null is the
 * model doing what it was asked and is accepted; a `'1450'` string is not, and
 * would sit in a Float column reading back fine until arithmetic three modules
 * downstream concatenates it.
 */
function price(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`the reply gave a non-numeric ${field}: ${JSON.stringify(value)}`);
}

/**
 * The honest fallback. It states the intent is UNKNOWN rather than leaving the
 * field empty, because the sentinel agent reads this string verbatim and an
 * empty thesis is read as a benign one — the same confident-from-nothing failure
 * the context packet's block design exists to prevent.
 *
 * `direction` is still the position's real side: what is unknown is the INTENT,
 * not the position.
 */
function unknownDraft(userId: string, side: Side, cause: string): ThesisDraft {
  return {
    userId,
    direction: side,
    reason:
      `${UNKNOWN_REASON_PREFIX} — ${cause}. The intent behind this ${side} position is ` +
      'UNKNOWN; do not read it as a confirmed setup or judge it against one.',
    levelPrice: null,
    targetPrice: null,
    invalidation: null,
  };
}

/** A draft as the packet sees it, for the paths where it was never persisted. */
function asStored(draft: ThesisDraft): StoredThesis {
  return {
    direction: draft.direction,
    reason: draft.reason,
    levelPrice: draft.levelPrice,
    targetPrice: draft.targetPrice,
    invalidation: draft.invalidation,
    source: THESIS_SOURCE_INFERRED,
  };
}
