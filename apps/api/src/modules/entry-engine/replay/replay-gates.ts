/**
 * Gate replay (2026-11-11): what the entry gates would have done to the engine's RECORDED decisions. Unlike
 * replay-entry (one underlying-day, every input re-read), this takes each recorded ENTER decision as it was decided
 * by news + trend + OI, and re-applies only what changed: the pre-open news expiry (news-paths.ts nseCutoffMin), the
 * indicators + chase gates (entry-gates.ts) on the line's bars as the app had them at that minute, and the index
 * cluster's one-entry-per-pass cap. The cross-pass "one open per direction" half of the cluster cap needs the
 * counterfactual trades' exits, so it is NOT replayed. A recorded NO_TRADE can only stay NO_TRADE (every change here
 * only removes entries), so only ENTER rows are replayed. Pure and deterministic.
 *
 * Data: sql/export-gate-replay.sql → fixtures/gates.real.json (git-ignored).
 */
import { mergeTrendBars, TREND_MAX_BARS, type TrendBar } from '../../signal-trader/domain/trend-tag';
import { isEnterAction, type Bar1m, type Direction } from '../domain/entry-decision';
import { applyEntryGates, inIndexCluster, indicatorReading, extensionReading, rollTo15m, sessionBars, type ExtensionReading, type IndicatorReading } from '../domain/entry-gates';
import { ENGINE_UNIVERSE } from '../domain/engine-inputs';
import { preOpenUsable } from '../domain/news-paths';

export interface GateFixtureV1 {
  v: 1;
  decisions: Array<{
    id: string;
    underlying: string;
    at: string;
    action: string;
    tradeId: string | null;
    pnl: number | null;
    line: { exchange: string; token: string } | null;
    materialPath: string | null;
    preOpen: { bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; confidence: number; at: string } | null;
  }>;
  /** candles_1m per "exchange:token": [tsMs, o, h, l, c]. */
  m1: Record<string, Array<[number, number, number, number, number]>>;
  /** `candles` 15m per "exchange:token": [tsMs, o, h, l, c]. */
  s15: Record<string, Array<[number, number, number, number, number]>>;
}

export interface GateReplayRow {
  id: string;
  underlying: string;
  /** IST "MM-DD HH:MM". */
  ist: string;
  traded: boolean;
  pnl: number | null;
  oldAction: string;
  newAction: string;
  why: string;
  indicators: IndicatorReading | null;
  extension: ExtensionReading | null;
}

const MIN = 60_000;
/** The live loader's windows (signal-trader trend-bars.loader): candles_1m 10 days, `candles` 15m newest 300. */
const HUB_LOOKBACK_MS = 10 * 86_400_000;

/** Readings at `at` from the line's bars exactly as the live service builds them. */
export function readingsAt(m1: readonly Bar1m[], s15: readonly TrendBar[], lineExchange: string, at: Date, price: number | null, direction: Direction) {
  const t = at.getTime();
  const closed1m = m1.filter((b) => b.ts + MIN <= t);
  const hub = rollTo15m(closed1m.filter((b) => b.ts >= t - HUB_LOOKBACK_MS), at);
  const older = s15.filter((b) => b.ts < t).slice(-TREND_MAX_BARS);
  const bars15 = sessionBars(mergeTrendBars(older, hub, at), lineExchange);
  const bars1m = sessionBars(closed1m, lineExchange);
  const px = price ?? (bars1m.length ? bars1m[bars1m.length - 1].close : null);
  return {
    indicators: indicatorReading(bars15, direction, at, `replay candles_1m → 15m + candles 15m (${bars15.length})`),
    extension: extensionReading({ bars15, bars1m, price: px, at, direction }),
  };
}

const toBars = (xs: ReadonlyArray<[number, number, number, number, number]> | undefined): Bar1m[] => (xs ?? []).map(([ts, o, h, l, c]) => ({ ts, open: o, high: h, low: l, close: c, volume: 0 }));
const istOf = (t: number) => new Date(t + 330 * MIN).toISOString().slice(5, 16).replace('T', ' ');
const order = (u: string) => {
  const i = (ENGINE_UNIVERSE as readonly string[]).indexOf(u.toUpperCase());
  return i < 0 ? 99 : i;
};

export function replayGates(fx: GateFixtureV1): GateReplayRow[] {
  const m1 = new Map(Object.entries(fx.m1).map(([k, v]) => [k, toBars(v)]));
  const s15 = new Map(Object.entries(fx.s15).map(([k, v]) => [k, toBars(v) as TrendBar[]]));
  const decs = fx.decisions.filter((d) => isEnterAction(d.action)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || order(a.underlying) - order(b.underlying));
  const passEntered = new Map<number, string[]>();
  const out: GateReplayRow[] = [];
  for (const d of decs) {
    const at = new Date(d.at);
    const t = at.getTime();
    const direction: Direction = d.action === 'ENTER_CE' ? 'BULLISH' : 'BEARISH';
    const row = { id: d.id, underlying: d.underlying, ist: istOf(t), traded: !!d.tradeId, pnl: d.pnl, oldAction: d.action };
    // The gates' readings (recorded on every row, as the live service records them on every decision).
    const key = d.line ? `${d.line.exchange}:${d.line.token}` : '';
    const r = d.line ? readingsAt(m1.get(key) ?? [], s15.get(key) ?? [], d.line.exchange, at, null, direction) : { indicators: null, extension: null };
    // 1. Pre-open news expiry: a PRE_OPEN-material read past the NSE / BSE cutoff no longer counts (STORY / THEME were not material, else they would have won).
    if (d.materialPath === 'PRE_OPEN' && d.preOpen) {
      const ymd = new Date(t + 330 * MIN).toISOString().slice(0, 10);
      const u = preOpenUsable({ underlying: d.underlying, sessionDate: ymd, bias: d.preOpen.bias, confidence: d.preOpen.confidence, at: d.preOpen.at, summary: '' }, at);
      if (!u.ok) {
        out.push({ ...row, newAction: 'NO_TRADE', why: `news no longer material: ${u.why}`, ...r });
        continue;
      }
    }
    // 2. Indicators + chase.
    const g = applyEntryGates(d.action as 'ENTER_CE' | 'ENTER_PE', r);
    if (!isEnterAction(g.action)) {
      const failed = [g.indicators, g.chase].filter((x) => x.verdict === 'BLOCK' || x.verdict === 'WAIT').map((x) => x.reason.split('; ')[0]);
      out.push({ ...row, newAction: g.action, why: failed.join(' + '), ...r });
      continue;
    }
    // 3. Index cluster: one new cluster entry per scan pass.
    if (inIndexCluster(d.underlying)) {
      const pass = Math.floor(t / (5 * MIN));
      const entered = passEntered.get(pass) ?? [];
      if (entered.length > 0) {
        out.push({ ...row, newAction: `${d.action} (cluster: not opened)`, why: `${entered.join(', ')} already entered for the index cluster in this scan`, ...r });
        continue;
      }
      passEntered.set(pass, [...entered, d.underlying]);
    }
    out.push({ ...row, newAction: d.action, why: 'unchanged', ...r });
  }
  return out;
}
