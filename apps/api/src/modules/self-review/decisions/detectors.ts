/**
 * SYSTEM DETECTORS (plan 2026-11-04 F3, spec goal 3). Some wrong decisions are absences, not choices:
 * a live call that never reached the broker, an input the decision-maker never had, an event day nobody
 * acted on, a stated fact the stored data contradicts. Each detector is pure over pre-read rows and emits
 * `DETECTOR` rows (verdict WRONG = a hit) grouped so one systemic cause is ONE row with a count — the
 * investigator (G1) groups and costs them; nothing here acts.
 */
import { exposureOf } from '../../exit-discipline/exposure';
import type { EventContext } from '../../news-events/events/event-context';
import type { DecisionGradeDraft, DetectorKind } from './types';

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (n: number) => Math.round(n * 100) / 100;
const IDS_MAX = 50;

/** GOLDM / GOLDPETAL → GOLD, SILVERM → SILVER, CRUDEOILM → CRUDEOIL (the event calendar's families). */
export function familyOf(underlying: string | null | undefined): string {
  const u = String(underlying ?? '').trim().toUpperCase();
  for (const root of ['CRUDEOIL', 'GOLD', 'SILVER']) if (u.startsWith(root)) return root;
  return u;
}

function hit(i: {
  detector: DetectorKind;
  sessionDate: string;
  refTable?: string;
  key: string;
  userId: string | null;
  symbol?: string | null;
  underlying: string | null;
  mode?: 'live' | 'paper';
  decidedAt: Date;
  chosen: string;
  alternative: string;
  costRupees?: number | null;
  reason: string;
  facts: Rec;
}): DecisionGradeDraft {
  const cost = fin(i.costRupees) ? r2(i.costRupees) : null;
  return {
    sessionDate: i.sessionDate, decisionType: 'DETECTOR', detector: i.detector, refTable: i.refTable ?? 'detector', refId: i.key,
    userId: i.userId, symbol: i.symbol ?? null, underlying: i.underlying, mode: i.mode ?? 'live', decidedAt: i.decidedAt,
    chosen: i.chosen, alternative: i.alternative, pnlChosen: cost === null ? null : 0, pnlAlternative: cost, deltaRupees: cost,
    horizon: 'close', verdict: 'WRONG', reason: i.reason.slice(0, 300), facts: i.facts,
  };
}

// ─── LIVE_NOT_PLACED ─────────────────────────────────────────────────────────

export interface LiveCallSrc {
  id: string;
  userId: string | null;
  underlying: string | null;
  decidedAt: Date;
  /** signal_decisions.mode: shadow | live */
  mode: string;
  decision: string | null;
  judge: unknown;
  /** signal_orders.status for this decision, null = no order row. */
  orderStatus: string | null;
  /** The call's graded take ₹ per lot (ledger ENTRY_* alternative/chosen), when known: the detector's cost. */
  takePnl: number | null;
}

const FAILED_ORDER = new Set(['REJECTED', 'FAILED', 'CANCELLED']);

/** Why a live-mode call never became a broker order, or null when it did (or was never meant to). */
export function liveBlockerOf(c: LiveCallSrc): string | null {
  if (c.mode !== 'live') return null;
  const lg = obj(c.judge).liveGateBlocked;
  if (lg !== undefined && lg !== null && lg !== false) return str(lg) ?? 'gate';
  if (c.decision === 'TAKE') {
    if (c.orderStatus === null) return 'no_order';
    if (FAILED_ORDER.has(c.orderStatus)) return `order_${c.orderStatus.toLowerCase()}`;
  }
  return null;
}

/**
 * Live-eligible but never placed (spec item 2: from 2 Nov the account risk manager counted paper trades
 * against the live position limit — every live call came back liveGateBlocked='risk_manager', zero
 * orders, and nothing noticed). One row per blocker per session, with the count and the calls' known
 * take ₹ summed as the cost.
 */
export function detectLiveNotPlaced(sessionDate: string, calls: readonly LiveCallSrc[]): DecisionGradeDraft[] {
  const groups = new Map<string, LiveCallSrc[]>();
  for (const c of calls) {
    const b = liveBlockerOf(c);
    if (!b) continue;
    const g = groups.get(b) ?? [];
    g.push(c);
    groups.set(b, g);
  }
  return [...groups.entries()].map(([blocker, cs]) => {
    cs.sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
    const priced = cs.filter((c) => fin(c.takePnl));
    const cost = priced.length ? priced.reduce((s, c) => s + (c.takePnl as number), 0) : null;
    const byUnderlying: Record<string, number> = {};
    for (const c of cs) byUnderlying[c.underlying ?? '?'] = (byUnderlying[c.underlying ?? '?'] ?? 0) + 1;
    const judgeTakes = cs.filter((c) => obj(c.judge).aiDecision === 'TAKE').length;
    return hit({
      detector: 'LIVE_NOT_PLACED', sessionDate, key: `LIVE_NOT_PLACED:${sessionDate}:${blocker}`, userId: cs[0].userId, underlying: null,
      decidedAt: cs[0].decidedAt, chosen: `not placed (${blocker})`, alternative: 'live order', costRupees: cost,
      reason: `${cs.length} live call${cs.length === 1 ? '' : 's'} never reached the broker: ${blocker}${cost !== null ? `; taking them: ₹${r2(cost)} per lot over ${priced.length} graded` : ''}`,
      facts: { blocker, count: cs.length, judgeTakes, graded: priced.length, byUnderlying, decisionIds: cs.slice(0, IDS_MAX).map((c) => c.id) },
    });
  });
}

// ─── INPUT_MISSING ───────────────────────────────────────────────────────────

export interface InputPacketSrc {
  source: 'judge' | 'engine';
  underlying: string | null;
  at: Date;
  userId: string | null;
  /** judge: judge.packet.market; engine: entry_engine_decisions.inputs. */
  blocks: unknown;
}

const MISSING_STATUS = new Set(['absent', 'unavailable', 'NO_DATA', 'no_data']);
/**
 * Keys that are not inputs, or whose NO_DATA is a reading, not a gap: the engine's `news` NO_DATA means
 * "no news in the lookback" (entry-decision.ts), not a broken feed.
 */
const NOT_INPUTS: Readonly<Record<InputPacketSrc['source'], ReadonlySet<string>>> = {
  judge: new Set([]),
  engine: new Set(['news', 'guards', 'scores', 'event']),
};

/** The names of a packet's blocks that are absent / unavailable / NO_DATA. */
export function missingBlocks(source: InputPacketSrc['source'], blocks: unknown): string[] {
  const skip = NOT_INPUTS[source];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj(blocks))) {
    if (skip.has(k)) continue;
    const b = obj(v);
    const status = str(b.status);
    if ((status && MISSING_STATUS.has(status)) || b.lean === 'NO_DATA' || b.verdict === 'NO_DATA') out.push(k);
  }
  return out;
}

/** One row per (source, underlying) with how many decisions lacked which block. */
export function detectInputMissing(sessionDate: string, packets: readonly InputPacketSrc[]): DecisionGradeDraft[] {
  const groups = new Map<string, { src: InputPacketSrc; total: number; missing: number; blocks: Record<string, number>; first: Date | null }>();
  for (const p of packets) {
    const u = p.underlying ?? '?';
    const k = `${p.source}:${u}`;
    const g = groups.get(k) ?? { src: p, total: 0, missing: 0, blocks: {}, first: null };
    g.total += 1;
    const miss = missingBlocks(p.source, p.blocks);
    if (miss.length) {
      g.missing += 1;
      if (!g.first || p.at < g.first) g.first = p.at;
      for (const m of miss) g.blocks[m] = (g.blocks[m] ?? 0) + 1;
    }
    groups.set(k, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.missing > 0)
    .map(([k, g]) => {
      const list = Object.entries(g.blocks).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}/${g.total}`).join(', ');
      return hit({
        detector: 'INPUT_MISSING', sessionDate, key: `INPUT_MISSING:${sessionDate}:${k}`, userId: g.src.userId, underlying: g.src.underlying,
        decidedAt: g.first as Date, chosen: `decided without ${Object.keys(g.blocks).join(', ')}`, alternative: 'decide with the inputs',
        reason: `${g.src.source} on ${g.src.underlying ?? '?'}: ${g.missing}/${g.total} decisions missing an input (${list})`,
        facts: { source: g.src.source, count: g.missing, decisions: g.total, blocks: g.blocks },
      });
    });
}

// ─── EVENT_NO_ACTION ─────────────────────────────────────────────────────────

export interface EventDaySrc {
  underlying: string;
  /** eventContextFor(underlying, session midday). */
  context: EventContext;
  /** Signal TAKEs (judge or decision) + entry-engine ENTERs on the underlying in the session. */
  takes: number;
  /** Channel calls (signal decisions) on the underlying in the session. */
  channelCalls: number;
  /** The session's high − low over the daily ATR, when known. */
  moveAtr: number | null;
  /** When the earliest channel call came (for decidedAt), else the event day's start. */
  at: Date;
}

export const EVENT_MOVE_ATR = 2;

/**
 * An event day with no action (spec item 6: on 4 Nov, US midterm results, the calendar held the event,
 * GOLD moved ~3.5k points, and the judge SKIPped the GOLD CE call). A hit when the event context showed a
 * move-expected event for the underlying, there were 0 takes on it, and a channel call existed or the
 * underlying moved ≥ EVENT_MOVE_ATR × its daily ATR. An `absent` context is not an event day (unknown).
 */
export function detectEventNoAction(sessionDate: string, days: readonly EventDaySrc[]): DecisionGradeDraft[] {
  const out: DecisionGradeDraft[] = [];
  for (const d of days) {
    if (d.context.status !== 'present') continue;
    const events = d.context.events.filter((e) => e.expectMove);
    if (events.length === 0 || d.takes > 0) continue;
    const moved = fin(d.moveAtr) && d.moveAtr >= EVENT_MOVE_ATR;
    if (d.channelCalls === 0 && !moved) continue;
    const names = [...new Set(events.map((e) => e.name))];
    out.push(
      hit({
        detector: 'EVENT_NO_ACTION', sessionDate, key: `EVENT_NO_ACTION:${sessionDate}:${familyOf(d.underlying)}`, userId: null, underlying: d.underlying,
        decidedAt: d.at, chosen: 'no take', alternative: 'act on the expected move',
        reason: `${names.join(', ')} expected a move on ${d.underlying}; 0 takes${d.channelCalls ? ` from ${d.channelCalls} channel call${d.channelCalls === 1 ? '' : 's'}` : ''}${moved ? `; it moved ${r2(d.moveAtr as number)}× ATR` : ''}`,
        facts: { events: names, takes: d.takes, channelCalls: d.channelCalls, moveAtr: d.moveAtr },
      }),
    );
  }
  return out;
}

// ─── THESIS_CONTRADICTS_DATA ─────────────────────────────────────────────────

export interface ThesisSrc {
  id: string;
  userId: string;
  trackerId: string;
  /** The position's tradingsymbol (the thesis direction is the POSITION's side; exposureOf turns it into the underlying's). */
  symbol: string;
  direction: string;
  source: string;
  reason: string;
  levelPrice: number | null;
  invalidation: number | null;
  createdAt: Date;
  underlying: string | null;
  /** The stored underlying 1-min close at the position's entry, or null. */
  underlyingAtEntry: number | null;
}

const BREAK_CLAIM = /break|clear|reclaim/i;

/** What in the thesis the stored underlying at entry contradicts, or null. */
export function thesisContradiction(t: ThesisSrc): { what: 'INVALIDATION_BREACHED' | 'LEVEL_NOT_BROKEN'; note: string } | null {
  if (t.source !== 'INFERRED' || !fin(t.underlyingAtEntry)) return null;
  const u0 = t.underlyingAtEntry;
  const bull = exposureOf(t.symbol, t.direction === 'SHORT' ? 'SHORT' : 'LONG') === 'BULLISH';
  if (fin(t.invalidation) && (bull ? t.invalidation >= u0 : t.invalidation <= u0)) {
    return { what: 'INVALIDATION_BREACHED', note: `invalidation ${t.invalidation} was already ${bull ? 'at/above' : 'at/below'} the underlying ${u0} at entry` };
  }
  if (fin(t.levelPrice) && BREAK_CLAIM.test(t.reason) && (bull ? u0 < t.levelPrice : u0 > t.levelPrice)) {
    return { what: 'LEVEL_NOT_BROKEN', note: `claimed a break of ${t.levelPrice} but the underlying was ${u0} at entry (${bull ? 'below' : 'above'} it)` };
  }
  return null;
}

/** An inferred thesis whose own facts the stored bars contradict at entry (spec item 4, LAURUSLABS 2600 CE). */
export function detectThesisContradictions(theses: readonly ThesisSrc[]): DecisionGradeDraft[] {
  const out: DecisionGradeDraft[] = [];
  for (const t of theses) {
    const c = thesisContradiction(t);
    if (!c) continue;
    const sessionDate = new Date(t.createdAt.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    out.push(
      hit({
        detector: 'THESIS_CONTRADICTS_DATA', sessionDate, refTable: 'sentinel_theses', key: t.id, userId: t.userId, symbol: t.symbol, underlying: t.underlying,
        decidedAt: t.createdAt, chosen: `thesis ${t.direction}: ${t.reason.slice(0, 80)}`, alternative: 'a thesis consistent with the price at entry',
        reason: `inferred thesis contradicts the data: ${c.note}`,
        facts: { what: c.what, trackerId: t.trackerId, direction: t.direction, levelPrice: t.levelPrice, invalidation: t.invalidation, underlyingAtEntry: t.underlyingAtEntry, thesisReason: t.reason.slice(0, 300) },
      }),
    );
  }
  return out;
}
