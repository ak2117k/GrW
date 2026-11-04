import type { CarryCloseWindow } from '../../trade-sentinel/services/square-off-look';

/**
 * INTRADAY CARRY — config (spec docs/superpowers/specs/2026-11-04-intraday-carry-and-thesis-guard-design.md §5.3).
 *
 * INTRADAY_CARRY=live|off (default `live`; owner 2026-11-04, D3: live from day one, the explicit
 * exception to "new strategies start in paper"). `off` = today's behaviour exactly: no CARRY/EXIT
 * look, no conversion, no decision rows — the broker squares MIS positions off as before.
 * ROLLBACK: INTRADAY_CARRY=off.
 *
 * INTRADAY_CARRY_USERS (comma-separated user ids; default EMPTY = nobody live, D13): the only
 * accounts whose LIVE intraday positions are converted or exited by this engine. Every other
 * tenant's live positions are untouched. Paper positions are simulated for everyone (D12).
 *
 * THE BROKER'S MIS SQUARE-OFF. The codebase knows only cash: SENTINEL_EQ_SQUARE_OFF_LEAD_MIN=15
 * (Angel squares off MIS equity at 15:15 IST, judge-gate.ts). It has NO F&O or MCX MIS square-off
 * time anywhere (searched 2026-11-04: session-clock, judge-gate, exit-discipline, trade-core limits —
 * trade-core's `squareOffTime` limits are the platform's own per-vehicle rules, not Angel's).
 * So the lead is configurable per exchange and defaults conservative (EARLIER is safer: a window
 * that opens too early costs nothing, one that opens after Angel's cut leaves the decision moot):
 *   INTRADAY_CARRY_SQUARE_OFF_LEAD_MIN = "NFO:15,BFO:15,MCX:30"
 * i.e. NFO/BFO 15:15 IST (same as cash) and MCX 30 minutes before its own close (23:00, or 23:25
 * in the late-close season). Confirm against Angel's RMS circular and tighten if it is later.
 *
 * Timeline for one position (defaults, NFO): look opens 15:05 (WINDOW_MIN 10 before 15:15); no
 * judgement by 15:09 (DECIDE_BY_MIN 6) ⇒ EXIT; a CARRY must be verified on the position book by
 * 15:12 (SAFETY_MIN 3) or it is exited at market (D4). Conversion retried once, RETRY_SEC apart.
 */
export type CarryMode = 'live' | 'off';

export interface CarryConfig {
  mode: CarryMode;
  users: string[];
  /** Minutes before the exchange close that the broker squares off MIS, per exchange. */
  leadMin: Record<string, number>;
  windowMin: number;
  decideByMin: number;
  safetyMin: number;
  retrySec: number;
  problems: string[];
}

/** Exchanges the close decision covers: the derivative venues (cash MIS is observe-only for exits). */
export const CARRY_EXCHANGES: readonly string[] = ['NFO', 'BFO', 'MCX'];

const DEFAULT_LEAD: Record<string, number> = { NFO: 15, BFO: 15, MCX: 30 };

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number, lo: number, hi: number, problems: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    problems.push(`${key}=${raw} is not an integer in [${lo}, ${hi}] — using ${fallback}`);
    return fallback;
  }
  return n;
}

export function parseCarryConfig(env: Env): CarryConfig {
  const problems: string[] = [];
  const rawMode = (env.INTRADAY_CARRY ?? '').trim().toLowerCase();
  let mode: CarryMode = 'live';
  if (rawMode === 'off') mode = 'off';
  else if (rawMode !== '' && rawMode !== 'live') problems.push(`INTRADAY_CARRY=${env.INTRADAY_CARRY} is not live|off — using live`);
  const users = [...new Set(String(env.INTRADAY_CARRY_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean))];

  const leadMin: Record<string, number> = { ...DEFAULT_LEAD };
  for (const part of String(env.INTRADAY_CARRY_SQUARE_OFF_LEAD_MIN ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [ex, v] = part.split(':').map((s) => s.trim());
    const n = Number(v);
    const exchange = String(ex ?? '').toUpperCase();
    if (!CARRY_EXCHANGES.includes(exchange) || !Number.isInteger(n) || n < 0 || n > 120) {
      problems.push(`INTRADAY_CARRY_SQUARE_OFF_LEAD_MIN entry "${part}" ignored (want NFO|BFO|MCX:<0-120>)`);
      continue;
    }
    leadMin[exchange] = n;
  }
  const windowMin = int(env, 'INTRADAY_CARRY_WINDOW_MIN', 10, 4, 60, problems);
  const safetyMin = int(env, 'INTRADAY_CARRY_SAFETY_MIN', 3, 1, 30, problems);
  let decideByMin = int(env, 'INTRADAY_CARRY_DECIDE_BY_MIN', 6, 2, 59, problems);
  if (decideByMin <= safetyMin || decideByMin >= windowMin) {
    const fixed = Math.min(windowMin - 1, safetyMin + 3);
    problems.push(`INTRADAY_CARRY_DECIDE_BY_MIN=${decideByMin} must sit between SAFETY_MIN and WINDOW_MIN — using ${fixed}`);
    decideByMin = fixed;
  }
  const retrySec = int(env, 'INTRADAY_CARRY_RETRY_SEC', 30, 5, 120, problems);
  return { mode, users, leadMin, windowMin, decideByMin, safetyMin, retrySec, problems };
}

/** The reader shape of the self-review tunables (self-review/tuning/tunables.ts TuningReader). */
export type CarryTuningReader = { get<T extends number | boolean>(target: string, fallback: T): T };

/**
 * 2026-11-05 wrong-decision loop (S7): `carry.decideByMin` (integer 4–9) as a self-review override, read from
 * the SESSION-OPEN reader. It must still sit strictly between safetyMin and windowMin (the parse rule above);
 * anything else, a throwing reader, or no override ⇒ `cfg` itself (INTRADAY_CARRY_DECIDE_BY_MIN, as today).
 */
export function withCarryTuning(cfg: CarryConfig, tuning: CarryTuningReader | null | undefined): CarryConfig {
  if (!tuning) return cfg;
  let v: number;
  try {
    v = tuning.get('carry.decideByMin', cfg.decideByMin);
  } catch {
    return cfg;
  }
  const ok = Number.isInteger(v) && v >= 4 && v <= 9 && v > cfg.safetyMin && v < cfg.windowMin;
  return ok && v !== cfg.decideByMin ? { ...cfg, decideByMin: v } : cfg;
}

/** The CARRY/EXIT window for a position on `exchange`, or null when the decision does not apply there. */
export function carryWindowFor(cfg: CarryConfig, exchange: string): CarryCloseWindow | null {
  if (cfg.mode === 'off') return null;
  const ex = String(exchange ?? '').toUpperCase();
  if (!CARRY_EXCHANGES.includes(ex)) return null;
  const lead = cfg.leadMin[ex];
  return typeof lead === 'number' ? { leadMin: lead, windowMin: cfg.windowMin } : null;
}

/** Whether `userId`'s LIVE positions are in scope (D13). Paper is always in scope while mode is live. */
export const isLiveCarryUser = (cfg: CarryConfig, userId: string): boolean => cfg.mode === 'live' && cfg.users.includes(userId);

export function describeCarryConfig(c: CarryConfig): string {
  const lead = Object.entries(c.leadMin).map(([k, v]) => `${k}:${v}`).join(',');
  return `mode=${c.mode} liveUsers=${c.users.length} lead=${lead} window=${c.windowMin}m decideBy=${c.decideByMin}m safety=${c.safetyMin}m retry=${c.retrySec}s`;
}
