import { istYmd } from '../../night-report/domain/night-report.logic';
import type { NoiseVerdict, Want } from '../../exit-noise/domain/noise-read';
import { NOISE_SCORE, noiseReadStats, scoreNoiseRead, type NoiseReadStats, type ReadScore } from '../../exit-noise/domain/noise-score';

/**
 * The "noise or real?" reads taken at AI exits (exit_noise_reads, record only — owner 2026-10-30), for
 * the run summary and the nightly diagnosis. Each NOISE / REAL read is scored against the underlying's
 * next 30 minutes (exit-noise/domain/noise-score): NOISE right = it recovered ≥ 1 N in the position's
 * favour, REAL right = it kept going ≥ 1 N against. Grouped by the IST date of the exit; `session` = S,
 * `rolling20` = the run's sessions. Observation only: nothing here changes an exit. Pure.
 */
export interface ExitNoiseReadRow {
  source: string;
  symbol: string;
  exitRule: string;
  want: Want;
  verdict: NoiseVerdict;
  exitAt: Date;
  underlyingAtExit: number | null;
  n: number | null;
  after15m: number | null;
  after30m: number | null;
  maxFavour30m: number | null;
  maxAgainst30m: number | null;
  /** The follow-up sweep has run (else the read is pending). */
  followed: boolean;
  summary: string | null;
}

/** One of S's reads for the diagnosis: its verdict, score and one-line reasoning. */
export interface SessionNoiseRead {
  symbol: string;
  source: string;
  rule: string;
  verdict: NoiseVerdict;
  score: ReadScore | null;
  favourN: number | null;
  againstN: number | null;
  why: string | null;
}

export interface ExitNoiseSummary {
  session: NoiseReadStats & { items: SessionNoiseRead[] };
  rolling20: NoiseReadStats;
}

const SESSION_READS_MAX = 40;
const WHY_MAX = 260;

function scored(r: ExitNoiseReadRow) {
  return r.followed ? scoreNoiseRead(r) : { score: null, favourN: null, againstN: null };
}

export function exitNoiseStats(rows: readonly ExitNoiseReadRow[], sessions: readonly string[]): ExitNoiseSummary {
  const S = sessions[0];
  const inWindow = new Set(sessions);
  const win = rows.filter((r) => inWindow.has(istYmd(r.exitAt))).map((r) => ({ r, s: scored(r) }));
  const onS = win.filter(({ r }) => istYmd(r.exitAt) === S);
  const stats = (xs: typeof win) => noiseReadStats(xs.map(({ r, s }) => ({ verdict: r.verdict, score: s.score })));
  return {
    session: {
      ...stats(onS),
      items: onS.slice(0, SESSION_READS_MAX).map(({ r, s }) => ({
        symbol: r.symbol, source: r.source, rule: r.exitRule, verdict: r.verdict, score: s.score, favourN: s.favourN, againstN: s.againstN,
        why: r.summary ? r.summary.slice(0, WHY_MAX) : null,
      })),
    },
    rolling20: stats(win),
  };
}

/** Compact counts for the diagnosis. */
function compact(s: NoiseReadStats) {
  return { reads: s.reads, byVerdict: s.byVerdict, scored: s.scored, pending: s.pending, noiseRight: `${s.noise.right}/${s.noise.scored}`, realRight: `${s.real.right}/${s.real.scored}` };
}

/**
 * The exit noise reads, compact for the diagnosis message: S and rolling-20 counts and scores, plus
 * S's reads with their reasoning line. null when the window has no read (nothing to assess).
 */
export function noiseReadDigest(s: ExitNoiseSummary | undefined | null) {
  if (!s || (s.rolling20?.reads ?? 0) === 0) return null;
  return {
    basis: `a NOISE read is right when the underlying recovered ≥ ${NOISE_SCORE.minMoveN} N in the position's favour within 30 min of the exit; a REAL read when it kept going ≥ ${NOISE_SCORE.minMoveN} N against; MIXED / NO_DATA are not scored`,
    session: compact(s.session),
    rolling20: compact(s.rolling20),
    sessionReads: s.session.items ?? [],
  };
}

export type NoiseReadDigest = NonNullable<ReturnType<typeof noiseReadDigest>>;
