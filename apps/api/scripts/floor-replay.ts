/**
 * FLOOR REPLAY (desk plan 1, Task 2): last month's live trades, the ₹2,000-style hard loss (OLD, today's prod config)
 * vs the catastrophe floor (NEW, HARD_LOSS_CEILING_BY_CLASS: ₹2,000 → class ceiling with a 3 × N15 band). Offline
 * only: reads a JSON fixture dumped read-only from prod, never touches a database or the broker, writes stdout only.
 *
 *   npx tsx apps/api/scripts/floor-replay.ts <floor-replay.fixture.json> [--hold SYM,SYM] [--set KEY=VALUE]... \
 *       [--ceilings INDEX_OPT:5000,...] > floor-replay.md
 *
 * The fixture comes from apps/api/scripts/sql/export-floor-replay.sql. Both rules are the API's own pure functions
 * (common/utils/loss-limit lossLimitForTrade / hardLossNoiseUnit, exit-discipline/hard-floor hardLossConfig /
 * hardLossReading, trade-sentinel/charges net P&L), each given its env EXPLICITLY (never process.env):
 *   OLD = FLOOR_REPLAY_OLD_ENV (+ --set overrides)    NEW = OLD + HARD_LOSS_CEILING_BY_CLASS (--ceilings).
 *
 * HOW A RULE IS WALKED (15-minute bars only; nothing is decided on 1-minute bars). The contract's 1-minute bars are
 * the raw store: they are rolled into session-aligned 15-minute bars (exit-discipline/session-bars), the first one
 * starting at the entry minute. For bar t, using bars ≤ t only:
 *   1. TOUCH — a rupee-only threshold (the plain rule; the band's cap; the band's limit when the move is unmeasurable
 *      = BAND_UNMEASURED) is checked against the bar's open, then its adverse extreme (low for a long). Opening
 *      through it exits AT THE OPEN (a gap costs the gap); touching it exits at the price where net P&L = −threshold.
 *   2. CLOSE — with the band on, hardLossReading at the 15m close (net at the close, the underlying's last 1-minute
 *      close in the bar, the noise unit from bars closed by then) decides BAND_UNDERLYING / HOLD_UNDER_N.
 *   3. SIGNAL SL — only when the walk continues past the real exit (below): the signal's SL touched exits at the SL
 *      (at the open when the bar opens through it). Checked AFTER the floor in the same bar (conservative).
 *   4. TARGET — same walks: the first signal target touched exits at the target. Checked AFTER the floor and the SL,
 *      so a bar touching both is the stop (conservative). An AI EXIT_NOW after the real exit cannot be replayed.
 * The noise unit is the code's: OLD uses N1 (ATR14 of the underlying's last 120 session minutes — computed ONLY to
 * reproduce what prod ran; with prod's trade-value stops the old rule is plain for every class, so N1 is unused
 * unless HARD_LOSS_BY_TRADE_VALUE=off), NEW uses N15 (n15FromBars on the underlying's 15-minute buckets).
 * The 20-second two-read confirmation (FLOOR_HARD_CONFIRM_SEC) is below the 15-minute resolution and is not modelled.
 *
 * WHERE A WALK ENDS. A trade whose real exit was the hard loss itself (executor reason starting
 * `FLOOR_HARD_EXIT (code rule, not a judgement) MAX_LOSS:`) is walked past that exit to the horizon (entry session
 * close; entry day + 3 sessions, or to the exit session, for a carried position): a rule that never fires ends at the
 * signal SL, the first target or the horizon's last close (HORIZON, a mark). Any
 * other real exit (AI exit, signal SL, manual close, reason unknown) ends the walk at the real exit: a rule that has
 * not fired by then exits with the real trade (ACTUAL).
 *
 * TAGS: CUT_THEN_RECOVERED_NEW_BETTER / _NEW_WORSE (old exited at a loss; on a later bar, before the new walk's floor
 * or SL bar, the price reached entry or the first target; split by new ₹ ≥ / < old ₹); NEW_LOSES_MORE (new ₹ < old ₹); NEW_LOSES_LESS (new ₹ > old ₹: the band exited sooner, or
 * the mark is better without a recovery); SAME; NOT_REACHED (neither rule fired). ₹ = net after charges (charges.ts).
 * HOLD-list (--hold, prod AI_AUTO_EXIT_HOLD) and manual trades (no live signal order) are listed, never counted.
 */
import { readFileSync } from 'fs';
import { contractValueFactor } from '@td/shared';
import { hardLossNoiseUnit, instrumentClass, lossLimitForTrade, type InstrumentClass } from '../src/common/utils/loss-limit';
import { n15FromBars } from '../src/modules/exit-discipline/cut-loss-yardstick';
import { exposureOf } from '../src/modules/exit-discipline/exposure';
import { hardLossBandOn, hardLossConfig, hardLossReading, type HardLossConfig } from '../src/modules/exit-discipline/hard-floor';
import { NOISE_LOOKBACK_MIN } from '../src/modules/exit-discipline/config';
import { noiseFromBars } from '../src/modules/exit-discipline/noise';
import { istDayOf, sessionBucketStart, sessionOnlyBars } from '../src/modules/exit-discipline/session-bars';
import type { MinuteBar } from '../src/modules/exit-discipline/types';
import { orderedTargets } from '../src/modules/signal-trader/domain/paper';
import { computeGreenFloor, segmentFor } from '../src/modules/trade-sentinel/charges';

type Env = Record<string, string | undefined>;
/** [epoch ms, open, high, low, close] */
export type RawBar = [number, number, number, number, number];

export interface FloorFixtureRow {
  trackerId: string;
  userId?: string;
  symbol: string;
  exchange: string;
  token: string;
  name: string | null;
  /** Signed: < 0 = short. */
  qty: number;
  lotSize: number | null;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  exitReason: { status: string; reason: string; at: string; fillPrice?: number | null } | null;
  /** The live signal order that opened it; null = a manual trade. */
  signal: { decisionId: string; side: string; targets: unknown; sl: number | null; source: string | null } | null;
  underlyingRef: { exchange: string; token: string } | null;
  contract1m: RawBar[];
  underlying1m: RawBar[];
  underlying15m: RawBar[];
}

/** Prod's hard-loss env on 2026-11-25: HARD_LOSS_EXIT_RUPEES=2000; cap (3000), noise N (3), GOLD:7500 and the trade-value stops at their code defaults. */
export const FLOOR_REPLAY_OLD_ENV: Env = Object.freeze({ HARD_LOSS_EXIT_RUPEES: '2000' }) as Env;
/** Owner-decided 2026-11-25. */
export const FLOOR_REPLAY_NEW_CEILINGS = 'INDEX_OPT:5000,STOCK_OPT:5000,GOLD:7500,SILVER:7500,MCX:5000';

export type OutcomeKind = 'FLOOR' | 'SIGNAL_SL' | 'TARGET' | 'ACTUAL' | 'HORIZON';
export interface RuleOutcome {
  kind: OutcomeKind;
  /** Index of the 15m bar it happened in; null for ACTUAL. */
  bar: number | null;
  at: string;
  price: number;
  net: number;
  /** FLOOR: the hard-loss band that fired (CAP / PLAIN / BAND_UNDERLYING / BAND_UNMEASURED). */
  band: string | null;
}
export type FloorTag = 'CUT_THEN_RECOVERED_NEW_BETTER' | 'CUT_THEN_RECOVERED_NEW_WORSE' | 'NEW_LOSES_MORE' | 'NEW_LOSES_LESS' | 'SAME' | 'NOT_REACHED';
export interface RuleCfg { limit: number | null; cap: number | null; band: boolean }

export interface CountedTrade {
  status: 'COUNTED';
  row: FloorFixtureRow;
  cls: InstrumentClass;
  side: 'LONG' | 'SHORT';
  actual: { price: number; net: number; reason: string };
  /** True when the walk continued past the real exit (the real exit was the hard loss). */
  pastExit: boolean;
  oldCfg: RuleCfg;
  newCfg: RuleCfg;
  old: RuleOutcome;
  new: RuleOutcome;
  tag: FloorTag;
  /** CUT_THEN_RECOVERED: the bar that reached entry / the first target. */
  recoveredBar: number | null;
  n15AtEntry: number | null;
  bars: number;
}
export type ExcludeReason = 'HOLD' | 'MANUAL' | 'NO_BARS';
export interface ExcludedTrade { status: 'EXCLUDED'; row: FloorFixtureRow; reason: ExcludeReason; detail: string }
export type TradeResult = CountedTrade | ExcludedTrade;

export interface ReplayOptions { oldEnv: Env; newEnv: Env; hold: readonly string[] }

const MIN = 60_000;
const M15 = 15 * MIN;
const r2 = (x: number) => Math.round(x * 100) / 100;
const toBar = (b: RawBar): MinuteBar => ({ ts: Number(b[0]), open: b[1], high: b[2], low: b[3], close: b[4] });

interface Bar15 extends MinuteBar { end: number }

/** Session 1-minute bars in [from, to) rolled into session-aligned 15-minute bars (the first clipped at `from`). */
export function roll15(raw: RawBar[], exchange: string, from: number, to: number): Bar15[] {
  const minutes = sessionOnlyBars(raw.map(toBar), exchange).filter((b) => b.ts >= from && b.ts < to).sort((a, b) => a.ts - b.ts);
  const out: Bar15[] = [];
  for (const m of minutes) {
    const start = sessionBucketStart(m.ts, exchange, 15);
    if (start === null) continue;
    const last = out[out.length - 1];
    if (last && last.ts === start) {
      last.high = Math.max(last.high, m.high);
      last.low = Math.min(last.low, m.low);
      last.close = m.close;
    } else {
      // The decision time is the bucket's end, clipped to the walk's end.
      out.push({ ts: start, open: m.open, high: m.high, low: m.low, close: m.close, end: Math.min(start + M15, to) });
    }
  }
  return out;
}

/** Same match as the executor's OWNER_HOLD: tradingsymbol or tracker id, case-insensitive. */
const isHeld = (hold: readonly string[], r: FloorFixtureRow) => {
  const h = hold.map((s) => s.trim().toUpperCase()).filter(Boolean);
  return [r.symbol, r.trackerId].some((k) => h.includes(String(k ?? '').trim().toUpperCase()));
};

/**
 * The hard-loss exit's verdict reason starts `${FLOOR_HARD_EXIT_REASON_PREFIX} MAX_LOSS:` (trade-sentinel
 * sentinel-cycle.service.ts, both the full path and the fast guard). Copied, not imported: that service pulls Nest.
 * An AI reason that merely mentions e.g. HARD_MAX_LOSS is NOT a hard-loss exit.
 */
export const HARD_LOSS_EXIT_REASON_START = 'FLOOR_HARD_EXIT (code rule, not a judgement) MAX_LOSS:';
export const isHardLossExit = (r: Pick<FloorFixtureRow, 'exitReason'>): boolean =>
  String(r.exitReason?.reason ?? '').startsWith(HARD_LOSS_EXIT_REASON_START);

function ruleCfgOf(env: Env, r: FloorFixtureRow, vf: number): HardLossConfig {
  return hardLossConfig(env, lossLimitForTrade(r.symbol, r.entryPrice * Math.abs(r.qty) * vf, r.exchange, env));
}

export function replayTrade(r: FloorFixtureRow, o: ReplayOptions): TradeResult {
  if (isHeld(o.hold, r)) return { status: 'EXCLUDED', row: r, reason: 'HOLD', detail: 'owner HOLD list: no floor action' };
  if (!r.signal) return { status: 'EXCLUDED', row: r, reason: 'MANUAL', detail: 'no live signal order opened it' };

  const side: 'LONG' | 'SHORT' = r.qty < 0 ? 'SHORT' : 'LONG';
  const dir = side === 'LONG' ? 1 : -1;
  const qty = Math.abs(r.qty);
  const vf = contractValueFactor(r.exchange, r.symbol);
  const segment = segmentFor({ exchange: r.exchange, symbol: r.symbol, kind: 'POSITION' });
  const net = (p: number) => computeGreenFloor({ segment, entryPrice: r.entryPrice, ltp: p, qty, side, valueFactor: vf }).netPnl;
  const entryMs = Date.parse(r.entryTime);
  const exitMs = Date.parse(r.exitTime);
  const pastExit = isHardLossExit(r);
  const entryMinute = Math.floor(entryMs / MIN) * MIN;

  // The horizon: the entry session; a carried position gets entry day + 3 sessions (or to its exit session).
  const contractAll = roll15(r.contract1m, r.exchange, entryMinute, Number.POSITIVE_INFINITY);
  const days = [...new Set(contractAll.map((b) => istDayOf(b.ts)))];
  const carried = istDayOf(exitMs) !== istDayOf(entryMs);
  const exitDayIdx = days.indexOf(istDayOf(exitMs));
  const keepDays = new Set(days.slice(0, carried ? Math.max(4, exitDayIdx + 1) : 1));
  const horizonEnd = contractAll.filter((b) => keepDays.has(istDayOf(b.ts))).reduce((e, b) => Math.max(e, b.ts + M15), entryMinute);
  // A non-hard-loss real exit ends the walk at that minute (the bars after it never happened for this trade).
  const walkEnd = pastExit ? horizonEnd : Math.min(horizonEnd, Math.floor(exitMs / MIN) * MIN);
  const bars = roll15(r.contract1m, r.exchange, entryMinute, walkEnd);
  if (bars.length === 0) return { status: 'EXCLUDED', row: r, reason: 'NO_BARS', detail: 'no contract 1-minute bars between entry and the walk end' };

  // The underlying: the last 1-minute close at or before t; its 15m buckets for N15; its 1m window for N1.
  const uEx = r.underlyingRef?.exchange ?? '';
  const u1 = sessionOnlyBars(r.underlying1m.map(toBar), uEx).sort((a, b) => a.ts - b.ts);
  const u15 = r.underlying15m.map(toBar);
  const uCloseBefore = (t: number, notBefore = Number.NEGATIVE_INFINITY): number | null => {
    let c: number | null = null;
    for (const b of u1) {
      if (b.ts >= t) break;
      if (b.ts >= notBefore) c = b.close;
    }
    return c;
  };
  const entryUnderlying = uCloseBefore(entryMinute + MIN, entryMinute - 4 * MIN); // MinuteBarsReader.closeAt
  const n1At = (t: number): number | null => {
    const day = istDayOf(t - 1);
    const w = u1.filter((b) => b.ts + MIN <= t && b.ts >= t - NOISE_LOOKBACK_MIN * MIN && istDayOf(b.ts) === day);
    return noiseFromBars(w)?.n ?? null;
  };
  const n15At = (t: number): number | null => n15FromBars(u15, uEx, t)?.n ?? null;
  const exposure = exposureOf(r.symbol, side);
  const targets = orderedTargets(side === 'LONG' ? 'BUY' : 'SELL', r.entryPrice, r.signal.targets);
  const target = targets[0] ?? null;
  // The signal's SL, when it is on the losing side of entry (a live exit trigger in prod).
  const rawSl = Number(r.signal.sl);
  const sl = Number.isFinite(rawSl) && rawSl > 0 && (r.entryPrice - rawSl) * dir > 0 ? rawSl : null;

  /** The contract price at which net P&L = −rupees (null when that loss is out of reach, e.g. a long below zero). */
  const priceAtLoss = (rupees: number): number | null => {
    const bad = (p: number) => net(p) <= -rupees;
    let lo: number;
    let hi: number;
    if (dir === 1) {
      if (!bad(0)) return null;
      lo = 0; // bad
      hi = r.entryPrice; // not bad (a ₹rupees loss needs a lower price)
    } else {
      hi = r.entryPrice * 2 + 1;
      for (let i = 0; i < 60 && !bad(hi); i++) hi *= 2;
      if (!bad(hi)) return null;
      lo = r.entryPrice;
    }
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (bad(mid) === (dir === 1)) lo = mid;
      else hi = mid;
    }
    return r2(dir === 1 ? lo : hi);
  };

  const walk = (env: Env): { out: RuleOutcome; cfg: RuleCfg } => {
    const cfg = ruleCfgOf(env, r, vf);
    const band = hardLossBandOn(cfg);
    const ruleCfg: RuleCfg = { limit: cfg.limit, cap: cfg.cap, band };
    const nUnit = (t: number) => hardLossNoiseUnit(env, r.symbol, r.exchange, n1At(t), n15At(t));
    let best: { ltp: number; u: number | null } | null = null;
    const floor = (k: number, at: number, price: number, b: string): RuleOutcome => ({ kind: 'FLOOR', bar: k, at: new Date(at).toISOString(), price: r2(price), net: r2(net(price)), band: b });
    for (let k = 0; k < bars.length; k++) {
      const b = bars[k];
      if (cfg.limit !== null) {
        // 1. TOUCH: the rupee-only threshold this bar (decided from what is known at the bar's start).
        const measurable = band && nUnit(b.ts) !== null && (entryUnderlying !== null || best?.u != null) && u1.some((m) => m.ts >= b.ts && m.ts < b.end);
        const rupees = !band ? Math.min(cfg.limit, cfg.cap ?? cfg.limit) : measurable ? (cfg.cap as number) : cfg.limit;
        const label = !band ? (cfg.cap !== null && cfg.cap < cfg.limit ? 'CAP' : 'PLAIN') : measurable ? 'CAP' : 'BAND_UNMEASURED';
        const p = priceAtLoss(rupees);
        if (p !== null) {
          const worst = dir === 1 ? b.low : b.high;
          if ((b.open - p) * dir <= 0) return { out: floor(k, b.ts, b.open, label), cfg: ruleCfg };
          if ((worst - p) * dir <= 0) return { out: floor(k, b.ts, p, label), cfg: ruleCfg };
        }
      }
      const uClose = uCloseBefore(b.end, b.ts);
      if (best === null || (b.close - best.ltp) * dir > 1e-9) best = { ltp: b.close, u: uClose };
      // 2. CLOSE: the band, on the 15m close, with bars ≤ t only.
      if (cfg.limit !== null && band) {
        const reading = hardLossReading({
          netPnl: net(b.close), cfg, exposure, underlying: uClose, entryUnderlying, bestUnderlying: best.u, nUnderlying: nUnit(b.end), noise: null,
        });
        if (reading.trip) return { out: floor(k, b.end, b.close, reading.band as string), cfg: ruleCfg };
      }
      // 3. SIGNAL SL: only on a walk past the real exit (before it, the real trade's own exit already includes it);
      //    after the floor in the same bar (conservative). Opening through it fills at the open (a gap costs the gap).
      if (pastExit && sl !== null) {
        if ((b.open - sl) * dir <= 0) return { out: { kind: 'SIGNAL_SL', bar: k, at: new Date(b.ts).toISOString(), price: b.open, net: r2(net(b.open)), band: null }, cfg: ruleCfg };
        if (((dir === 1 ? b.low : b.high) - sl) * dir <= 0) return { out: { kind: 'SIGNAL_SL', bar: k, at: new Date(b.ts).toISOString(), price: sl, net: r2(net(sl)), band: null }, cfg: ruleCfg };
      }
      // 4. TARGET: only on a walk past the real exit; after the floor and the SL (a bar touching both is the stop).
      if (pastExit && target !== null && ((dir === 1 ? b.high : b.low) - target) * dir >= 0) {
        return { out: { kind: 'TARGET', bar: k, at: new Date(b.ts).toISOString(), price: target, net: r2(net(target)), band: null }, cfg: ruleCfg };
      }
    }
    const last = bars[bars.length - 1];
    const out: RuleOutcome = pastExit
      ? { kind: 'HORIZON', bar: bars.length - 1, at: new Date(last.end).toISOString(), price: last.close, net: r2(net(last.close)), band: null }
      : { kind: 'ACTUAL', bar: null, at: r.exitTime, price: r.exitPrice, net: r2(net(r.exitPrice)), band: null };
    return { out, cfg: ruleCfg };
  };

  const oldW = walk(o.oldEnv);
  const newW = walk(o.newEnv);
  const old = oldW.out;
  const neu = newW.out;

  // CUT_THEN_RECOVERED: entry or the first target reached on a bar AFTER the old cut and BEFORE the new floor's bar.
  let recoveredBar: number | null = null;
  if (old.kind === 'FLOOR' && old.net < 0 && old.bar !== null) {
    // The new walk ends at its floor or SL bar: a recovery in or after that bar does not count.
    const stop = (neu.kind === 'FLOOR' || neu.kind === 'SIGNAL_SL') && neu.bar !== null ? neu.bar : bars.length;
    for (let k = old.bar + 1; k < stop; k++) {
      const fav = dir === 1 ? bars[k].high : bars[k].low;
      if ((fav - r.entryPrice) * dir >= 0 || (target !== null && (fav - target) * dir >= 0)) {
        recoveredBar = k;
        break;
      }
    }
  }
  const diff = neu.net - old.net;
  const tag: FloorTag =
    old.kind !== 'FLOOR' && neu.kind !== 'FLOOR' ? 'NOT_REACHED'
      : recoveredBar !== null ? (diff <= -1 ? 'CUT_THEN_RECOVERED_NEW_WORSE' : 'CUT_THEN_RECOVERED_NEW_BETTER')
        : diff <= -1 ? 'NEW_LOSES_MORE'
          : diff >= 1 ? 'NEW_LOSES_LESS'
            : 'SAME';
  return {
    status: 'COUNTED', row: r, cls: instrumentClass(r.symbol, r.exchange), side,
    actual: { price: r.exitPrice, net: r2(net(r.exitPrice)), reason: r.exitReason ? `${r.exitReason.status}: ${r.exitReason.reason}` : 'actual reason unknown' },
    pastExit, oldCfg: oldW.cfg, newCfg: newW.cfg, old, new: neu, tag, recoveredBar, n15AtEntry: n15At(entryMs), bars: bars.length,
  };
}

export const FLOOR_TAGS: FloorTag[] = ['CUT_THEN_RECOVERED_NEW_BETTER', 'CUT_THEN_RECOVERED_NEW_WORSE', 'NEW_LOSES_MORE', 'NEW_LOSES_LESS', 'SAME', 'NOT_REACHED'];
export interface GroupSummary {
  count: number;
  tags: Record<FloorTag, number>;
  oldNet: number;
  newNet: number;
  /** Σ (new ₹ − old ₹): + = the new floor made money vs the old rule. */
  diff: number;
  worstNew: { trackerId: string; symbol: string; net: number } | null;
}
export interface FixtureReplay {
  counted: CountedTrade[];
  excluded: ExcludedTrade[];
  summary: { byClass: Partial<Record<InstrumentClass, GroupSummary>>; total: GroupSummary };
}

function group(rows: CountedTrade[]): GroupSummary {
  const tags = Object.fromEntries(FLOOR_TAGS.map((t) => [t, 0])) as Record<FloorTag, number>;
  let worst: GroupSummary['worstNew'] = null;
  let oldNet = 0;
  let newNet = 0;
  for (const c of rows) {
    tags[c.tag] += 1;
    oldNet += c.old.net;
    newNet += c.new.net;
    if (worst === null || c.new.net < worst.net) worst = { trackerId: c.row.trackerId, symbol: c.row.symbol, net: c.new.net };
  }
  return { count: rows.length, tags, oldNet: r2(oldNet), newNet: r2(newNet), diff: r2(newNet - oldNet), worstNew: worst };
}

export function replayFixture(rows: FloorFixtureRow[], o: ReplayOptions): FixtureReplay {
  const results = rows.map((r) => replayTrade(r, o));
  const counted = results.filter((x): x is CountedTrade => x.status === 'COUNTED');
  const excluded = results.filter((x): x is ExcludedTrade => x.status === 'EXCLUDED');
  const byClass: Partial<Record<InstrumentClass, GroupSummary>> = {};
  for (const cls of [...new Set(counted.map((c) => c.cls))].sort()) byClass[cls] = group(counted.filter((c) => c.cls === cls));
  return { counted, excluded, summary: { byClass, total: group(counted) } };
}

// ---------------------------------------------------------------- report ----

const ist = (iso: string) => new Date(Date.parse(iso) + 330 * MIN).toISOString().slice(5, 16).replace('T', ' ');
const inr = (v: number) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ');
const outcome = (x: RuleOutcome) => `${x.kind}${x.band ? ` ${x.band}` : ''} @ ${x.price}${x.kind !== 'ACTUAL' ? ` (${ist(x.at)})` : ''} ${inr(x.net)}`;
const cfgText = (c: RuleCfg) => (c.limit === null ? 'off' : c.band ? `₹${c.limit}→₹${c.cap} band` : `plain ₹${Math.min(c.limit, c.cap ?? c.limit)}`);

export function renderReport(res: FixtureReplay, o: ReplayOptions & { file: string }): string {
  const L: string[] = [];
  const envText = (e: Env) => Object.entries(e).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ');
  L.push('# Floor replay — the ₹2k rule (old) vs the catastrophe floor (new)');
  L.push('');
  L.push(`Fixture: \`${o.file}\` — closed live F&O / MCX trades, last 30 days.`);
  L.push('');
  L.push('**Read this first.**');
  L.push('- Both rules are evaluated on **15-minute bars** of the contract (the 1-minute table is the raw store only). Decision points are the 15m closes; the bar\'s open and low/high are used for rupee touch checks. A bar that touches both the floor and a recovery counts as the floor. A decision at bar t uses bars ≤ t only.');
  L.push('- OLD = today\'s prod hard loss: `' + envText(o.oldEnv) + '` (everything else at its code default: cap ₹3,000, HARD_LOSS_NOISE_N 3, GOLD:7500, trade-value stops on). Its band (if any) uses **N1**, the 1-minute noise unit, computed only to reproduce what prod ran; with the trade-value stops on, the old rule is plain for every class.');
  L.push('- NEW = OLD + `HARD_LOSS_CEILING_BY_CLASS=' + (o.newEnv.HARD_LOSS_CEILING_BY_CLASS ?? '') + '`: ₹2,000 → class ceiling, with the 3 × **N15** band decided on 15m closes.');
  L.push('- A trade whose real exit was the hard loss (reason `FLOOR_HARD_EXIT … MAX_LOSS:`) is walked on past that exit to the horizon (entry session; carried: entry day + 3 sessions); a rule that never fires ends at the signal SL, the first signal target or the last close (HORIZON, a mark) — SL and target are checked after the floor in the same bar. **An AI EXIT_NOW after the real exit cannot be replayed**, so those walks show what the floor, SL and target alone would have done. Any other real exit ends both walks there (ACTUAL).');
  L.push('- **Resolution is uneven:** the old plain rule (and every rupee cap) fires INTRABAR on the 15m low/high, while the new 3 × N15 band is decided only at 15m CLOSES. Prod evaluates both on every ~30 s read, so a band exit here can be later (or earlier) and at a different price than prod would have taken.');
  L.push('- **The old rule is env-only.** Since 2026-11-23 prod HOLDS a MAX_LOSS exit while the loss-side chart check (act mode) says the chart is intact; that chart gate is not modelled — the replayed old rule always fires at its rupee figure. Trades after 2026-11-23 may therefore differ from what prod actually did (compare the actual-exit column).');
  L.push('- ₹ is net after charges (trade-sentinel charges model). The 20 s two-read confirmation is below 15m resolution and not modelled.');
  L.push('- Times: a touch exit shows its 15m bar\'s START (it happened inside that bar); a close decision shows the bar\'s END; "recovered bar n" is the 0-based 15m bar from entry.');
  L.push(`- HOLD list: ${o.hold.length ? o.hold.join(', ') : '(none given — pass --hold with prod AI_AUTO_EXIT_HOLD)'}.`);
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push(`| class | trades | ${FLOOR_TAGS.join(' | ')} | old ₹ | new ₹ | new − old | worst single under new |`);
  L.push(`|---|---|${FLOOR_TAGS.map(() => '---').join('|')}|---|---|---|---|`);
  const line = (name: string, g: GroupSummary) =>
    `| ${name} | ${g.count} | ${FLOOR_TAGS.map((t) => g.tags[t]).join(' | ')} | ${inr(g.oldNet)} | ${inr(g.newNet)} | **${inr(g.diff)}** | ${g.worstNew ? `${g.worstNew.symbol} ${inr(g.worstNew.net)}` : '—'} |`;
  for (const [cls, g] of Object.entries(res.summary.byClass)) L.push(line(cls, g as GroupSummary));
  L.push(line('**total**', res.summary.total));
  L.push('');
  L.push('## Per trade');
  L.push('');
  L.push('| entry (IST) | symbol | class | side×qty @ entry | N15 at entry | old rule | new rule | actual exit | old-rule exit | new-rule exit | tag | actual reason |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of res.counted) {
    const r = c.row;
    const rec = c.recoveredBar !== null ? ` (recovered bar ${c.recoveredBar})` : '';
    L.push(
      `| ${ist(r.entryTime)} | ${r.symbol} | ${c.cls} | ${c.side}×${Math.abs(r.qty)} @ ${r.entryPrice} | ${c.n15AtEntry ?? '—'} | ${cfgText(c.oldCfg)} | ${cfgText(c.newCfg)} | ` +
        `${r.exitPrice} (${ist(r.exitTime)}) ${inr(c.actual.net)} | ${outcome(c.old)} | ${outcome(c.new)} | **${c.tag}**${rec} | ${cell(c.actual.reason).slice(0, 140)} |`,
    );
  }
  L.push('');
  L.push('## Not counted');
  L.push('');
  if (res.excluded.length === 0) L.push('None.');
  else {
    L.push('| entry (IST) | symbol | why | detail | actual exit |');
    L.push('|---|---|---|---|---|');
    for (const e of res.excluded) L.push(`| ${ist(e.row.entryTime)} | ${e.row.symbol} | ${e.reason} | ${cell(e.detail)} | ${e.row.exitPrice} (${ist(e.row.exitTime)}) |`);
  }
  return L.join('\n');
}

// ------------------------------------------------------------------- CLI ----

const USAGE = 'Usage: npx tsx apps/api/scripts/floor-replay.ts <floor-replay.fixture.json> [--hold SYM,SYM] [--set KEY=VALUE]... [--ceilings CLASS:₹,...]';

export function main(argv: string[]): number {
  let file: string | null = null;
  const hold: string[] = [];
  const set: Env = {};
  let ceilings = FLOOR_REPLAY_NEW_CEILINGS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hold') hold.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--set') {
      const [k, ...v] = String(argv[++i] ?? '').split('=');
      if (!k || v.length === 0) { console.error(`--set needs KEY=VALUE\n${USAGE}`); return 1; }
      set[k.trim()] = v.join('=').trim();
    } else if (a === '--ceilings') ceilings = String(argv[++i] ?? '');
    else if (a.startsWith('--')) { console.error(`unknown option ${a}\n${USAGE}`); return 1; }
    else file = a;
  }
  if (!file) { console.error(USAGE); return 1; }
  let rows: FloorFixtureRow[];
  try {
    rows = JSON.parse(readFileSync(file, 'utf8')) as FloorFixtureRow[];
    if (!Array.isArray(rows)) throw new Error('the fixture is not a JSON array');
  } catch (e) {
    console.error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const oldEnv: Env = { ...FLOOR_REPLAY_OLD_ENV, ...set };
  const newEnv: Env = { ...oldEnv, HARD_LOSS_CEILING_BY_CLASS: ceilings };
  const opts = { oldEnv, newEnv, hold };
  console.log(renderReport(replayFixture(rows, opts), { ...opts, file }));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
