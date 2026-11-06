import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../common/utils/boot-jobs';
import type { ConvertPositionRequest, ConvertPositionResult } from '../../common/interfaces/broker-adapter.interface';
import type { SessionClock } from '../market-hub/session-clock';
import { answeredPositions } from '../trade-tracker/services/trade-tracker.service';
import { OwnerBrokerSessionProvider } from '../sentinel-executor/services/owner-broker-session.provider';
import { AiExitExecutionRepository } from '../sentinel-executor/repositories/ai-exit-execution.repository';
import { parseAutoExitConfig } from '../sentinel-executor/domain/auto-exit.config';
import { istDayStartUtc } from '../sentinel-executor/domain/exit-order';
import { SentinelVerdictRepository } from '../trade-sentinel/repositories/sentinel-verdict.repository';
import { paperTrackerId } from '../trade-sentinel/paper/paper-tracker';
import { isIntradayProduct } from '../trade-sentinel/services/judge-gate';
import { paperCloseEffect } from '../paper-sentinel/paper-exit';
import { CloseProductBook } from './close-product-book';
import { CARRY_EXCHANGES, describeCarryConfig, isLiveCarryUser, parseCarryConfig, withCarryTuning, type CarryConfig, type CarryTuningReader } from './domain/carry-config';
import { SESSION_TUNING } from '../self-review/tuning/tunables';
import { afterConversion, decideClose, type CloseAction, type CloseOutcome } from './domain/carry-decision';
import { openRowFor, verifyConversion, type BookRow } from './domain/verify-conversion';
import { IntradayCarryRepository } from './repositories/intraday-carry.repository';

/** DI token: the hub's SessionClock (MCX late close honoured), built in the module. */
export const CARRY_SESSION_CLOCK = Symbol('CARRY_SESSION_CLOCK');

/** The pass cadence. Inside a window every pass re-reads the book (verification needs a FRESH book). */
export const CARRY_PASS_MS = 15_000;
/** Product reads start this many minutes before a position's window, once a minute, so the cycle's look knows the product. */
const READ_AHEAD_MIN = 20;
const READ_AHEAD_EVERY_MS = 60_000;
/** promptVersion of the EXIT_NOW verdict this engine records for the exit executor (no prompt wrote it). */
export const CARRY_EXIT_STAMP = 'rule:intraday-carry/1';
export const CARRY_EXIT_REASON_PREFIX = 'INTRADAY_CARRY EXIT (close decision, code rule):';
export const CARRY_FIRE = 'intraday-carry';

/** The position book row's descriptive fields Angel's convert API documents beside the core ones. */
const CONVERT_EXTRA_KEYS = [
  'symbolname', 'instrumenttype', 'priceden', 'pricenum', 'genden', 'gennum', 'precision', 'multiplier',
  'boardlotsize', 'buyqty', 'sellqty', 'buyamount', 'sellamount',
] as const;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const up = (x: unknown) => String(x ?? '').trim().toUpperCase();
const num = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const istYmd = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

interface Window {
  /** Minutes to the broker's MIS square-off (whole minutes, from the session clock). */
  minutesLeft: number;
  /** When the CARRY/EXIT window opened (minute boundary, as square-off-look.ts counts it). */
  openedAt: Date;
}

/** One position's in-session progress. Durable part lives on the decision row; this is the per-process cursor. */
interface Progress {
  id: string;
  decision: CloseAction;
  symbol: string;
  qty: number;
  attempts: number;
  lastAttemptAt: number;
  done: boolean;
}

type Tracker = { id: string; userId: string; symbol: string; exchange: string; token: string; qty: number };
type CloseVerdict = { id: string; verdict: string; reason: string; packet: unknown };

/**
 * INTRADAY CARRY — the close decision for every intraday (MIS) F&O position (spec 2026-11-04 §5.3).
 *
 * Every CARRY_PASS_MS (inert unless INTRADAY_CARRY=live and BOOT_JOBS on):
 *  1. PRODUCT READS. For each user with an open NFO/BFO/MCX position nearing its broker MIS
 *     square-off, read the position book over the user's WARM feed session (never a login — a second
 *     login on the owner's client code kills the feed) and cache each tracker's product in the
 *     CloseProductBook, which the sentinel cycle reads: a carry-forward position then has no close
 *     look (§5.1), an INTRADAY one of an INTRADAY_CARRY_USERS user gets the CARRY/EXIT look.
 *  2. LIVE DECISIONS (INTRADAY_CARRY_USERS only, D13). Inside the window: carry-decision.ts on the
 *     judge's close look. CARRY ⇒ Angel convertPosition, then verified on a FRESH book each pass —
 *     retried once (RETRY_SEC apart); not CONVERTED by SAFETY_MIN before the square-off ⇒ EXIT (D4).
 *     EXIT ⇒ an EXIT_NOW verdict (stamp rule:intraday-carry/1) the existing exit executor acts on,
 *     under every one of its guards (allow-list, hold, daily cap, gate). One row per decision.
 *  3. PAPER (D12). The same decision on open INTRADAY paper trades from their paper looks; CARRY
 *     sets the paper trade's product to CARRYFORWARD, EXIT leaves it to the paper square-off.
 *
 * Never throws out of a pass; every failure is logged with the position.
 */
@Injectable()
export class IntradayCarryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('IntradayCarry');
  private readonly cfg: CarryConfig = parseCarryConfig(process.env);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly progress = new Map<string, Progress>();
  /** userId → epoch ms of the last answered position-book read. */
  private readonly readAt = new Map<string, number>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: IntradayCarryRepository,
    private readonly book: CloseProductBook,
    private readonly sessions: OwnerBrokerSessionProvider,
    private readonly verdicts: SentinelVerdictRepository,
    private readonly execRepo: AiExitExecutionRepository,
    @Inject(CARRY_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'minutesToClose'>,
    /** Self-review session-open tunables (carry.decideByMin); absent ⇒ INTRADAY_CARRY_DECIDE_BY_MIN. */
    @Optional() @Inject(SESSION_TUNING) private readonly sessionTuning?: CarryTuningReader,
  ) {}

  onModuleInit(): void {
    for (const p of this.cfg.problems) this.logger.warn(`[carry] ${p}`);
    if (this.cfg.mode === 'off') {
      this.logger.log('[carry] INTRADAY_CARRY=off — no close decisions (the broker squares off MIS as before)');
      return;
    }
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    this.logger.warn(`[carry] ENABLED ${describeCarryConfig(this.cfg)}`);
    if (this.cfg.users.length === 0) this.logger.warn('[carry] INTRADAY_CARRY_USERS is empty — no LIVE position is converted or exited (paper only)');
    this.timer = setInterval(() => void this.runOnce(), CARRY_PASS_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Single-flight; never throws. */
  async runOnce(now: Date = new Date()): Promise<void> {
    if (this.cfg.mode === 'off' || this.running) return;
    this.running = true;
    try {
      this.book.markAlive(now.getTime());
      await this.livePass(now).catch((err) => this.logger.error(`[carry] live pass failed: ${errText(err)}`));
      await this.paperPass(now).catch((err) => this.logger.error(`[carry] paper pass failed: ${errText(err)}`));
    } finally {
      this.running = false;
    }
  }

  /** The window for a position on `exchange` now, or null when the exchange is shut / not covered. */
  windowFor(exchange: string, now: Date): Window | null {
    const ex = up(exchange);
    const lead = this.cfg.leadMin[ex];
    if (!CARRY_EXCHANGES.includes(ex) || typeof lead !== 'number') return null;
    const mtc = this.clock.minutesToClose(ex, now);
    if (mtc === null || mtc === undefined) return null;
    const minutesLeft = mtc - lead;
    const deadlineMs = Math.floor(now.getTime() / 60_000) * 60_000 + minutesLeft * 60_000;
    return { minutesLeft, openedAt: new Date(deadlineMs - this.cfg.windowMin * 60_000) };
  }

  // ─── live ─────────────────────────────────────────────────────────────────────────────────────

  private async livePass(now: Date): Promise<void> {
    const trackers = (await this.prisma.tradeTracker.findMany({
      where: { status: 'OPEN', kind: 'POSITION', exchange: { in: [...CARRY_EXCHANGES] } },
      select: { id: true, userId: true, symbol: true, exchange: true, token: true, qty: true },
    })) as Tracker[];
    const byUser = new Map<string, Tracker[]>();
    for (const t of trackers) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);

    for (const [userId, list] of byUser) {
      const near = list
        .map((t) => ({ t, w: this.windowFor(t.exchange, now) }))
        .filter((x): x is { t: Tracker; w: Window } => x.w !== null && x.w.minutesLeft <= this.cfg.windowMin + READ_AHEAD_MIN && x.w.minutesLeft > -1);
      if (near.length === 0) continue;
      const inWindow = near.filter((x) => x.w.minutesLeft <= this.cfg.windowMin);
      if (inWindow.length === 0 && now.getTime() - (this.readAt.get(userId) ?? Number.NEGATIVE_INFINITY) < READ_AHEAD_EVERY_MS) continue;

      const rows = await this.readBook(userId);
      const allowed = isLiveCarryUser(this.cfg, userId);
      if (rows === null) {
        if (allowed && inWindow.length > 0) {
          this.warnOnce(`book:${userId}:${istYmd(now)}`, `[carry] position book NOT answered for ${userId} inside the close window — no decision possible this pass; the broker squares off MIS if this persists`);
        }
        continue;
      }
      this.readAt.set(userId, now.getTime());
      for (const { t } of near) {
        const row = openRowFor(rows as Record<string, unknown>[], t.exchange, t.token);
        if (row && row.producttype) this.book.set(t.id, String(row.producttype));
      }
      if (!allowed) continue;
      for (const { t, w } of inWindow) {
        try {
          await this.decideLive(t, rows as Record<string, unknown>[], w, now);
        } catch (err) {
          this.logger.error(`[carry] ${t.symbol} (tracker ${t.id}): decision step failed: ${errText(err)}`);
        }
      }
    }
  }

  /** A fresh positions array over the user's WARM session, or null (not answered / no warm session). Never throws. */
  private async readBook(userId: string): Promise<unknown[] | null> {
    try {
      return await this.sessions.withOwnerSession(userId, async (s) => answeredPositions(await s.getPositionsEnvelope()), { allowEphemeralLogin: false });
    } catch {
      return null;
    }
  }

  private async decideLive(t: Tracker, rows: Record<string, unknown>[], w: Window, now: Date): Promise<void> {
    const day = istYmd(now);
    const key = `${t.id}|${day}`;
    let p = this.progress.get(key);
    if (!p) {
      const existing = await this.repo.forDay(t.id, day);
      if (existing) {
        p = {
          id: existing.id, decision: existing.decision as CloseAction, symbol: existing.symbol, qty: existing.qty,
          attempts: existing.conversionAttempts, lastAttemptAt: existing.updatedAt instanceof Date ? existing.updatedAt.getTime() : 0,
          done: existing.decision !== 'CARRY' || ['CONVERTED', 'POSITION_GONE', 'EXIT_FALLBACK', 'NOT_CONVERTED_CAP'].includes(String(existing.conversionStatus)),
        };
        this.progress.set(key, p);
      }
    }
    const row = openRowFor(rows, t.exchange, t.token);
    if (!p) {
      if (!row) return;
      const first = await this.firstDecision(t, row, w, now, day);
      if (first) this.progress.set(key, first);
      return;
    }
    if (p.done || p.decision !== 'CARRY') return;
    await this.followConversion(t, p, rows, row, w, now);
  }

  /** The decision itself (once per position per session). Null = nothing decided yet (WAIT) or not ours. */
  private async firstDecision(t: Tracker, row: Record<string, unknown>, w: Window, now: Date, day: string): Promise<Progress | null> {
    const productType = up(row.producttype) || null;
    if (!isIntradayProduct(productType)) return null;
    const symbol = String(row.tradingsymbol ?? t.symbol);
    const netQty = num(row.netqty) ?? t.qty;
    const auto = parseAutoExitConfig(process.env);
    const held = (auto.hold ?? []).some((h) => h === up(symbol) || h === up(t.symbol) || h === up(t.id));
    const [expiry, verdict, capExhausted] = await Promise.all([
      this.expiryToday(t.exchange, t.token, symbol, now),
      this.closeVerdict(t.id, w.openedAt, 'live'),
      this.capExhausted(t.userId, now),
    ]);
    const o = decideClose(
      { mode: 'live', userAllowed: true, productType, expiryToday: expiry.today, held, minutesLeft: w.minutesLeft, verdict, capExhausted },
      withCarryTuning(this.cfg, this.sessionTuning),
    );
    if (o.action === 'WAIT') return null;
    if (o.action === 'NONE' && !o.reason.startsWith('OWNER_HOLD')) return null;
    const executorOn = auto.enabled && auto.userIds.includes(t.userId);
    const facts = {
      minutesLeft: w.minutesLeft, windowOpenedAt: w.openedAt.toISOString(), productType, netQty, ltp: num(row.ltp),
      expiry: expiry.expiry, expiryToday: expiry.today, held, capExhausted, executorOn, executorMode: auto.mode,
      dailyCap: auto.dailyCap, verdict: verdict ? { id: verdict.id, verdict: verdict.verdict } : null,
      leadMin: this.cfg.leadMin[up(t.exchange)], windowMin: this.cfg.windowMin,
    };
    const created = await this.repo.create({
      userId: t.userId, mode: 'live', trackerId: t.id, tradeId: null, istDay: day, symbol, exchange: up(t.exchange), token: t.token,
      productType, positionSide: netQty >= 0 ? 'LONG' : 'SHORT', qty: Math.abs(netQty), decision: o.action, reason: o.reason,
      verdictId: verdict?.id ?? null, facts: facts as Prisma.InputJsonValue, decisionPrice: num(row.ltp),
      conversionStatus: o.action === 'CARRY' ? 'PENDING' : null, decidedAt: now,
    });
    if (!created) return null; // decided elsewhere (restart race): the next pass loads the row
    const p: Progress = { id: created.id, decision: o.action, symbol, qty: Math.abs(netQty), attempts: 0, lastAttemptAt: 0, done: o.action !== 'CARRY' };
    this.logger.warn(`[carry] ${symbol} (tracker ${t.id}, ${t.userId}): ${o.action} — ${o.reason}`);
    if (o.action === 'CARRY') await this.convert(t, p, row, now);
    else if (o.action === 'EXIT') await this.recordExit(t, p, verdict, o, now, executorOn);
    else if (o.action === 'CAP_BLOCKED_BROKER_SQUARE_OFF') this.logger.error(`[carry] CAP_BLOCKED_BROKER_SQUARE_OFF ${symbol} (tracker ${t.id}): the daily AI exit cap is used up — Angel's MIS square-off closes it`);
    else this.logger.warn(`[carry] ${symbol} (tracker ${t.id}) is on AI_AUTO_EXIT_HOLD — no conversion, no exit; the broker squares it off if it is MIS`);
    return p;
  }

  /** After a CARRY: verify on the fresh book read this pass; retry once; exit before the square-off if unconfirmed. */
  private async followConversion(t: Tracker, p: Progress, rows: Record<string, unknown>[], row: Record<string, unknown> | null, w: Window, now: Date): Promise<void> {
    const readMs = this.readAt.get(t.userId) ?? 0;
    // The book must have been read AFTER the last attempt, or it cannot show the attempt's result.
    if (readMs <= p.lastAttemptAt) return;
    const check = verifyConversion(rows as BookRow[], p.symbol, p.qty);
    const capExhausted = check === 'NOT_CONVERTED' && w.minutesLeft <= this.cfg.safetyMin ? await this.capExhausted(t.userId, now) : false;
    const next = afterConversion({ check, minutesLeft: w.minutesLeft, attempts: p.attempts, mode: 'live', capExhausted }, this.cfg);
    switch (next) {
      case 'DONE':
        p.done = true;
        this.book.set(t.id, 'CARRYFORWARD');
        await this.repo.update(p.id, { conversionStatus: 'CONVERTED', executedAt: now });
        this.logger.warn(`[carry] ${p.symbol} (tracker ${t.id}): CONVERTED to carry-forward — confirmed on the position book`);
        return;
      case 'GONE':
        p.done = true;
        await this.repo.update(p.id, { conversionStatus: 'POSITION_GONE' });
        this.logger.warn(`[carry] ${p.symbol} (tracker ${t.id}): position no longer in the book — nothing to carry`);
        return;
      case 'RETRY':
        if (now.getTime() - p.lastAttemptAt >= this.cfg.retrySec * 1000 && row) await this.convert(t, p, row, now);
        return;
      case 'RECHECK':
        return;
      case 'EXIT': {
        p.done = true;
        const reason = `CARRY not confirmed by the position book ${Math.max(0, w.minutesLeft)} min before the square-off (after ${p.attempts} attempt(s)) — exiting at market (D4)`;
        await this.repo.update(p.id, { conversionStatus: 'EXIT_FALLBACK', reason });
        const auto = parseAutoExitConfig(process.env);
        await this.recordExit(t, p, await this.closeVerdict(t.id, w.openedAt, 'live'), { action: 'EXIT', reason }, now, auto.enabled && auto.userIds.includes(t.userId));
        return;
      }
      case 'CAP_BLOCKED_BROKER_SQUARE_OFF':
        p.done = true;
        await this.repo.update(p.id, { decision: 'CAP_BLOCKED_BROKER_SQUARE_OFF', conversionStatus: 'NOT_CONVERTED_CAP' });
        this.logger.error(`[carry] CAP_BLOCKED_BROKER_SQUARE_OFF ${p.symbol} (tracker ${t.id}): conversion unconfirmed and the daily AI exit cap is used up — Angel's MIS square-off closes it`);
        return;
    }
  }

  private async convert(t: Tracker, p: Progress, row: Record<string, unknown>, now: Date): Promise<void> {
    p.attempts += 1;
    p.lastAttemptAt = now.getTime();
    const req = this.convertRequest(row);
    let res: ConvertPositionResult;
    if (typeof req === 'string') {
      res = { accepted: false, message: req };
    } else {
      try {
        res = await this.sessions.withOwnerSession(
          t.userId,
          (s) => (s.convertPosition ? s.convertPosition(req) : Promise.resolve({ accepted: false, message: 'session has no convertPosition' })),
          { allowEphemeralLogin: false },
        );
      } catch (err) {
        res = { accepted: false, message: errText(err).slice(0, 200) };
      }
    }
    await this.repo.update(p.id, {
      conversionAttempts: p.attempts,
      conversionStatus: 'PENDING',
      brokerMessage: `attempt ${p.attempts} at ${now.toISOString()}: ${res.accepted ? 'accepted' : 'NOT accepted'} — ${res.message}`.slice(0, 500),
    });
    this.logger.warn(`[carry] ${p.symbol} (tracker ${t.id}): convert attempt ${p.attempts} — broker ${res.accepted ? 'accepted' : 'did NOT accept'} (${res.message}); verifying on the position book`);
  }

  /** The conversion request from the broker's own row, or why it cannot be built. Quantity in the exchange's order unit. */
  private convertRequest(row: Record<string, unknown>): ConvertPositionRequest | string {
    const netQty = num(row.netqty);
    if (netQty === null || netQty === 0 || !Number.isInteger(netQty)) return `BAD_QTY ${String(row.netqty)}`;
    const exchange = up(row.exchange);
    const unit = parseAutoExitConfig(process.env).qtyUnits[exchange];
    let quantity = Math.abs(netQty);
    // Same unit rule as the exit executor (plan ruling R16): an unconfigured exchange is never sent.
    if (unit === undefined) return `QTY_UNIT_UNCONFIGURED:${exchange} (AI_AUTO_EXIT_QTY_UNITS)`;
    if (unit === 'lots') {
      const lot = num(row.lotsize);
      if (lot === null || lot <= 1 || quantity % lot !== 0) return `LOT_SIZE_UNCONFIRMED (${String(row.lotsize)})`;
      quantity = quantity / lot;
    }
    const extra: Record<string, string> = {};
    for (const k of CONVERT_EXTRA_KEYS) if (row[k] !== undefined && row[k] !== null) extra[k] = String(row[k]);
    return {
      exchange,
      symboltoken: String(row.symboltoken ?? ''),
      tradingsymbol: String(row.tradingsymbol ?? ''),
      transactiontype: netQty > 0 ? 'BUY' : 'SELL',
      quantity,
      oldproducttype: 'INTRADAY',
      newproducttype: 'CARRYFORWARD',
      extra,
    };
  }

  /**
   * EXIT ⇒ an EXIT_NOW verdict row the exit executor's 5-second poller acts on, through every one of
   * its guards and the exit gate (HARD_SESSION_CLOSE is the clause that justifies it — see the
   * report on GATE_CLOSE_MIN). The packet is the close look's own (so the gate reads real facts);
   * without one, the latest live packet; without any, a marker (the gate then fails open — an exit).
   */
  private async recordExit(t: Tracker, p: Progress, verdict: CloseVerdict | null, o: CloseOutcome, now: Date, executorOn: boolean): Promise<void> {
    if (!executorOn) {
      this.logger.error(`[carry] EXIT ${p.symbol} (tracker ${t.id}): the AI auto-exit is off for this user (AI_AUTO_EXIT_ENABLED / AI_AUTO_EXIT_USER_IDS) — Angel's MIS square-off closes it`);
    }
    const packet = (verdict?.packet ?? (await this.latestPacket(t.id, now)) ?? { intradayCarry: { decisionId: p.id } }) as Prisma.InputJsonValue;
    const money = (packet as { money?: { netPnl?: unknown } } | null)?.money;
    try {
      const v = await this.verdicts.record({
        userId: t.userId, trackerId: t.id, symbol: t.symbol, verdict: 'EXIT_NOW', confidence: 'high', thesisStatus: 'WEAKENING',
        recoveryAvailable: true, reason: `${CARRY_EXIT_REASON_PREFIX} ${o.reason}`.slice(0, 500), evidence: ['squareOffDecision'],
        invalidationPoint: null, reviewInSec: 60, packet, promptVersion: CARRY_EXIT_STAMP, triggeredBy: [CARRY_FIRE],
        netPnl: num(money?.netPnl) ?? 0, greenFloor: null,
      });
      await this.repo.update(p.id, { exitVerdictId: v.id, executedAt: now });
      this.logger.warn(`[carry] EXIT_NOW recorded for ${p.symbol} (tracker ${t.id}, verdict ${v.id}) — the exit executor sends it`);
    } catch (err) {
      this.logger.error(`[carry] could not record the EXIT_NOW for ${p.symbol} (tracker ${t.id}): ${errText(err)} — the broker squares it off`);
    }
  }

  // ─── paper ────────────────────────────────────────────────────────────────────────────────────

  private async paperPass(now: Date): Promise<void> {
    const trades = (await this.prisma.trade.findMany({
      where: { isPaperTrade: true, status: 'OPEN', positionType: 'INTRADAY', instrument: { exchange: { in: [...CARRY_EXCHANGES] } } },
      select: { id: true, userId: true, side: true, quantity: true, positionType: true, instrument: { select: { symbol: true, exchange: true, token: true, expiry: true } } },
      take: 200,
    })) as Array<{ id: string; userId: string; side: string; quantity: number; positionType: string; instrument: { symbol: string; exchange: string; token: string; expiry: Date | null } }>;
    for (const tr of trades) {
      try {
        await this.decidePaper(tr, now);
      } catch (err) {
        this.logger.error(`[carry] paper ${tr.instrument.symbol} (${tr.id}): decision failed: ${errText(err)}`);
      }
    }
  }

  private async decidePaper(
    tr: { id: string; userId: string; side: string; quantity: number; positionType: string; instrument: { symbol: string; exchange: string; token: string; expiry: Date | null } },
    now: Date,
  ): Promise<void> {
    const w = this.windowFor(tr.instrument.exchange, now);
    if (!w || w.minutesLeft > this.cfg.windowMin) return;
    const trackerId = paperTrackerId(tr.id);
    const day = istYmd(now);
    const key = `${trackerId}|${day}`;
    if (this.progress.has(key)) return;
    if (await this.repo.forDay(trackerId, day)) {
      this.progress.set(key, { id: '', decision: 'NONE', symbol: tr.instrument.symbol, qty: tr.quantity, attempts: 0, lastAttemptAt: 0, done: true });
      return;
    }
    const verdict = await this.closeVerdict(trackerId, w.openedAt, 'paper');
    const expiryToday = tr.instrument.expiry ? istYmd(tr.instrument.expiry) === day : false;
    const o = decideClose(
      { mode: 'paper', userAllowed: true, productType: tr.positionType, expiryToday, held: false, minutesLeft: w.minutesLeft, verdict, capExhausted: false },
      withCarryTuning(this.cfg, this.sessionTuning),
    );
    if (o.action === 'WAIT' || o.action === 'NONE') return;
    const ltp = num((verdict?.packet as { position?: { ltp?: unknown } } | null)?.position?.ltp);
    const created = await this.repo.create({
      userId: tr.userId, mode: 'paper', trackerId, tradeId: tr.id, istDay: day, symbol: tr.instrument.symbol, exchange: up(tr.instrument.exchange),
      token: tr.instrument.token, productType: tr.positionType, positionSide: up(tr.side) === 'BUY' ? 'LONG' : 'SHORT', qty: tr.quantity,
      decision: o.action, reason: o.reason, verdictId: verdict?.id ?? null,
      facts: { minutesLeft: w.minutesLeft, windowOpenedAt: w.openedAt.toISOString(), expiryToday, verdict: verdict ? { id: verdict.id, verdict: verdict.verdict } : null } as Prisma.InputJsonValue,
      decisionPrice: ltp, conversionStatus: 'SIMULATED', decidedAt: now,
    });
    this.progress.set(key, { id: created?.id ?? '', decision: o.action, symbol: tr.instrument.symbol, qty: tr.quantity, attempts: 0, lastAttemptAt: 0, done: true });
    if (!created) return;
    const effect = paperCloseEffect(o.action, tr.positionType);
    if (effect.kind === 'convert') {
      await this.prisma.trade.update({ where: { id: tr.id }, data: { positionType: effect.positionType } });
      await this.repo.update(created.id, { executedAt: now });
    }
    this.logger.log(`[carry] paper ${tr.instrument.symbol} (${tr.id}): ${o.action} — ${o.reason} | ${effect.note}`);
  }

  // ─── reads ────────────────────────────────────────────────────────────────────────────────────

  /**
   * The latest judgement made inside the close window that was ASKED the CARRY/EXIT question
   * (its packet's squareOffDecision.closeChoice), never this engine's own rule rows. A look framed
   * any other way (e.g. before the product was known) is not a close decision.
   */
  private async closeVerdict(trackerId: string, openedAt: Date, mode: 'live' | 'paper'): Promise<CloseVerdict | null> {
    const where = { trackerId, createdAt: { gte: openedAt }, NOT: { promptVersion: { startsWith: 'rule:' } } };
    const select = { id: true, verdict: true, reason: true, packet: true };
    const rows = (mode === 'live'
      ? await this.prisma.sentinelVerdict.findMany({ where, select, orderBy: { createdAt: 'desc' }, take: 5 })
      : await this.prisma.paperSentinelLook.findMany({ where, select, orderBy: { createdAt: 'desc' }, take: 5 })) as CloseVerdict[];
    return rows.find((r) => (r.packet as { squareOffDecision?: { closeChoice?: unknown } } | null)?.squareOffDecision?.closeChoice === 'CARRY_OR_EXIT') ?? null;
  }

  private async latestPacket(trackerId: string, now: Date): Promise<unknown> {
    const row = await this.prisma.sentinelVerdict.findFirst({
      where: { trackerId, createdAt: { gte: new Date(now.getTime() - 12 * 3_600_000) }, NOT: { promptVersion: { startsWith: 'rule:' } } },
      select: { packet: true },
      orderBy: { createdAt: 'desc' },
    });
    return row?.packet ?? null;
  }

  private async expiryToday(exchange: string, token: string, symbol: string, now: Date): Promise<{ today: boolean; expiry: string | null }> {
    // By tradingsymbol first: tokens are REUSED after expiry (2026-11-06 BHARTIARTL / BANKINDIA), newest row otherwise.
    const bySymbol = await this.prisma.instrument.findFirst({ where: { exchange: up(exchange), symbol }, orderBy: { updatedAt: 'desc' }, select: { expiry: true } });
    if (bySymbol) { const e0 = bySymbol.expiry ?? null; return { today: e0 !== null && istYmd(e0) === istYmd(now), expiry: e0 ? istYmd(e0) : null }; }
    const inst = await this.prisma.instrument.findFirst({ where: { exchange: up(exchange), token: String(token) }, orderBy: { updatedAt: 'desc' }, select: { expiry: true } });
    const e = inst?.expiry ?? null;
    return { today: e !== null && istYmd(e) === istYmd(now), expiry: e ? istYmd(e) : null };
  }

  private async capExhausted(userId: string, now: Date): Promise<boolean> {
    const auto = parseAutoExitConfig(process.env);
    const used = await this.execRepo.countCountedSince(userId, istDayStartUtc(now), auto.mode);
    return used >= auto.dailyCap;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.error(msg);
  }
}
