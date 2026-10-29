import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { channelSentiment, type ChannelInfoAccuracy } from '../../signal-intake/domain/sentiment';
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

/** Option / future venues of the OI check's master reads (instruments.segment holds these too). */
const OI_DERIVATIVE_EXCHANGES = ['NFO', 'BFO', 'MCX'];

/** IST calendar day `ymd` as an instant range: covers the master's UTC- and IST-midnight expiry encodings. */
function istDayRange(ymdIst: string): { gte: Date; lt: Date } {
  const gte = new Date(`${ymdIst}T00:00:00+05:30`);
  return { gte, lt: new Date(gte.getTime() + 86_400_000) };
}

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
    horizon: r.horizon === 'BTST' || r.horizon === 'POSITIONAL' ? r.horizon : 'INTRADAY',
  };
}

/** The first `byChannel` object anywhere in a self-review summary (stream S's CHANNEL_SIGNAL). */
/** The judge's channel-views window. */
export const CHANNEL_VIEWS_WINDOW_MS = 24 * 3_600_000;

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
  trigger: 'funds_check' | 'broker_reject' | 'paper_mode';
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
  instrument: { token: string; exchange: string; symbol: string; expiry?: Date | null } | null;
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

  /**
   * Telegram channels' market views (INFO items, signal-intake) on `underlying` over the last 24 h,
   * weighted by each channel's CHANNEL_INFO accuracy from the latest self-review. Read-only judge context.
   */
  async channelViews(underlying: string, now: Date): Promise<Record<string, unknown>> {
    const since = new Date(now.getTime() - CHANNEL_VIEWS_WINDOW_MS);
    const rows = await this.prisma.channelInfo.findMany({
      where: { postedAt: { gte: since, lte: now } },
      select: { channelId: true, postedAt: true, items: true },
      orderBy: { postedAt: 'desc' },
      take: 500,
    });
    if (rows.length === 0) return { status: 'unavailable', reason: 'no Telegram INFO posts in the last 24 h' };
    const accuracy = (await this.allChannelStats().catch(() => null)) as Record<string, ChannelInfoAccuracy> | null;
    const all = channelSentiment(rows, accuracy);
    return {
      status: 'present',
      source: 'telegram INFO items (signal-intake channel_infos), last 24 h, weighted by channel INFO accuracy',
      underlying: all.find((x) => x.underlying === underlying) ?? null,
      others: all.filter((x) => x.underlying !== underlying).slice(0, 5),
    };
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

  // ---- pending triggers (BUY ABOVE / SELL BELOW not reached yet) ----

  /**
   * Arm a trigger: decision 'PENDING', status stays 'PENDING' (not DONE) so a re-emitted signal.ready
   * never evaluates it twice; plan.trigger carries the restart-safe watch state. Conditional on the
   * row still being an unfinished claim.
   */
  async armTrigger(id: string, f: { gate: unknown; judge: unknown; plan: unknown }): Promise<boolean> {
    const r = await this.prisma.signalDecision.updateMany({
      where: { id, status: 'PENDING', decision: null },
      data: {
        decision: 'PENDING',
        gate: (f.gate ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        judge: (f.judge ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        plan: (f.plan ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
    return r.count === 1;
  }

  /** Persist the latest watch state (last LTP / check time) of an armed trigger. */
  async touchTrigger(id: string, plan: unknown): Promise<void> {
    await this.prisma.signalDecision.updateMany({
      where: { id, status: 'PENDING', decision: 'PENDING' },
      data: { plan: plan as Prisma.InputJsonValue },
    });
  }

  /** Every armed trigger (resumed after a restart). */
  pendingTriggers() {
    return this.prisma.signalDecision.findMany({ where: { status: 'PENDING', decision: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 50 });
  }

  pendingTriggerCount(): Promise<number> {
    return this.prisma.signalDecision.count({ where: { status: 'PENDING', decision: 'PENDING' } });
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
    instrument: { select: { token: true, exchange: true, symbol: true, expiry: true } },
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

  /** The judge record of a decision (learning mode reads its aiDecision when the trade closes). */
  async decisionJudge(decisionId: string): Promise<unknown> {
    return (await this.prisma.signalDecision.findUnique({ where: { id: decisionId }, select: { judge: true } }))?.judge ?? null;
  }

  async recordAiCheck(decisionId: string, check: unknown): Promise<void> {
    await this.prisma.signalDecision.update({ where: { id: decisionId }, data: { aiCheck: check as Prisma.InputJsonValue } });
  }

  /** Stored AI checks since `since` (the learning-mode scorecard). */
  async aiChecksSince(since: Date): Promise<unknown[]> {
    const rows = await this.prisma.signalDecision.findMany({ where: { createdAt: { gte: since }, aiCheck: { not: Prisma.DbNull } }, select: { aiCheck: true }, take: 1000 });
    return rows.map((r) => r.aiCheck);
  }

  // ---- OI check at the paper open (domain/oi-check): database reads only, never the broker ----

  async recordOiCheck(decisionId: string, check: unknown): Promise<void> {
    await this.prisma.signalDecision.update({ where: { id: decisionId }, data: { oiCheck: check as Prisma.InputJsonValue } });
  }

  /** IST expiry dates (YYYY-MM-DD, ascending) of `name`'s active options on or after `from`. */
  async optionExpiries(name: string, from: Date): Promise<string[]> {
    const rows = await this.prisma.instrument.findMany({
      where: { name: name.toUpperCase(), exchange: { in: OI_DERIVATIVE_EXCHANGES }, optionType: { in: ['CE', 'PE'] }, isActive: true, expiry: { gte: from } },
      select: { expiry: true },
      distinct: ['expiry'],
      orderBy: { expiry: 'asc' },
    });
    return [...new Set(rows.map((r) => ymd(r.expiry)).filter((x): x is string => !!x))];
  }

  /** `name`'s option contracts expiring on IST date `expiry` (either master midnight convention). */
  async optionContracts(name: string, expiry: string): Promise<Array<{ instrumentId: string; strike: number; optionType: 'CE' | 'PE' }>> {
    const rows = await this.prisma.instrument.findMany({
      where: { name: name.toUpperCase(), exchange: { in: OI_DERIVATIVE_EXCHANGES }, optionType: { in: ['CE', 'PE'] }, expiry: istDayRange(expiry) },
      select: { id: true, strike: true, optionType: true },
      take: 2000,
    });
    return rows
      .filter((r) => r.strike !== null && (r.optionType === 'CE' || r.optionType === 'PE'))
      .map((r) => ({ instrumentId: r.id, strike: Number(r.strike), optionType: r.optionType as 'CE' | 'PE' }));
  }

  /** `name`'s nearest active future expiring on or after `from` (the current month). */
  async nearestFuture(name: string, from: Date): Promise<{ instrumentId: string; symbol: string; exchange: string; token: string } | null> {
    const r = await this.prisma.instrument.findFirst({
      where: { name: name.toUpperCase(), exchange: { in: OI_DERIVATIVE_EXCHANGES }, optionType: null, symbol: { endsWith: 'FUT' }, isActive: true, expiry: { gte: from } },
      orderBy: { expiry: 'asc' },
      select: { id: true, symbol: true, exchange: true, token: true },
    });
    return r ? { instrumentId: r.id, symbol: r.symbol, exchange: r.exchange, token: r.token } : null;
  }

  /** The NSE cash line of a stock (`X-EQ`, else `X`). */
  async cashRef(name: string): Promise<{ exchange: string; token: string; symbol: string } | null> {
    const n = name.toUpperCase();
    for (const symbol of [`${n}-EQ`, n]) {
      const r = await this.prisma.instrument.findFirst({ where: { symbol, exchange: 'NSE' }, select: { exchange: true, token: true, symbol: true } });
      if (r) return r;
    }
    return null;
  }

  /** oi_snapshots rows of `ids` inside any of the windows (oi as a number). */
  async oiRows(ids: string[], windows: Array<[Date, Date]>): Promise<Array<{ instrumentId: string; oi: number; at: Date }>> {
    if (ids.length === 0 || windows.length === 0) return [];
    const rows = await this.prisma.oISnapshot.findMany({
      where: { instrumentId: { in: ids }, OR: windows.map(([gte, lte]) => ({ timestamp: { gte, lte } })) },
      select: { instrumentId: true, oi: true, timestamp: true },
      take: 20_000,
    });
    return rows.map((r) => ({ instrumentId: r.instrumentId, oi: Number(r.oi), at: r.timestamp }));
  }

  /**
   * One instrument's oi_snapshots LTPs (the price from the same quote that read the OI; column added by
   * migration 20261029190000_oi_snapshot_ltp). Raw SQL so this module does not depend on that column at
   * compile time; [] when the column is absent or empty (the caller falls back to candles_1m).
   */
  async oiLtps(instrumentId: string, from: Date, to: Date): Promise<Array<{ at: Date; close: number }>> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ timestamp: Date; ltp: number }>>`
        SELECT "timestamp", "ltp" FROM "oi_snapshots"
        WHERE "instrumentId" = ${instrumentId} AND "ltp" IS NOT NULL AND "timestamp" >= ${from} AND "timestamp" <= ${to}
        ORDER BY "timestamp"`;
      return rows.map((r) => ({ at: r.timestamp, close: Number(r.ltp) })).filter((r) => r.close > 0);
    } catch {
      return [];
    }
  }

  /** The newest chain snapshot's spot for `underlying` captured at or after `since`; null when none. */
  async chainSpotSince(underlying: string, since: Date): Promise<number | null> {
    const r = await this.prisma.optionChainSnapshot.findFirst({
      where: { underlying: underlying.toUpperCase(), capturedAt: { gte: since } },
      orderBy: { capturedAt: 'desc' },
      select: { spotPrice: true },
    });
    const v = r ? Number(r.spotPrice) : null;
    return v !== null && v > 0 ? v : null;
  }

  /** The hub's tick-built 1m closes (candles_1m) of one instrument in [from, to]. */
  async minuteCloses(exchange: string, token: string, from: Date, to: Date): Promise<Array<{ at: Date; close: number }>> {
    const rows = await this.prisma.$queryRaw<Array<{ ts: Date; close: number }>>`
      SELECT ts, close FROM "candles_1m"
      WHERE exchange = ${exchange} AND token = ${token}
        AND ts >= ${from.toISOString()}::timestamptz AND ts <= ${to.toISOString()}::timestamptz
      ORDER BY ts`;
    return rows.map((r) => ({ at: r.ts, close: Number(r.close) }));
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

  // ---- paper exit shadow (docs/superpowers/specs/2026-10-28-paper-exit-shadow-design.md) ----

  /** The decision's plan (the reference stop the STOP shadow reads). */
  async decisionPlan(decisionId: string): Promise<Record<string, unknown> | null> {
    const r = await this.prisma.signalDecision.findUnique({ where: { id: decisionId }, select: { plan: true } });
    return r?.plan && typeof r.plan === 'object' && !Array.isArray(r.plan) ? (r.plan as Record<string, unknown>) : null;
  }

  shadowRows(tradeIds: string[]): Promise<ShadowRow[]> {
    if (tradeIds.length === 0) return Promise.resolve([]);
    return this.prisma.paperExitShadow.findMany({
      where: { tradeId: { in: tradeIds } },
      select: { tradeId: true, rule: true, wouldExitAt: true, price: true, detail: true },
    }) as Promise<ShadowRow[]>;
  }

  /** The running state (rule TRACK), replaced on every change. */
  async saveShadowTrack(tradeId: string, decisionId: string | null, detail: unknown): Promise<void> {
    const d = detail as Prisma.InputJsonValue;
    await this.prisma.paperExitShadow.upsert({
      where: { tradeId_rule: { tradeId, rule: 'TRACK' } },
      create: { tradeId, decisionId, rule: 'TRACK', detail: d },
      update: { detail: d },
    });
  }

  /**
   * Target trailing: the paper trade's moved SL and its next target — or null, a one-target call now on
   * its noise trail. Only an OPEN tagged paper trade is touched.
   */
  async setPaperTrail(tradeId: string, stoploss: number | null, target: number | null): Promise<void> {
    await this.prisma.trade.updateMany({
      where: { id: tradeId, strategy: SIGNAL_PAPER_STRATEGY, isPaperTrade: true, status: 'OPEN' },
      data: { stoploss, target },
    });
  }

  /** One open paper trade by id (the AI close re-reads it: it may have closed meanwhile). */
  openPaperTrade(tradeId: string): Promise<PaperTradeRow | null> {
    return this.prisma.trade.findFirst({
      where: { id: tradeId, strategy: SIGNAL_PAPER_STRATEGY, isPaperTrade: true, status: 'OPEN' },
      select: this.paperSelect,
    }) as Promise<PaperTradeRow | null>;
  }

  /**
   * AI close, night review: the HELD row follows the closed trade on its own rules (detail = the
   * follow state) until they would have closed it. Open while `wouldExitAt` is null.
   */
  async startHeldFollow(tradeId: string, decisionId: string | null, aiPnl: number, detail: unknown): Promise<void> {
    await this.prisma.paperExitShadow.upsert({
      where: { tradeId_rule: { tradeId, rule: 'HELD' } },
      create: { tradeId, decisionId, rule: 'HELD', heldPnl: aiPnl, detail: detail as Prisma.InputJsonValue },
      update: {},
    });
  }

  followingHeld(): Promise<Array<{ id: string; tradeId: string; heldPnl: number | null; detail: unknown }>> {
    return this.prisma.paperExitShadow.findMany({
      where: { rule: 'HELD', wouldExitAt: null },
      select: { id: true, tradeId: true, heldPnl: true, detail: true },
      take: 100,
    });
  }

  async updateHeld(
    id: string,
    data: { detail: unknown; done?: { at: Date; price: number; reason: string; rulePnl: number; saved: number } },
  ): Promise<void> {
    await this.prisma.paperExitShadow.update({
      where: { id },
      data: {
        detail: data.detail as Prisma.InputJsonValue,
        ...(data.done
          ? { wouldExitAt: data.done.at, price: data.done.price, reason: data.done.reason, rulePnl: data.done.rulePnl, saved: data.done.saved, settledAt: data.done.at }
          : {}),
      },
    });
  }

  /** The first time a rule would have exited — written once, never moved. */
  async saveShadowHit(tradeId: string, decisionId: string | null, rule: string, hit: { at: string; price: number; reason: string }, detail: unknown): Promise<void> {
    await this.prisma.paperExitShadow.upsert({
      where: { tradeId_rule: { tradeId, rule } },
      create: { tradeId, decisionId, rule, wouldExitAt: new Date(hit.at), price: hit.price, reason: hit.reason, detail: detail as Prisma.InputJsonValue },
      update: {},
    });
  }

  /** At the paper close: held vs each rule's gross ₹. Returns the settled hit rows. */
  async settleShadows(tradeId: string, s: { heldPnl: number; rulePnl: (price: number) => number; at: Date }): Promise<Array<{ rule: string; at: string; rulePnl: number }>> {
    const rows = await this.prisma.paperExitShadow.findMany({ where: { tradeId, settledAt: null }, select: { id: true, rule: true, wouldExitAt: true, price: true } });
    const out: Array<{ rule: string; at: string; rulePnl: number }> = [];
    for (const r of rows) {
      if (r.rule === 'TRACK') {
        await this.prisma.paperExitShadow.update({ where: { id: r.id }, data: { heldPnl: s.heldPnl, settledAt: s.at } });
        continue;
      }
      if (r.price === null || !r.wouldExitAt) continue;
      const rulePnl = s.rulePnl(r.price);
      await this.prisma.paperExitShadow.update({
        where: { id: r.id },
        data: { heldPnl: s.heldPnl, rulePnl, saved: Math.round((rulePnl - s.heldPnl) * 100) / 100, settledAt: s.at },
      });
      out.push({ rule: r.rule, at: r.wouldExitAt.toISOString(), rulePnl });
    }
    return out;
  }
}

export interface ShadowRow {
  tradeId: string;
  rule: string;
  wouldExitAt: Date | null;
  price: number | null;
  detail: unknown;
}
