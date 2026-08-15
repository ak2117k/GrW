import type { SentinelVerdict } from '@prisma/client';
import type { ContextPacket } from '../services/context-packet.service';
import type { SentinelAgentService } from '../services/sentinel-agent.service';
import type { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';

/**
 * One stored verdict, reduced to what a replay needs.
 *
 * `promptVersion` is not decoration: without it the report cannot say what the
 * new prompt was compared against, and a diff run against a mixed-vintage
 * corpus is uninterpretable.
 */
export type ReplayRow = Pick<
  SentinelVerdict,
  'id' | 'symbol' | 'verdict' | 'packet' | 'promptVersion'
>;

/** Just enough of the agent to judge — no DI container, no client. */
export type ReplayAgent = Pick<SentinelAgentService, 'judge' | 'promptVersion'>;

export interface ReplayDiff {
  id: string;
  symbol: string;
  was: string;
  now: string;
  storedPromptVersion: string;
}

/**
 * A packet the current prompt could not produce a valid verdict for.
 *
 * This is a MEASUREMENT, not an error to be swallowed: the agent rejects a
 * verdict that cites nothing, cites invented evidence, or claims unearned
 * certainty, so a rise in failures between two prompt versions is precisely the
 * regression signal the harness exists to surface. The reason is kept because
 * "3 failed" cannot be acted on and "3 cited evidence not in the packet" can.
 */
export interface ReplayFailure {
  id: string;
  symbol: string;
  was: string;
  storedPromptVersion: string;
  error: string;
}

export interface ReplayReport {
  total: number;
  agreed: number;
  changed: number;
  failed: number;
  /** The prompt version doing the judging now. */
  promptVersion: string;
  /** Every prompt version that produced a row in this corpus, first-seen order. */
  storedPromptVersions: string[];
  /**
   * How many rows were produced by the version doing the judging NOW.
   *
   * Those rows are not a measurement of anything: same prompt, same packet, so
   * they agree except where the model itself is non-deterministic, and they drag
   * the headline agreement rate toward 100% while looking like evidence the new
   * prompt is safe. Read the report as `agreed` out of
   * `total - sameVersionRows` when this is non-zero. It is stated rather than
   * filtered out because a same-version DISAGREEMENT is worth seeing — it is
   * model non-determinism, and it sets the noise floor every other number in
   * this report has to clear.
   */
  sameVersionRows: number;
  diffs: ReplayDiff[];
  failures: ReplayFailure[];
}

/**
 * Re-run stored packets through the CURRENT prompt and diff the verdicts.
 *
 * The packet is replayed VERBATIM — the stored object is handed to the agent by
 * reference, never rebuilt from live services and never reserialised. Rebuilding
 * would move the evidence and the prompt at the same time, and the diff would no
 * longer tell you which one caused the change. That is also why the agent was
 * built as a pure function from evidence to verdict.
 *
 * Note on storage: Prisma `Json` is Postgres `jsonb`, which normalises key order
 * and whitespace on write. Re-RUNNING a stored packet is therefore sound;
 * byte-level comparison of the stored JSON text is not, and nothing here does it.
 *
 * Reads only. It calls no broker, builds no packet, and writes no verdict — a
 * verdict written by a replay would enter the corpus as though it came from a
 * live position and corrupt every later run.
 */
export async function replayVerdicts(
  rows: ReplayRow[],
  agent: ReplayAgent,
): Promise<ReplayReport> {
  const report: ReplayReport = {
    total: rows.length,
    agreed: 0,
    changed: 0,
    failed: 0,
    promptVersion: agent.promptVersion,
    storedPromptVersions: [],
    sameVersionRows: 0,
    diffs: [],
    failures: [],
  };

  for (const row of rows) {
    if (!report.storedPromptVersions.includes(row.promptVersion)) {
      report.storedPromptVersions.push(row.promptVersion);
    }
    if (row.promptVersion === agent.promptVersion) report.sameVersionRows += 1;
    try {
      // The cast is the point of contact between a `Json` column and the typed
      // packet. It is a cast and not a parse ON PURPOSE: parsing would rebuild.
      const fresh = await agent.judge(row.packet as unknown as ContextPacket);
      if (fresh.verdict === row.verdict) {
        report.agreed += 1;
      } else {
        report.changed += 1;
        report.diffs.push({
          id: row.id,
          symbol: row.symbol,
          was: row.verdict,
          now: fresh.verdict,
          storedPromptVersion: row.promptVersion,
        });
      }
    } catch (err) {
      // A rejection is a data point about the new prompt, not a reason to stop.
      report.failed += 1;
      report.failures.push({
        id: row.id,
        symbol: row.symbol,
        was: row.verdict,
        storedPromptVersion: row.promptVersion,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

/** Convenience entry point: pull one user's recent corpus and replay it. */
export async function replayVerdictsForUser(
  repo: Pick<SentinelVerdictRepository, 'listForUser'>,
  agent: ReplayAgent,
  userId: string,
  limit: number,
): Promise<ReplayReport> {
  return replayVerdicts(await repo.listForUser(userId, limit), agent);
}
