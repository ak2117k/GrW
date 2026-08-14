import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import type { SentinelVerdict } from '@prisma/client';

/** Wire shape for a recorded verdict. Additive and optional on the frontend. */
export interface SentinelVerdictDto {
  id: string;
  trackerId: string;
  symbol: string;
  verdict: string;
  confidence: string;
  thesisStatus: string;
  recoveryAvailable: boolean;
  reason: string;
  evidence: string[];
  invalidationPoint: string | null;
  triggeredBy: string[];
  netPnl: number;
  greenFloor: number | null;
  createdAt: string; // ISO
}

/**
 * `evidence` and `triggeredBy` are `Json` columns, so what comes back is
 * whatever was written — typed `JsonValue`, not `string[]`. Coerced here rather
 * than cast: a cast would put a number or an object into a field the frontend
 * renders as text.
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function toSentinelVerdictDto(v: SentinelVerdict): SentinelVerdictDto {
  return {
    id: v.id,
    trackerId: v.trackerId,
    symbol: v.symbol,
    verdict: v.verdict,
    confidence: v.confidence,
    thesisStatus: v.thesisStatus,
    recoveryAvailable: v.recoveryAvailable,
    reason: v.reason,
    evidence: stringList(v.evidence),
    invalidationPoint: v.invalidationPoint ?? null,
    triggeredBy: stringList(v.triggeredBy),
    netPnl: v.netPnl,
    greenFloor: v.greenFloor ?? null,
    createdAt: v.createdAt.toISOString(),
  };
}

/**
 * What a user may correct about a thesis the agent inferred.
 *
 * `direction` IS DELIBERATELY ABSENT, and this is the whole reason this class
 * exists rather than the repository's `UserThesisPatch` being accepted raw.
 *
 * The side of a position is an OBSERVED FACT off the broker's book, not an
 * opinion. `ThesisService.infer` already throws the model's own `direction`
 * away and substitutes `tick.side` for exactly that reason — and then logs the
 * disagreement, because a structure that reads short under a long position is
 * worth telling the user about. Accepting `direction` here would re-open by the
 * front door what inference closes by the back one: a thesis whose direction
 * opposes the real position inverts every later "has it turned?" read, so the
 * agent would judge a long trade against a short trade's expectations and
 * conclude the thesis was intact while the position bled.
 *
 * It is DROPPED rather than validated against the position. Validating would
 * mean accepting the field, fetching the tracker, comparing, and rejecting —
 * three more failure modes for a field whose only legal value is the one
 * already on record. There is nothing for a user to say here that the broker
 * has not already said.
 *
 * The repository is the second line of defence: `sanitisePatch` rebuilds the
 * update from a whitelist, so this class being bypassed does not let `userId`
 * or `source` through either.
 */
export class CorrectThesisDto {
  /** The setup in the user's own words — "bought the retest of the 1450 shelf". */
  @IsOptional() @IsString() @IsNotEmpty() reason?: string;
  /** The price the trade hinges on. */
  @IsOptional() @IsNumber() levelPrice?: number;
  /** What the setup implies as a target. */
  @IsOptional() @IsNumber() targetPrice?: number;
  /** The price that would prove the thesis wrong. */
  @IsOptional() @IsNumber() invalidation?: number;
}
