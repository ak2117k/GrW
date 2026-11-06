// apps/api/src/modules/sentinel-executor/domain/floor-broker-sl.ts
import type { AutoExitConfig } from './auto-exit.types';
import { isDeadOrderStatus, isTerminalOrderStatus } from './exit-order';

/**
 * FLOOR_BROKER_SL (owner-approved 2026-11-06): a real STOPLOSS-LIMIT order resting at Angel at the armed
 * noise floor, trailed up as the floor rises. Prod 2026-11-06: the polled floor exit (two reads ≥ 20 s
 * apart, then a MARKET order) filled NIFTY09NOV2624650CE at 167.6 under a 180.74 floor, FORCEMOT…19000CE
 * at 654.85 under 695.84, TITAN…5000CE at 84.6 under 90.8. A resting stop fills on the exchange tick that
 * crosses it. The polling exit stays as the backstop. Pure; no I/O.
 *
 *  - off:    nothing runs.
 *  - shadow: (DEFAULT) computes and records what it would place / modify / cancel, and, when the position
 *            exits, what the stop would have filled at against the real exit. Places NOTHING, calls no broker.
 *  - live:   places, trails and cancels the real order. Only with AI_AUTO_EXIT_ENABLED=true,
 *            AI_AUTO_EXIT_MODE=live and AI_AUTO_EXIT_CANCEL_PROTECTIVE=true — without the last one the
 *            executor's backstop market exit would refuse OPEN_ORDER_EXISTS against our own stop.
 */
export type FloorBrokerSlMode = 'off' | 'shadow' | 'live';

export interface FloorBrokerSlConfig {
  mode: FloorBrokerSlMode;
  /** FLOOR_BROKER_SL_LIMIT_TICKS (default 3, 1–20): limit = trigger − ticks (SELL) / + ticks (BUY). */
  limitTicks: number;
  /** FLOOR_BROKER_SL_MODIFY_MIN_SEC (default 15, 5–300): the least gap between two changes of one stop. */
  modifyMinSec: number;
  problems: string[];
}

const DEFAULTS = { limitTicks: 3, modifyMinSec: 15 } as const;

function int(env: Record<string, string | undefined>, name: string, fallback: number, lo: number, hi: number, problems: string[]): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= lo && n <= hi) return n;
  problems.push(`${name}=${raw} is out of range ${lo}–${hi} — using ${fallback}`);
  return fallback;
}

/** Fails SAFE: any doubt about `live` is `shadow`, never the other way round. */
export function parseFloorBrokerSlConfig(env: Record<string, string | undefined>, exit: AutoExitConfig): FloorBrokerSlConfig {
  const problems: string[] = [];
  const raw = String(env.FLOOR_BROKER_SL ?? '').trim();
  let mode: FloorBrokerSlMode = 'shadow';
  if (raw === 'off' || raw === 'live') mode = raw;
  else if (raw !== '' && raw !== 'shadow') problems.push(`FLOOR_BROKER_SL=${raw} is not off|shadow|live — using shadow`);
  if (mode === 'live') {
    const missing = [
      !exit.enabled ? 'AI_AUTO_EXIT_ENABLED=true' : null,
      exit.mode !== 'live' ? 'AI_AUTO_EXIT_MODE=live' : null,
      !exit.cancelProtective ? 'AI_AUTO_EXIT_CANCEL_PROTECTIVE=true' : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      problems.push(`FLOOR_BROKER_SL=live needs ${missing.join(', ')} — running shadow`);
      mode = 'shadow';
    }
  }
  return {
    mode,
    limitTicks: int(env, 'FLOOR_BROKER_SL_LIMIT_TICKS', DEFAULTS.limitTicks, 1, 20, problems),
    modifyMinSec: int(env, 'FLOOR_BROKER_SL_MODIFY_MIN_SEC', DEFAULTS.modifyMinSec, 5, 300, problems),
    problems,
  };
}

/** ordertag prefix of a floor stop. NOT an exit prefix (ax/am/at): an open stop must not read as a prior exit. */
export const FLOOR_STOP_TAG_PREFIX = 'afS';

/** 'afS' + the last 17 alphanumerics of the tracker id (≤ 20 chars, Angel's ordertag limit). One stop per tracker. */
export function floorStopTag(trackerId: string): string {
  return `${FLOOR_STOP_TAG_PREFIX}${String(trackerId).replace(/[^A-Za-z0-9]/g, '').slice(-17)}`;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const EPS = 1e-9;
const toTick = (x: number, tick: number, dir: 'up' | 'down') =>
  Number(((dir === 'up' ? Math.ceil(x / tick - EPS) : Math.floor(x / tick + EPS)) * tick).toFixed(4));

export type DesiredStop =
  | { ok: true; side: 'BUY' | 'SELL'; trigger: number; limit: number; quantity: number }
  | { ok: false; reason: 'NO_FLOOR' | 'BAD_TICK' | 'BAD_QTY' | 'NOT_PLACEABLE' | 'LIMIT_NOT_POSITIVE' };

/**
 * The stop the armed floor asks for. LONG: SELL, trigger = the floor CEILED to the tick (fires at or above
 * the floor, never below it), limit = trigger − limitTicks ticks. SHORT: BUY, trigger floored, limit above.
 * NOT_PLACEABLE when the price is not at least a tick on the right side of the trigger: Angel refuses a sell
 * stop at/above the LTP, and the price is then already through the floor — the polling exit's job.
 */
export function desiredFloorStop(i: { side: 'LONG' | 'SHORT'; floor: number; ltp: number; tick: number; limitTicks: number; quantity: number }): DesiredStop {
  if (!fin(i.floor) || i.floor <= 0) return { ok: false, reason: 'NO_FLOOR' };
  if (!fin(i.tick) || i.tick <= 0) return { ok: false, reason: 'BAD_TICK' };
  if (!Number.isInteger(i.quantity) || i.quantity <= 0) return { ok: false, reason: 'BAD_QTY' };
  if (i.side === 'LONG') {
    const trigger = toTick(i.floor, i.tick, 'up');
    if (!fin(i.ltp) || i.ltp < trigger + i.tick - EPS) return { ok: false, reason: 'NOT_PLACEABLE' };
    const limit = Number((trigger - i.limitTicks * i.tick).toFixed(4));
    if (limit <= 0) return { ok: false, reason: 'LIMIT_NOT_POSITIVE' };
    return { ok: true, side: 'SELL', trigger, limit, quantity: i.quantity };
  }
  const trigger = toTick(i.floor, i.tick, 'down');
  if (!fin(i.ltp) || i.ltp > trigger - i.tick + EPS) return { ok: false, reason: 'NOT_PLACEABLE' };
  return { ok: true, side: 'BUY', trigger, limit: Number((trigger + i.limitTicks * i.tick).toFixed(4)), quantity: i.quantity };
}

/** Our stop as it rests (live: from the order book; shadow: the virtual one). `changedAt` = ms of its last place/modify. */
export interface RestingStop { side: 'BUY' | 'SELL'; trigger: number; limit: number; quantity: number; changedAt: number }

export type StopAction =
  | { kind: 'PLACE'; desired: Extract<DesiredStop, { ok: true }> }
  | { kind: 'MODIFY'; desired: Extract<DesiredStop, { ok: true }>; from: RestingStop }
  | { kind: 'CANCEL'; reason: string }
  | { kind: 'KEEP'; reason: string }
  | { kind: 'NONE'; reason: string };

/**
 * One pass's decision for one position. Never lowers a stop (a SELL trigger only rises, a BUY only falls),
 * changes it at most once per `modifyMinSec` — except a stop bigger than the position, cut at once (it could
 * otherwise open a fresh position) — and cancels it the moment the position is no longer eligible.
 */
export function planFloorStop(i: {
  eligible: { ok: true } | { ok: false; reason: string };
  desired: DesiredStop | null;
  resting: RestingStop | null;
  tick: number;
  nowMs: number;
  modifyMinSec: number;
}): StopAction {
  const r = i.resting;
  if (!i.eligible.ok) return r ? { kind: 'CANCEL', reason: i.eligible.reason } : { kind: 'NONE', reason: i.eligible.reason };
  const d = i.desired;
  if (!d || !d.ok) {
    const reason = d && !d.ok ? d.reason : 'NO_DESIRED_STOP';
    return r ? { kind: 'KEEP', reason } : { kind: 'NONE', reason };
  }
  if (!r) return { kind: 'PLACE', desired: d };
  if (r.side !== d.side) return { kind: 'CANCEL', reason: 'SIDE_CHANGED' };
  if (r.quantity > d.quantity) {
    const better = d.side === 'SELL' ? d.trigger > r.trigger : d.trigger < r.trigger;
    // Quantity only: the trigger never moves the wrong way.
    const keep = better ? d : { ...d, trigger: r.trigger, limit: r.limit };
    return { kind: 'MODIFY', desired: keep, from: r };
  }
  const improves = d.side === 'SELL' ? d.trigger >= r.trigger + i.tick - EPS : d.trigger <= r.trigger - i.tick + EPS;
  if (!improves && r.quantity === d.quantity) return { kind: 'KEEP', reason: 'NO_IMPROVEMENT' };
  if (i.nowMs - r.changedAt < i.modifyMinSec * 1000) return { kind: 'KEEP', reason: 'RATE_LIMITED' };
  return { kind: 'MODIFY', desired: improves ? d : { ...d, trigger: r.trigger, limit: r.limit }, from: r };
}

type Row = Record<string, unknown>;
const num = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0; };
const statusOf = (r: Row) => String(r?.status ?? r?.orderstatus ?? '').toLowerCase();

export type BookStop =
  | { kind: 'none' }
  | { kind: 'open'; orderId: string; variety: string; side: 'BUY' | 'SELL'; trigger: number; limit: number; quantity: number; status: string }
  | { kind: 'complete'; orderId: string; averagePrice: number; filledQty: number };

/** Our floor stop for `trackerId` in a fresh order book, by ordertag. A working row wins; rejected/cancelled rows are `none`. */
export function restingFloorStop(rows: unknown[], trackerId: string): BookStop {
  const tag = floorStopTag(trackerId);
  const mine = (rows as Row[]).filter((o) => String(o?.ordertag ?? '') === tag);
  const open = mine.find((o) => !isTerminalOrderStatus(statusOf(o)));
  if (open) {
    return {
      kind: 'open', orderId: String(open.orderid ?? ''), variety: String(open.variety ?? 'STOPLOSS').toUpperCase(),
      side: String(open.transactiontype ?? '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
      trigger: num(open.triggerprice), limit: num(open.price), quantity: num(open.quantity), status: statusOf(open),
    };
  }
  const done = mine.find((o) => statusOf(o) === 'complete' || (isDeadOrderStatus(statusOf(o)) && num(o.filledshares) > 0));
  if (done) return { kind: 'complete', orderId: String(done.orderid ?? ''), averagePrice: num(done.averageprice), filledQty: num(done.filledshares) };
  return { kind: 'none' };
}

export interface StopStep { at: number; trigger: number | null; limit: number | null }
export interface Bar { ts: number; open: number; high: number; low: number; close: number }
export type SimulatedFill = {
  triggered: boolean;
  triggeredAt: number | null;
  /** The fill estimate: the trigger, or the bar's open when it opened through it (never past the limit). */
  fill: number | null;
  /** Conservative: the limit price (or the backstop fill when the limit never traded). */
  fillAtLimit: number | null;
  note: 'NOT_TRIGGERED' | 'TRADED_THROUGH' | 'OPENED_THROUGH_TRIGGER' | 'LIMIT_FILLED_ON_RECOVERY' | 'GAPPED_BELOW_LIMIT_BACKSTOP';
};

/**
 * What a resting stop would have filled at on 1-minute bars. A step applies to bars that START at or after
 * it (a modify lands mid-bar at best); `trigger: null` = cancelled. The first bar whose low (SELL) / high
 * (BUY) reaches the trigger triggers; it fills at min(trigger, open) when that is still within the limit,
 * else only when a LATER bar trades back to the limit before `untilMs` — otherwise the backstop exit
 * (`actualExit`) is the fill. The order of prices inside one bar is unknown, so nothing is credited from it.
 */
export function simulateStopFill(i: { side: 'BUY' | 'SELL'; bars: Bar[]; steps: StopStep[]; untilMs: number; actualExit: number }): SimulatedFill {
  const steps = [...i.steps].sort((a, b) => a.at - b.at);
  const bars = [...i.bars].filter((b) => b.ts <= i.untilMs).sort((a, b) => a.ts - b.ts);
  const sell = i.side === 'SELL';
  for (const b of bars) {
    const step = steps.filter((s) => s.at <= b.ts).pop();
    if (!step || step.trigger === null || step.limit === null) continue;
    const { trigger, limit } = step;
    if (sell ? b.low > trigger : b.high < trigger) continue;
    const px = sell ? Math.min(trigger, b.open) : Math.max(trigger, b.open);
    const within = sell ? px >= limit - EPS : px <= limit + EPS;
    if (within) {
      return { triggered: true, triggeredAt: b.ts, fill: px, fillAtLimit: limit, note: px === trigger ? 'TRADED_THROUGH' : 'OPENED_THROUGH_TRIGGER' };
    }
    const back = bars.find((x) => x.ts > b.ts && (sell ? x.high >= limit - EPS : x.low <= limit + EPS));
    if (back) return { triggered: true, triggeredAt: b.ts, fill: limit, fillAtLimit: limit, note: 'LIMIT_FILLED_ON_RECOVERY' };
    return { triggered: true, triggeredAt: b.ts, fill: i.actualExit, fillAtLimit: i.actualExit, note: 'GAPPED_BELOW_LIMIT_BACKSTOP' };
  }
  return { triggered: false, triggeredAt: null, fill: null, fillAtLimit: null, note: 'NOT_TRIGGERED' };
}
