import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { paperTrackerId, PAPER_TRACKER_PREFIX } from '../../trade-sentinel/paper/paper-tracker';
import {
  BUSY_PROPOSAL_MS,
  CHANNEL_VIEW_CAP,
  cut,
  firstNumber,
  istMidnight,
  istYmdOf,
  MEMORY_DECISIONS_CAP,
  PROPOSAL_QUOTAS,
  TEXT_CAP,
  underlyingFromSymbol,
} from '../domain/packet-blocks';
import { positionOpenPnl } from '../domain/pnl-path';
import { DESK_MANAGER_TAG, type ChannelView, type Proposal, type Scorecard, type TradeOrigin } from '../domain/desk.types';
import { isDrillReason } from '../../exit-authority/domain/drill';
import { originsOf } from './desk-day.repository';
import { resultPostReason } from '../../signal-intake/domain/result-post';
import { normalise } from '../../signal-intake/domain/text';
import { buildVocabulary } from '../../signal-intake/domain/vocabulary';
import { parseSignalIntakeConfig } from '../../signal-intake/signal-intake.config';
import { istMinuteOf, venueSession } from '../../exit-discipline/session-bars';

/** Engine rows read per packet before the (underlying, side) merge: 2 h of a ~1-min engine over a few underlyings. */
const ENGINE_ROWS_READ = 400;

/** Position-screenshot views in channelViews: at most 3 (1 per channel), description cut to 200 chars; rows read per packet. */
const POSITION_SHOT_CAP = 3;
const POSITION_SHOT_TEXT_CAP = 200;
const POSITION_SHOT_ROWS_READ = 60;

/** A broker positions / P&L screen. */
const SHOT_SCREEN = /\b(POSITIONS?|P&L|P\/L|PNL|MTM|PORTFOLIO)\b/;
/** …of a derivative (a US-stock holding or a cash portfolio is not a desk view). */
const SHOT_DERIVATIVE = /\b(CE|PE|CALLS?|PUTS?|FUT|FUTURES?|OPTIONS?)\b/;
/**
 * The description says the position is live. LTP / CMP / market price are NOT a sign: every positions screen, open or
 * closed, shows one (review of 8144d8db).
 */
const SHOT_LIVE = /\b(OPEN(?! INTEREST)|ACTIVE|RUNNING|HOLDING|UNREALI[SZ]ED)\b/;
/** …or the post says its trade is live ("trade is active", "position running", "trail SL", "still holding") — not "market open" / "hold tight". */
const POST_LIVE = /\b(TRADES?|POSITIONS?|CALLS?|SHORT|LONG|BUY|SELL)\b[^.!?\n]{0,30}?\b(IS |ARE |STILL )?(ACTIVE|RUNNING|LIVE)\b|\bTRAIL(ING)?\b|\bSTILL HOLDING\b|\bHOLDING (IT|THE|OUR|MY)\b/;
/** A finished trade on the screen (a "Realised P&L" header alone is not one: open screens print it too). */
const SHOT_CLOSED = /\b(CLOSED|EXITED|SQUARED[ -]?OFF|SOLD|QTY 0|BOOKED)\b|\bSELL(ING)?( PRICE)?( AT)? ₹?\d/;
/** Not a trading screen at all. */
const SHOT_NOT_TRADE = /\b(PAYMENT|PAID|BANK|UPI|CHAT|WHATSAPP|TESTIMONIAL)\b/;
/** Brags, client P&L and promotions — the vision model labels them ("a P&L brag, not a trade call"). */
const SHOT_BRAG = /\bBRAG|\bNOT A (TRADE|FRESH) CALL|\bCLIENTS?\b|ACCOUNT HANDLING|PROFIT SHARING|50-50/;
/** Index vocabulary only: the result-post matcher reads outcome phrases, not names. */
const SHOT_VOCAB = buildVocabulary([]);
/** Commodity screens are MCX; every other derivative screen is NSE / BSE (same session). */
const SHOT_MCX = /\b(MCX|CRUDE|CRUDEOIL|GOLD|GOLDM|SILVER|SILVERM|NATURAL ?GAS|NATGAS|COPPER|ZINC|ALUMINI?UM|LEAD|NICKEL)\b/;

/**
 * True when a channel image's vision description is a broker positions screen of a derivative position that is
 * live (the description says open / active / running / holding, or the post says its trade is active / trailing),
 * and neither the post nor the description reports a completed outcome (signal-intake result-post: "target
 * achieved", "booked", "x to y done"), a closed or sold position, a payment chat, a brag, client P&L or a promotion.
 */
export function isPositionScreenshot(postText: string, description: string): boolean {
  const d = ` ${String(description ?? '').normalize('NFKC').toUpperCase()} `;
  const t = ` ${String(postText ?? '').normalize('NFKC').toUpperCase()} `;
  if (!SHOT_SCREEN.test(d) || !SHOT_DERIVATIVE.test(d)) return false;
  if (SHOT_CLOSED.test(d) || SHOT_NOT_TRADE.test(d) || SHOT_BRAG.test(d) || SHOT_BRAG.test(t)) return false;
  if (resultPostReason(normalise(postText ?? '', SHOT_VOCAB)) || resultPostReason(normalise(description ?? '', SHOT_VOCAB))) return false;
  return SHOT_LIVE.test(d) || POST_LIVE.test(t);
}

/** True when the screenshot was posted inside its venue's session (MCX for commodity screens, else NSE / BSE). */
export function shotInSession(description: string, postedAt: Date): boolean {
  const venue = SHOT_MCX.test(String(description ?? '').normalize('NFKC').toUpperCase()) ? 'MCX' : 'NSE';
  const s = venueSession(venue);
  if (!s) return false;
  const min = istMinuteOf(postedAt.getTime());
  return min >= s.fromMin && min < s.toMin;
}

/** SIGNAL_VISION_TRUSTED_CHANNELS (signal-intake config, same default): lower-case channel-title substrings. */
function trustedChannels(): string[] {
  return parseSignalIntakeConfig(process.env).visionTrustedChannels;
}

/** One open position as the packet needs it, before the HOLD list, sentinel and manager levels are joined. */
export interface OpenPositionRow {
  trackerId: string;
  symbol: string;
  exchange: string;
  underlying: string | null;
  qty: number;
  entry: number;
  ltp: number | null;
  pnl: number | null;
  entryAt: Date;
  origin: TradeOrigin;
  paper: boolean;
  /** The desk decision that opened it (signal_orders.decision_id for a live manager order; desk-decision:<id> tag on paper). */
  openDecisionId: string | null;
}

export interface ClosedPositionRow {
  trackerId: string;
  symbol: string;
  underlying: string | null;
  exitAt: Date;
  pnl: number;
  paper: boolean;
}

export interface SentinelRow {
  trackerId: string;
  verdict: string;
  thesisStatus: string | null;
  reason: string;
  invalidation: number | null;
  at: Date;
}

export interface DecisionLevelRow {
  id: string;
  trackerId: string | null;
  action: string;
  payload: unknown;
  createdAt: Date;
}

export interface TodayDecisionRow {
  createdAt: Date;
  action: string;
  underlying: string | null;
  status: string;
  result: unknown;
}

/** The grade JSON Task 6 writes on desk_manager_decisions. */
interface GradeJson {
  kind?: string;
  pnl?: number | null;
  netPnl?: number | null;
}

const DECISION_TAG_PREFIX = 'desk-decision:';
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Every database read behind the desk packet (plan Task 3). Reads only; one query per concern, all capped.
 * Live positions are the owner's open trade_trackers; the manager's shadow trades are paper `trades` tagged
 * `desk-manager` and keyed `paper:<tradeId>` like the paper sentinel keys them.
 */
@Injectable()
export class DeskStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The desk's open positions: kind POSITION only (F&O / MCX / intraday), the same rule as the desk guard.
   * Delivery HOLDING rows are not desk trades — they must never fill the packet's instrument slots or be a valid
   * EXIT / BOOK / TIGHTEN target (2026-11-27: 26 holdings sorted first and crowded out the live NIFTY position).
   * Origin: the desk guard's own classifier (desk-day.repository originsOf), so the packet and the guard agree.
   */
  async openPositions(userId: string, now: Date = new Date()): Promise<OpenPositionRow[]> {
    const [trackers, paper] = await Promise.all([
      this.prisma.tradeTracker.findMany({
        where: { userId, status: 'OPEN', kind: 'POSITION', NOT: { id: { startsWith: PAPER_TRACKER_PREFIX } } },
        select: { id: true, symbol: true, exchange: true, token: true, qty: true, entryPrice: true, lastLtp: true, pnl: true, entryTime: true },
        orderBy: { entryTime: 'asc' },
        take: 50,
      }),
      this.prisma.trade.findMany({
        where: { userId, status: 'OPEN', isPaperTrade: true, entryTags: { has: DESK_MANAGER_TAG } },
        select: { id: true, quantity: true, entryPrice: true, pnl: true, entryTime: true, createdAt: true, entryTags: true, instrument: { select: { symbol: true, exchange: true, name: true } } },
        take: 20,
      }),
    ]);
    const orders = await originsOf(this.prisma, userId, trackers.map((t) => ({ id: t.id, symbol: t.symbol, exchange: t.exchange, token: t.token ?? null, entryTime: t.entryTime })), now);
    const live: OpenPositionRow[] = trackers.map((t) => {
      const o = orders.get(t.id);
      const origin: TradeOrigin = o ? o.origin : 'manual';
      return {
        trackerId: t.id,
        symbol: t.symbol,
        exchange: t.exchange,
        underlying: underlyingFromSymbol(t.symbol),
        qty: t.qty,
        entry: t.entryPrice,
        ltp: num(t.lastLtp),
        // The one open-P&L reading the guard uses too (pnl-path positionOpenPnl); a missing value stays null here ("no data").
        pnl: num(t.pnl) === null ? null : positionOpenPnl(t.pnl),
        entryAt: t.entryTime,
        origin,
        paper: false,
        openDecisionId: origin === 'manager' ? (o?.decisionId ?? null) : null,
      };
    });
    const shadow: OpenPositionRow[] = paper.map((p) => {
      const tag = p.entryTags.find((x) => x.startsWith(DECISION_TAG_PREFIX));
      return {
        trackerId: paperTrackerId(p.id),
        symbol: p.instrument?.symbol ?? '',
        exchange: p.instrument?.exchange ?? '',
        underlying: p.instrument?.name ? p.instrument.name.trim().toUpperCase() : underlyingFromSymbol(p.instrument?.symbol),
        qty: p.quantity,
        entry: num(p.entryPrice) ?? 0,
        ltp: null,
        pnl: num(p.pnl),
        entryAt: p.entryTime ?? p.createdAt,
        origin: 'manager',
        paper: true,
        openDecisionId: tag ? tag.slice(DECISION_TAG_PREFIX.length) : null,
      };
    });
    return [...live, ...shadow];
  }

  /** Live trackers and manager paper trades closed at or after `since`. */
  async closedSince(userId: string, since: Date): Promise<ClosedPositionRow[]> {
    const [trackers, paper] = await Promise.all([
      this.prisma.tradeTracker.findMany({
        where: { userId, status: 'CLOSED', exitTime: { gte: since }, NOT: { id: { startsWith: PAPER_TRACKER_PREFIX } } },
        select: { id: true, symbol: true, exitTime: true, pnl: true },
        orderBy: { exitTime: 'desc' },
        take: 30,
      }),
      this.prisma.trade.findMany({
        where: { userId, isPaperTrade: true, entryTags: { has: DESK_MANAGER_TAG }, exitTime: { gte: since } },
        select: { id: true, exitTime: true, pnl: true, instrument: { select: { symbol: true, name: true } } },
        take: 20,
      }),
    ]);
    return [
      ...trackers.map((t) => ({ trackerId: t.id, symbol: t.symbol, underlying: underlyingFromSymbol(t.symbol), exitAt: t.exitTime as Date, pnl: num(t.pnl) ?? 0, paper: false })),
      ...paper.map((p) => ({
        trackerId: paperTrackerId(p.id),
        symbol: p.instrument?.symbol ?? '',
        underlying: p.instrument?.name ? p.instrument.name.trim().toUpperCase() : underlyingFromSymbol(p.instrument?.symbol),
        exitAt: p.exitTime as Date,
        pnl: num(p.pnl) ?? 0,
        paper: true,
      })),
    ].filter((r) => r.exitAt instanceof Date);
  }

  /**
   * The latest sentinel view per tracker (sentinel_verdicts for live, paper_sentinel_looks for paper), optionally
   * only those at or before `before[trackerId]` (the last look before an exit).
   */
  async latestSentinel(trackerIds: string[], before?: Map<string, Date>): Promise<Map<string, SentinelRow>> {
    const out = new Map<string, SentinelRow>();
    const live = trackerIds.filter((id) => !id.startsWith(PAPER_TRACKER_PREFIX));
    const paper = trackerIds.filter((id) => id.startsWith(PAPER_TRACKER_PREFIX));
    const since = new Date(Date.now() - 3 * 24 * 3600_000);
    const select = { trackerId: true, verdict: true, thesisStatus: true, reason: true, invalidationPoint: true, createdAt: true } as const;
    const [a, b] = await Promise.all([
      live.length ? this.prisma.sentinelVerdict.findMany({ where: { trackerId: { in: live }, createdAt: { gte: since } }, select, orderBy: { createdAt: 'desc' }, take: 400 }) : [],
      paper.length ? this.prisma.paperSentinelLook.findMany({ where: { trackerId: { in: paper }, createdAt: { gte: since } }, select, orderBy: { createdAt: 'desc' }, take: 400 }) : [],
    ]);
    for (const r of [...a, ...b]) {
      // A drill look (final review item 2) is a rehearsal, not the agent's view of the position: never shown to the desk.
      if (isDrillReason(r.reason)) continue;
      const cap = before?.get(r.trackerId);
      if (cap && r.createdAt.getTime() > cap.getTime()) continue;
      const prev = out.get(r.trackerId);
      if (prev && prev.at.getTime() >= r.createdAt.getTime()) continue;
      out.set(r.trackerId, {
        trackerId: r.trackerId,
        verdict: r.verdict,
        thesisStatus: r.thesisStatus ?? null,
        reason: cut(r.reason, TEXT_CAP),
        invalidation: firstNumber(r.invalidationPoint),
        at: r.createdAt,
      });
    }
    return out;
  }

  /** The manager's own OPEN / TIGHTEN decisions behind these positions (by tracker id or the opening decision id). */
  async managerLevelRows(trackerIds: string[], openDecisionIds: string[]): Promise<DecisionLevelRow[]> {
    const or: Prisma.DeskManagerDecisionWhereInput[] = [];
    if (trackerIds.length) or.push({ trackerId: { in: trackerIds } });
    if (openDecisionIds.length) or.push({ id: { in: openDecisionIds } });
    if (or.length === 0) return [];
    return this.prisma.deskManagerDecision.findMany({
      where: { OR: or, action: { in: ['OPEN', 'TIGHTEN'] }, status: { in: ['DONE', 'RECORDED', 'PENDING'] } },
      select: { id: true, trackerId: true, action: true, payload: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  }

  /**
   * Readings, AI setups, the owner's signal decisions and entry-engine decisions at or after `since`. Each source
   * reads more rows than its packet quota (PROPOSAL_QUOTAS): bare UPDATE readings are dropped and engine rows are
   * merged per (underlying, side) afterwards (quotaProposals), so the quota is filled from what is left.
   */
  async proposalsSince(userId: string, since: Date): Promise<Proposal[]> {
    const [readings, setups, decisions, engine] = await Promise.all([
      this.prisma.messageReading.findMany({
        where: { postedAt: { gte: since }, kind: { in: ['CALL', 'UPDATE'] } },
        select: { messageId: true, postedAt: true, kind: true, summary: true, call: true, claims: true, missedByRules: true },
        orderBy: { postedAt: 'desc' },
        take: PROPOSAL_QUOTAS.reading * 4,
      }),
      this.prisma.aiSetup.findMany({
        where: { createdAt: { gte: since } },
        select: { id: true, createdAt: true, underlying: true, decision: true, reason: true, status: true, setup: true },
        orderBy: { createdAt: 'desc' },
        take: PROPOSAL_QUOTAS.setup,
      }),
      this.prisma.signalDecision.findMany({
        where: { userId, decidedAt: { gte: since } },
        select: { id: true, decidedAt: true, underlying: true, decision: true, skipReason: true, mode: true, status: true, judge: true, plan: true },
        orderBy: { decidedAt: 'desc' },
        take: PROPOSAL_QUOTAS.signal_decision,
      }),
      this.prisma.entryEngineDecision.findMany({
        where: { at: { gte: since } },
        select: { id: true, at: true, underlying: true, action: true, reasons: true, mode: true, tradeId: true },
        orderBy: { at: 'desc' },
        take: ENGINE_ROWS_READ,
      }),
    ]);
    const out: Proposal[] = [];
    for (const r of readings) {
      const call = (r.call ?? null) as Record<string, unknown> | null;
      const claims = Array.isArray(r.claims) ? (r.claims as Array<Record<string, unknown>>) : [];
      out.push({
        ref: `reading:${r.messageId}`,
        kind: 'reading',
        at: r.postedAt.toISOString(),
        underlying: typeof call?.underlying === 'string' ? call.underlying.toUpperCase() : null,
        text: cut(r.summary),
        detail: {
          kind: r.kind,
          call,
          missedByRules: r.missedByRules,
          claims: claims.slice(0, 6).map((c) => ({ text: cut(c.text, 160), subject: typeof c.subject === 'string' ? c.subject : null, verdict: c.verdict ?? null, reasonCode: c.reasonCode ?? null })),
        },
      });
    }
    for (const s of setups) {
      out.push({
        ref: `setup:${s.id}`,
        kind: 'setup',
        at: s.createdAt.toISOString(),
        underlying: s.underlying,
        text: cut(s.reason),
        detail: { decision: s.decision, status: s.status, setup: s.setup ?? null },
      });
    }
    for (const d of decisions) {
      const judge = (d.judge ?? null) as Record<string, unknown> | null;
      out.push({
        ref: `signal:${d.id}`,
        kind: 'signal_decision',
        at: d.decidedAt.toISOString(),
        underlying: d.underlying ?? null,
        text: cut(judge?.summary ?? judge?.reason ?? ''),
        detail: { decision: d.decision ?? null, skipReason: cut(d.skipReason, 200) || null, mode: d.mode, status: d.status, plan: d.plan ?? null },
      });
    }
    for (const e of engine) {
      const reasons = Array.isArray(e.reasons) ? (e.reasons as unknown[]).map(String) : [];
      out.push({
        ref: `engine:${e.id}`,
        kind: 'engine',
        at: e.at.toISOString(),
        underlying: e.underlying,
        text: cut(reasons.join('; ')),
        detail: { action: e.action, mode: e.mode, tradeId: e.tradeId ?? null },
      });
    }
    return out;
  }

  /**
   * Channel market views, newest first, at most CHANNEL_VIEW_CAP: INFO readings posted at or after `since`, plus up to
   * POSITION_SHOT_CAP images from SIGNAL_VISION_TRUSTED_CHANNELS whose vision description is a live positions screen
   * (kind 'position-screenshot'; positionShotsSince). Screenshots only fill slots INFO leaves free, are not read at all
   * when INFO fills the cap, and a failed screenshot read never costs the INFO views. Each carries `messageId` so the
   * service drops one that is also a proposal (and strips the id before the packet).
   */
  async channelViewsSince(since: Date): Promise<ChannelView[]> {
    const rows = await this.prisma.messageReading.findMany({
      where: { postedAt: { gte: since }, kind: 'INFO' },
      select: { messageId: true, channelId: true, postedAt: true, summary: true, claims: true },
      orderBy: { postedAt: 'desc' },
      take: CHANNEL_VIEW_CAP,
    });
    const room = Math.max(0, Math.min(POSITION_SHOT_CAP, CHANNEL_VIEW_CAP - rows.length));
    const shots = room > 0 ? (await this.positionShotsSince(since).catch(() => [])).slice(0, room) : [];
    const views: ChannelView[] = [];
    if (rows.length) {
      const ids = [...new Set(rows.map((r) => r.channelId))];
      const channels = await this.prisma.telegramChannel.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, username: true } });
      const name = new Map(channels.map((c) => [c.id, c.title || c.username || c.id] as const));
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      for (const r of rows) {
        const first = (Array.isArray(r.claims) ? (r.claims as Array<Record<string, unknown>>) : []).find((c) => c && typeof c === 'object') ?? null;
        views.push({ channel: name.get(r.channelId) ?? r.channelId, at: r.postedAt.toISOString(), summary: cut(r.summary), subject: str(first?.subject), bias: str(first?.bias) });
      }
    }
    for (const s of shots) {
      views.push({ channel: s.channel, at: s.postedAt.toISOString(), summary: cut(s.description, POSITION_SHOT_TEXT_CAP), subject: null, bias: null, kind: 'position-screenshot', messageId: s.messageId });
    }
    return views.sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * Images of trusted channels (SIGNAL_VISION_TRUSTED_CHANNELS) since `since` that the reader classed NOISE / RECAP /
   * UPDATE, with a vision description, that isPositionScreenshot accepts and that were posted inside their venue's
   * session; newest first, one per channel. One query, rows without a description filtered in SQL.
   */
  private async positionShotsSince(since: Date): Promise<Array<{ messageId: string; channel: string; postedAt: Date; description: string }>> {
    const trusted = trustedChannels();
    if (trusted.length === 0) return [];
    const patterns = trusted.map((s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const rows = await this.prisma.$queryRaw<Array<{ messageId: string; channelId: string; title: string | null; postedAt: Date; rawText: string | null; description: string | null }>>`
      SELECT r.message_id AS "messageId", r.channel_id AS "channelId", ch.title, r.posted_at AS "postedAt", m."rawText", c.llm_result->>'description' AS description
      FROM message_readings r
      JOIN signal_message_classes c ON c.message_id = r.message_id
      JOIN telegram_messages m ON m.id = r.message_id
      JOIN telegram_channels ch ON ch.id = r.channel_id
      WHERE r.posted_at >= ${since} AND r.kind IN ('NOISE', 'RECAP', 'UPDATE')
        AND COALESCE(c.llm_result->>'description', '') <> ''
        AND ch.title ILIKE ANY (${patterns}::text[])
      ORDER BY r.posted_at DESC
      LIMIT ${POSITION_SHOT_ROWS_READ}`;
    const seen = new Set<string>();
    const out: Array<{ messageId: string; channel: string; postedAt: Date; description: string }> = [];
    for (const r of rows) {
      const title = String(r.title ?? '').toLowerCase();
      if (!trusted.some((s) => title.includes(s))) continue; // the SQL pattern, checked again the way signal-vision does
      const d = String(r.description ?? '').trim();
      const at = r.postedAt instanceof Date ? r.postedAt : new Date(r.postedAt);
      if (!d || seen.has(r.channelId) || !shotInSession(d, at) || !isPositionScreenshot(r.rawText ?? '', d)) continue;
      seen.add(r.channelId);
      out.push({ messageId: r.messageId, channel: r.title || r.channelId, postedAt: at, description: d });
    }
    return out;
  }

  /** Claims of every reading of the IST session day (the health block counts NOT_CHECKABLE ones). */
  async claimsOfDay(now: Date): Promise<unknown[]> {
    const rows = await this.prisma.messageReading.findMany({ where: { sessionDate: istYmdOf(now) }, select: { claims: true }, take: 2000 });
    return rows.map((r) => r.claims);
  }

  async decisionsToday(userId: string, now: Date): Promise<TodayDecisionRow[]> {
    return this.prisma.deskManagerDecision.findMany({
      where: { userId, createdAt: { gte: istMidnight(now) } },
      select: { createdAt: true, action: true, underlying: true, status: true, result: true },
      orderBy: { createdAt: 'desc' },
      take: MEMORY_DECISIONS_CAP,
    });
  }

  /** Active self-review lessons that name the desk manager. */
  async deskLessons(): Promise<string[]> {
    const rows = await this.prisma.agentLesson.findMany({
      where: { status: 'ACTIVE', text: { contains: 'desk-manager', mode: 'insensitive' } },
      select: { text: true },
      orderBy: { lastSeen: 'desc' },
      take: 10,
    });
    return rows.map((r) => cut(r.text, 400));
  }

  /** Busy = an open live / manager-paper position, or a proposal younger than 30 min (Task 4's 3-min cadence). */
  async busy(userId: string, now: Date): Promise<boolean> {
    const since = new Date(now.getTime() - BUSY_PROPOSAL_MS);
    const counts = await Promise.all([
      this.prisma.tradeTracker.count({ where: { userId, status: 'OPEN', NOT: { id: { startsWith: PAPER_TRACKER_PREFIX } } } }),
      this.prisma.trade.count({ where: { userId, status: 'OPEN', isPaperTrade: true, entryTags: { has: DESK_MANAGER_TAG } } }),
      this.prisma.messageReading.count({ where: { postedAt: { gte: since }, kind: { in: ['CALL', 'UPDATE'] } } }),
      this.prisma.aiSetup.count({ where: { createdAt: { gte: since } } }),
      this.prisma.signalDecision.count({ where: { userId, decidedAt: { gte: since } } }),
      this.prisma.entryEngineDecision.count({ where: { at: { gte: since }, action: { not: 'NO_TRADE' } } }),
    ]);
    return counts.some((c) => c > 0);
  }

  /**
   * The manager's graded record over its last `sessions` IST days that have a grade (Task 6 writes
   * desk_manager_decisions.grade). A traded OPEN is an OPEN grade with a pnl: a never-filled OPEN (pnl null)
   * is not counted. Null when nothing is graded yet.
   */
  async scorecard(userId: string, sessions: number, now: Date): Promise<Scorecard | null> {
    const rows = await this.prisma.deskManagerDecision.findMany({
      where: { userId, createdAt: { gte: new Date(now.getTime() - 45 * 24 * 3600_000), lt: now }, NOT: { grade: { equals: Prisma.AnyNull } } },
      select: { createdAt: true, underlying: true, grade: true },
      orderBy: { createdAt: 'desc' },
      take: 3000,
    });
    const graded = rows.filter((r) => r.grade && typeof r.grade === 'object');
    if (graded.length === 0) return null;
    const days: string[] = [];
    for (const r of graded) {
      const d = istYmdOf(r.createdAt);
      if (!days.includes(d)) days.push(d);
    }
    const keep = new Set(days.slice(0, Math.max(1, sessions)));
    const inWindow = graded.filter((r) => keep.has(istYmdOf(r.createdAt)));
    const opens = inWindow
      .map((r) => ({ r, g: r.grade as GradeJson }))
      .filter(({ g }) => g.kind === 'OPEN' && typeof g.pnl === 'number' && Number.isFinite(g.pnl))
      .map(({ r, g }) => ({ day: istYmdOf(r.createdAt), underlying: r.underlying ?? '?', net: num(g.netPnl) ?? (g.pnl as number) }));
    const netPnl = Math.round(opens.reduce((s, o) => s + o.net, 0) * 100) / 100;
    const wins = opens.filter((o) => o.net > 0).length;
    const label = (o: { day: string; underlying: string; net: number }) => `${o.day} ${o.underlying} ${o.net >= 0 ? '+' : ''}${Math.round(o.net)}`;
    const sorted = [...opens].sort((a, b) => b.net - a.net);
    return {
      sessions: keep.size,
      opens: opens.length,
      netPnl,
      winRate: opens.length > 0 ? Math.round((wins / opens.length) * 1000) / 1000 : null,
      best: sorted.filter((o) => o.net > 0).slice(0, 3).map(label),
      worst: [...sorted].reverse().filter((o) => o.net < 0).slice(0, 3).map(label),
    };
  }
}
