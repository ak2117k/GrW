import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ClusterView, EntryType, InstrumentKind, SignalView } from '../domain/signal.types';
import { SIGNAL_ENTRY_VERDICT_TAG, istDayStart } from '../domain/execution';
import { SIGNAL_PAPER_STRATEGY, decisionTag } from '../domain/paper';

const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
type Row = Record<string, unknown>;
type LooseDelegate = { findUnique(args: unknown): Promise<Row | null> };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();

function ymd(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    // Stored as a date at midnight (UTC or IST) — read the IST calendar date.
    const d = new Date(v.getTime() + 5.5 * 3_600_000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** A TradeSignal row (stream S) → SignalView, or null when it cannot be traded as stated. */
export function normaliseSignal(r: Row | null): SignalView | null {
  if (!r) return null;
  const kind = up(r.instrumentKind) as InstrumentKind;
  const side = up(r.side);
  const entryType = up(r.entryType) as EntryType;
  const lo = num(r.entryLow);
  const hi = num(r.entryHigh) ?? lo;
  if (!['FUT', 'CE', 'PE', 'EQ'].includes(kind)) return null;
  if (side !== 'BUY' && side !== 'SELL') return null;
  if (lo === null || hi === null || lo <= 0 || hi <= 0) return null;
  const rawTargets = Array.isArray(r.targets) ? r.targets : [];
  return {
    id: String(r.id),
    channelId: str(r.channelId),
    receivedAt: r.receivedAt instanceof Date ? r.receivedAt : null,
    underlying: up(r.underlying),
    instrumentKind: kind,
    strike: num(r.strike),
    expiry: ymd(r.expiry),
    side,
    entryLow: lo,
    entryHigh: hi,
    entryType: ['ABOVE', 'BELOW', 'AT', 'RANGE'].includes(entryType) ? entryType : 'AT',
    sl: num(r.sl),
    targets: rawTargets.map((t) => num(t)).filter((t): t is number => t !== null && t > 0),
    qty: num(r.qty),
    confidence: num(r.confidence),
    rawText: String(r.rawText ?? ''),
  };
}

/** The first `byChannel` object anywhere in a self-review summary (stream S's CHANNEL_SIGNAL). */
export function findByChannel(summary: unknown, depth = 0): Record<string, unknown> | null {
  if (!summary || typeof summary !== 'object' || depth > 4) return null;
  const o = summary as Record<string, unknown>;
  if (o.byChannel && typeof o.byChannel === 'object' && !Array.isArray(o.byChannel)) return o.byChannel as Record<string, unknown>;
  for (const v of Object.values(o)) {
    const hit = findByChannel(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export interface DecisionClaim {
  signalId: string;
  evaluation: number;
  clusterId: string | null;
  channelId: string | null;
  userId: string | null;
  underlying: string | null;
  mode: string;
  agreeCount: number;
  conflict: boolean;
}

export interface DecisionFinish {
  gate: unknown;
  judge: unknown;
  plan: unknown;
  /** PAPER = every check + the judge said TAKE but the account could not fund it (paper trade instead). */
  decision: 'TAKE' | 'SKIP' | 'PAPER';
  skipReason: string | null;
}

/** What became of a PAPER decision's paper trade (merged into SignalDecision.plan.paper). */
export interface PaperRecord {
  status: 'OPEN' | 'PENDING' | 'FAILED';
  tradeId: string | null;
  at: string;
  trigger: 'funds_check' | 'broker_reject';
  reason?: string;
  entryPrice?: number | null;
}

export interface PaperTradeRow {
  id: string;
  status: string;
  side: string;
  quantity: number;
  entryPrice: number | null;
  exitPrice: number | null;
  stoploss: number | null;
  target: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  positionType: string;
  exitReasonTag: string | null;
  entryTags: string[];
  entryTime: Date | null;
  exitTime: Date | null;
  createdAt: Date;
  instrument: { token: string; exchange: string; symbol: string } | null;
}

export interface OrderClaim {
  decisionId: string;
  userId: string;
  exchange: string;
  token: string;
  tradingsymbol: string;
  qty: number;
  lots: number;
  side: string;
  productType: string;
  limitPrice: number;
  sl: number;
  targets: number[];
  orderTag: string;
}

/** Order statuses that mean "this contract may be (about to be) held". */
export const ACTIVE_ORDER_STATUSES = ['CLAIMED', 'PLACED', 'UNCERTAIN', 'FILLED', 'PARTIAL'];

@Injectable()
export class SignalTraderRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Stream S's delegates, read loosely so X compiles whether or not S's models are generated yet. */
  private delegate(name: string): LooseDelegate | null {
    const d = (this.prisma as unknown as Record<string, unknown>)[name];
    return d && typeof (d as LooseDelegate).findUnique === 'function' ? (d as LooseDelegate) : null;
  }

  async signal(signalId: string): Promise<SignalView | null> {
    const d = this.delegate('tradeSignal');
    if (!d) throw new Error('trade_signals is not available in this build (stream S model missing)');
    return normaliseSignal(await d.findUnique({ where: { id: signalId } }));
  }

  async cluster(clusterId: string | null): Promise<ClusterView | null> {
    if (!clusterId) return null;
    const d = this.delegate('signalCluster');
    if (!d) return null;
    const r = await d.findUnique({ where: { id: clusterId } });
    if (!r) return null;
    return {
      id: String(r.id),
      underlying: str(r.underlying),
      direction: str(r.direction),
      agreeCount: num(r.agreeCount) ?? 1,
      conflict: r.conflict === true,
      channelIds: Array.isArray(r.channelIds) ? r.channelIds.map(String) : [],
    };
  }

  async channelTitle(channelId: string | null): Promise<string> {
    if (!channelId) return 'unknown channel';
    const r = await this.prisma.telegramChannel.findUnique({ where: { id: channelId }, select: { title: true, username: true } }).catch(() => null);
    return r?.title || r?.username || channelId;
  }

  /** This channel's rolling stats from the newest DONE self-review run, when S publishes them. */
  async channelStats(channelId: string | null): Promise<Record<string, unknown> | null> {
    const all = await this.allChannelStats();
    if (!all || !channelId) return null;
    const v = all[channelId];
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  }

  async allChannelStats(): Promise<Record<string, unknown> | null> {
    const run = await this.prisma.selfReviewRun
      .findFirst({ where: { status: 'DONE' }, orderBy: { startedAt: 'desc' }, select: { summary: true } })
      .catch(() => null);
    return findByChannel(run?.summary ?? null);
  }

  decisionsFor(signalId: string) {
    return this.prisma.signalDecision.findMany({ where: { signalId }, orderBy: { evaluation: 'asc' } });
  }

  /** Claim-before-work: one PENDING row per (signal, evaluation). null = already claimed. */
  async claimDecision(c: DecisionClaim): Promise<string | null> {
    try {
      const row = await this.prisma.signalDecision.create({
        data: { ...c, status: 'PENDING' },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
  }

  async finishDecision(id: string, f: DecisionFinish): Promise<void> {
    await this.prisma.signalDecision.update({
      where: { id },
      data: {
        status: 'DONE',
        decidedAt: new Date(),
        gate: (f.gate ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        judge: (f.judge ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        plan: (f.plan ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        decision: f.decision,
        skipReason: f.skipReason,
      },
    });
  }

  /** TAKE decisions today (IST) in this mode — counted from the DB, never from memory. */
  tradesToday(mode: string, now: Date): Promise<number> {
    return this.prisma.signalDecision.count({ where: { mode, decision: 'TAKE', decidedAt: { gte: istDayStart(now) } } });
  }

  /** ₹ LOSS (positive; 0 when net green) of today's signal trades: realised + open, off their trackers. */
  async signalLossToday(now: Date): Promise<number> {
    const orders = await this.prisma.signalOrder.findMany({
      where: { createdAt: { gte: istDayStart(now) }, trackerId: { not: null } },
      select: { trackerId: true },
    });
    const ids = [...new Set(orders.map((o) => o.trackerId as string))];
    if (ids.length === 0) return 0;
    const trackers = await this.prisma.tradeTracker.findMany({ where: { id: { in: ids } }, select: { pnl: true } });
    const net = trackers.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return net < 0 ? -net : 0;
  }

  async clusterTaken(clusterId: string | null): Promise<boolean> {
    if (!clusterId) return false;
    const n = await this.prisma.signalDecision.count({ where: { clusterId, decision: 'TAKE' } });
    return n > 0;
  }

  /** An OPEN tracker on the contract, or one of our orders on it that may be live. */
  async holding(userId: string, token: string, now: Date): Promise<boolean> {
    const [tracker, order] = await Promise.all([
      this.prisma.tradeTracker.findFirst({ where: { userId, token, status: 'OPEN' }, select: { id: true } }),
      this.prisma.signalOrder.findFirst({
        where: { token, createdAt: { gte: istDayStart(now) }, status: { in: ['CLAIMED', 'PLACED', 'UNCERTAIN'] } },
        select: { id: true },
      }),
    ]);
    return tracker !== null || order !== null;
  }

  /** Claim-before-send: one CLAIMED order per decision. null = already claimed (never a second order). */
  async claimOrder(o: OrderClaim): Promise<string | null> {
    try {
      const row = await this.prisma.signalOrder.create({
        data: { ...o, targets: o.targets as Prisma.InputJsonValue, orderType: 'LIMIT', status: 'CLAIMED' },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
  }

  async updateOrder(id: string, data: Prisma.SignalOrderUpdateInput): Promise<void> {
    await this.prisma.signalOrder.update({ where: { id }, data });
  }

  /** Orders sent but not yet settled — resumed after a restart. */
  pendingOrders(now: Date) {
    return this.prisma.signalOrder.findMany({ where: { status: 'PLACED', createdAt: { gte: istDayStart(now) } } });
  }

  findOpenTracker(userId: string, token: string) {
    return this.prisma.tradeTracker.findFirst({ where: { userId, token, kind: 'POSITION', status: 'OPEN' } });
  }

  /**
   * The signal's plan as the sentinel's thesis. Source USER: a stated thesis outranks inference
   * permanently (SentinelThesisRepository's precedence rule), so the judge measures the trade against
   * the signal's own SL/target.
   */
  async writeThesis(t: { trackerId: string; userId: string; direction: 'LONG' | 'SHORT'; reason: string; levelPrice: number; targetPrice: number | null; invalidation: number }): Promise<void> {
    const data = { direction: t.direction, reason: t.reason, levelPrice: t.levelPrice, targetPrice: t.targetPrice, invalidation: t.invalidation, source: 'USER' };
    try {
      await this.prisma.sentinelThesis.create({ data: { trackerId: t.trackerId, userId: t.userId, ...data } });
    } catch (err) {
      if (!isUnique(err)) throw err;
      await this.prisma.sentinelThesis.updateMany({ where: { trackerId: t.trackerId, userId: t.userId }, data });
    }
  }

  /** A channel follow-up appended to the thesis reason — the sentinel reads it in its next packet. */
  async appendThesisNote(trackerId: string, userId: string, note: string): Promise<boolean> {
    const row = await this.prisma.sentinelThesis.findFirst({ where: { trackerId, userId }, select: { reason: true } });
    if (!row) return false;
    const reason = `${row.reason}\n${note}`.slice(-2000);
    await this.prisma.sentinelThesis.updateMany({ where: { trackerId, userId }, data: { reason } });
    return true;
  }

  /**
   * The signal SL as an explicit exit trigger: a HOLD verdict carrying `exitTrigger`, which the
   * sentinel-executor's TriggerWatchService arms (its only supported entry point). Tagged
   * SIGNAL_ENTRY so the live cycle does not count it as a judgement (recentForTracker liveOnly).
   */
  async recordSlVerdict(v: {
    userId: string;
    trackerId: string;
    symbol: string;
    reason: string;
    invalidationPoint: string;
    exitTrigger: Record<string, unknown>;
    packet: Record<string, unknown>;
  }): Promise<string> {
    const row = await this.prisma.sentinelVerdict.create({
      data: {
        userId: v.userId,
        trackerId: v.trackerId,
        symbol: v.symbol,
        verdict: 'HOLD',
        confidence: 'high',
        thesisStatus: 'INTACT',
        recoveryAvailable: false,
        reason: v.reason,
        evidence: [] as Prisma.InputJsonValue,
        invalidationPoint: v.invalidationPoint,
        reviewInSec: 0,
        packet: v.packet as Prisma.InputJsonValue,
        promptVersion: 'signal-trader-v1',
        triggeredBy: [SIGNAL_ENTRY_VERDICT_TAG] as Prisma.InputJsonValue,
        netPnl: 0,
        greenFloor: null,
        exitTrigger: v.exitTrigger as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** The SignalOrder (and its tracker) for a signal, if it was traded. */
  async orderForSignal(signalId: string) {
    const decisions = await this.prisma.signalDecision.findMany({ where: { signalId, decision: 'TAKE' }, select: { id: true } });
    if (decisions.length === 0) return null;
    return this.prisma.signalOrder.findFirst({ where: { decisionId: { in: decisions.map((d) => d.id) } }, orderBy: { createdAt: 'desc' } });
  }

  // ---- PAPER (no funds) ----

  /**
   * The owner's `paperOnNoFunds` setting, stored on the app's settings row (user_settings — the
   * same row SettingsService.getSettings serves). Default ON when the row is absent or unreadable.
   */
  async paperOnNoFunds(): Promise<boolean> {
    try {
      const row = await this.prisma.userSettings.findFirst({ select: { signalPaperOnNoFunds: true } });
      return row ? row.signalPaperOnNoFunds !== false : true;
    } catch {
      return true;
    }
  }

  /** Persist the toggle on the existing settings row (never creates a second row). false = no row yet. */
  async setPaperOnNoFunds(enabled: boolean): Promise<boolean> {
    const row = await this.prisma.userSettings.findFirst({ select: { id: true } });
    if (!row) return false;
    await this.prisma.userSettings.update({ where: { id: row.id }, data: { signalPaperOnNoFunds: enabled } });
    return true;
  }

  /**
   * Broker rejected a TAKE's entry for funds → turn the decision into PAPER, at most once: the
   * conditional update (decision still 'TAKE') is the claim. The rejection is appended to the gate.
   */
  async claimPaperFallback(decisionId: string, check: Record<string, unknown>): Promise<boolean> {
    const row = await this.prisma.signalDecision.findUnique({ where: { id: decisionId }, select: { decision: true, gate: true } });
    if (!row || row.decision !== 'TAKE') return false;
    const gate = [...(Array.isArray(row.gate) ? (row.gate as unknown[]) : []), check];
    const r = await this.prisma.signalDecision.updateMany({
      where: { id: decisionId, decision: 'TAKE' },
      data: { decision: 'PAPER', skipReason: 'insufficient_funds', gate: gate as Prisma.InputJsonValue },
    });
    return r.count === 1;
  }

  /** Merge the paper outcome into the decision's plan JSON (`plan.paper`). */
  async recordPaper(decisionId: string, paper: PaperRecord): Promise<void> {
    const row = await this.prisma.signalDecision.findUnique({ where: { id: decisionId }, select: { plan: true } });
    const plan = row?.plan && typeof row.plan === 'object' && !Array.isArray(row.plan) ? (row.plan as Record<string, unknown>) : {};
    await this.prisma.signalDecision.update({ where: { id: decisionId }, data: { plan: { ...plan, paper } as unknown as Prisma.InputJsonValue } });
  }

  private readonly paperSelect = {
    id: true, status: true, side: true, quantity: true, entryPrice: true, exitPrice: true, stoploss: true, target: true,
    pnl: true, pnlPercent: true, positionType: true, exitReasonTag: true, entryTags: true, entryTime: true, exitTime: true, createdAt: true,
    instrument: { select: { token: true, exchange: true, symbol: true } },
  } as const;

  /** The paper trade already opened for a decision (idempotency backstop). */
  paperTradeFor(decisionId: string): Promise<PaperTradeRow | null> {
    return this.prisma.trade.findFirst({
      where: { strategy: SIGNAL_PAPER_STRATEGY, isPaperTrade: true, entryTags: { has: decisionTag(decisionId) } },
      select: this.paperSelect,
    }) as Promise<PaperTradeRow | null>;
  }

  paperTradesFor(decisionIds: string[]): Promise<PaperTradeRow[]> {
    if (decisionIds.length === 0) return Promise.resolve([]);
    return this.prisma.trade.findMany({
      where: { strategy: SIGNAL_PAPER_STRATEGY, isPaperTrade: true, entryTags: { hasSome: decisionIds.map(decisionTag) } },
      select: this.paperSelect,
      take: 500,
    }) as Promise<PaperTradeRow[]>;
  }

  /** Open tagged paper trades — the paper SL/target watch. */
  openPaperTrades(): Promise<PaperTradeRow[]> {
    return this.prisma.trade.findMany({
      where: { strategy: SIGNAL_PAPER_STRATEGY, isPaperTrade: true, status: 'OPEN' },
      select: this.paperSelect,
      take: 200,
    }) as Promise<PaperTradeRow[]>;
  }

  paperDecisionsSince(since: Date) {
    return this.prisma.signalDecision.findMany({ where: { decision: 'PAPER', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  // ---- read model for the page ----

  decisionsSince(since: Date) {
    return this.prisma.signalDecision.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 300 });
  }

  ordersSince(since: Date) {
    return this.prisma.signalOrder.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async trackersByIds(ids: string[]): Promise<Array<{ id: string; status: string; lastLtp: number | null; pnl: number | null; exitPrice: number | null }>> {
    if (ids.length === 0) return [];
    return this.prisma.tradeTracker.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, lastLtp: true, pnl: true, exitPrice: true } });
  }

  async channelTitles(ids: string[]): Promise<Array<{ id: string; title: string }>> {
    if (ids.length === 0) return [];
    return this.prisma.telegramChannel.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }).catch(() => []);
  }
}
