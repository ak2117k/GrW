import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SessionClock } from '../../market-hub/session-clock';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { DAY_MS, istMidnightOf, istYmd, lastSessionDates } from '../../night-report/domain/night-report.logic';
import type { BarBackfill } from '../../overnight-scorecard/ports';
import type { FactorScore } from '../../overnight-scorecard/scorecard.types';
import { normaliseStockSymbol, stockMoveLabel, toReading } from '../../stock-move/stock-move.logic';
import { daysToExpiry, lastSessionClose } from '../../trade-sentinel/overnight/overnight-calendar';
import {
  atr as atrOf,
  buildSetup,
  evaluateOutcome,
  pickFuture,
  triggerFor,
  type ContextLine,
  type FutureContract,
  type MarginInput,
  type TradeSetupDraft,
} from '../domain/trade-setup.logic';
import type { IdeaRow, StockBookRow, StoredSetup, TradeSetupRepository } from '../repositories/trade-setup.repository';

/** Flag TRADE_SETUPS_ENABLED=off|on (default on: advisory text only, it places nothing). */
export interface TradeSetupConfig {
  enabled: boolean;
  /** Whose broker margin sizes the setups (the scorecard owner). */
  ownerUserId: string | null;
}

export function parseTradeSetupConfig(env: Record<string, string | undefined>, ownerUserId: string | null): TradeSetupConfig {
  const raw = (env.TRADE_SETUPS_ENABLED ?? '').trim().toLowerCase();
  return { enabled: !(raw === 'off' || raw === 'false' || raw === '0'), ownerUserId };
}

/** Futures contracts of an underlying (the broker's instrument master, else the instruments table). */
export interface FuturesSource {
  list(name: string): Promise<FutureContract[]>;
}

/** The owner's live Angel RMS funds; throws / null when the broker cannot be read. */
export interface MarginReader {
  live(userId: string): Promise<{ availableCash: number; net: number | null } | null>;
}

export const TRADE_SETUP_CONFIG = Symbol('TRADE_SETUP_CONFIG');
export const TRADE_SETUP_REPO = Symbol('TRADE_SETUP_REPO');
export const TRADE_SETUP_FUTURES = Symbol('TRADE_SETUP_FUTURES');
export const TRADE_SETUP_MARGIN = Symbol('TRADE_SETUP_MARGIN');
export const TRADE_SETUP_BACKFILL = Symbol('TRADE_SETUP_BACKFILL');
export const TRADE_SETUP_CLOCK = Symbol('TRADE_SETUP_CLOCK');
/** DI token the night report injects (`@Optional()`): absent ⇒ the section is null. */
export const TRADE_SETUPS_REPORT = Symbol('TRADE_SETUPS_REPORT');

/** A stock book older than this (calendar days) is not used. */
const BOOK_MAX_AGE_DAYS = 7;
/** A stored NIFTY MBM prediction older than this does not count as the regime. */
const MBM_MAX_AGE_MS = 5 * DAY_MS;
const DAILY_BARS = 40;
const VIX_DAYS = 21;
/** An unresolvable outcome is retried for this many sessions, then stored as NO_DATA. */
const OUTCOME_RETRY_SESSIONS = 3;

export interface BuildSummary {
  ran: boolean;
  sessionDate: string | null;
  built: number;
  skipped: Array<{ symbol: string; why: string }>;
  reason?: string;
}

export type { TradeSetupView, TradeSetupsView } from '../domain/trade-setup.view';
import type { TradeSetupView, TradeSetupsView } from '../domain/trade-setup.view';

export interface TradeSetupsReportSource {
  forNextSession(userId: string, now: Date): Promise<TradeSetupsView>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Next-morning trade setups. Nightly (after the news-ideas batch) it turns each news idea the
 * model agrees with into a concrete plan; after the session it replays the plan on 15-min bars and
 * stores the outcome for the self-review loop (kind TRADE_SETUP). ADVISORY ONLY: it writes
 * `trade_setups` / `account_margin_snapshots` and nothing else — no order, no paper trade, no
 * auto-trade, no risk-limit change.
 */
@Injectable()
export class TradeSetupService implements TradeSetupsReportSource {
  private readonly logger = new Logger(TradeSetupService.name);
  private running = false;

  constructor(
    @Inject(TRADE_SETUP_REPO) private readonly repo: TradeSetupRepository,
    @Inject(TRADE_SETUP_CONFIG) private readonly config: TradeSetupConfig,
    @Inject(TRADE_SETUP_CLOCK) private readonly clock: SessionClock,
    @Inject(TRADE_SETUP_FUTURES) private readonly futures: FuturesSource,
    @Inject(TRADE_SETUP_MARGIN) private readonly margin: MarginReader,
    @Inject(TRADE_SETUP_BACKFILL) private readonly backfill: BarBackfill | null,
  ) {}

  // ─── Build ────────────────────────────────────────────────────────────────

  async build(now: Date = new Date()): Promise<BuildSummary> {
    const none = (reason: string): BuildSummary => ({ ran: false, sessionDate: null, built: 0, skipped: [], reason });
    if (!this.config.enabled) return none('TRADE_SETUPS_ENABLED=off');
    if (this.running) return none('previous build still going');
    this.running = true;
    try {
      return await this.buildNow(now);
    } catch (e) {
      this.logger.warn(`[trade-setups] build failed: ${errText(e)}`);
      return { ran: true, sessionDate: null, built: 0, skipped: [], reason: errText(e) };
    } finally {
      this.running = false;
    }
  }

  private async buildNow(now: Date): Promise<BuildSummary> {
    const nextOpen = this.clock.nextOpen('NSE', now);
    if (!nextOpen) return { ran: false, sessionDate: null, built: 0, skipped: [], reason: 'no next NSE session' };
    const sessionDate = istYmd(nextOpen);
    const from = lastSessionClose('NSE', now, this.clock) ?? new Date(now.getTime() - DAY_MS);

    const ideas = latestIdeaPerSymbol(await this.repo.ideasSince(from));
    if (ideas.length === 0) return { ran: true, sessionDate, built: 0, skipped: [] };

    const [book, mbm, factors, vix] = await Promise.all([
      this.soft('stock book', () => this.repo.latestStockBook(new Date(now.getTime() - (BOOK_MAX_AGE_DAYS + 1) * DAY_MS)), [] as StockBookRow[]),
      this.soft('mbm regime', () => this.repo.mbmRegimes('NIFTY', now, MBM_MAX_AGE_MS), null),
      this.soft('scorecards', () => this.repo.scorecardFactors(ideas.map((i) => i.latest.scorecardId).filter((x): x is string => !!x)), new Map<string, FactorScore[]>()),
      this.soft('vix', () => this.repo.vixCloses(VIX_DAYS), [] as number[]),
    ]);
    const bookBy = new Map(book.map((r) => [normaliseStockSymbol(r.symbol), r]));
    const mbmActive = !!mbm && Object.values(mbm.regimes).some((r) => r === 'ACTIVE');
    const lastSession = lastSessionDates(now, this.clock, 1)[0] ?? null;

    const userId = this.config.ownerUserId;
    if (!userId) return { ran: false, sessionDate, built: 0, skipped: [], reason: 'no owner user (SCORECARD_USER_ID / MBM_FEED_USER_ID)' };
    let margin: MarginInput | null = null;
    const skipped: BuildSummary['skipped'] = [];
    let built = 0;
    for (const { symbol, latest, headlines } of ideas) {
      const isIndex = !!INDEX_UNDERLYINGS[symbol];
      const row = bookBy.get(symbol) ?? null;
      const t = triggerFor({ idea: latest.idea, isIndex, stock: row ? { bucket: row.bucket, resultsInWindow: row.resultsInWindow } : null, mbmActive });
      if (!t.ok) {
        skipped.push({ symbol, why: t.why });
        continue;
      }
      try {
        const price = await this.priceAndAtr(symbol, row, lastSession);
        if (!price) {
          skipped.push({ symbol, why: 'no price / daily ATR (candles and the stock-move book both lack it)' });
          continue;
        }
        margin ??= await this.marginNow();
        const future = await this.futureFor(symbol, sessionDate, nextOpen);
        const draft = buildSetup({
          sessionDate,
          symbol,
          isIndex,
          side: t.side,
          triggerWhy: t.why,
          close: price.close,
          priceAsOf: price.asOf,
          atr: price.atr,
          future,
          margin,
          context: contextLines({ isIndex, row, mbm, factors: latest.scorecardId ? factors.get(latest.scorecardId) ?? null : null, vix, hasFuture: !!future }),
          headlines,
          newsIdeaId: latest.id,
          vixLast: vix.length ? vix[vix.length - 1] : null,
        });
        await this.repo.upsert(userId, draft);
        built += 1;
      } catch (e) {
        skipped.push({ symbol, why: `failed: ${errText(e)}` });
      }
    }
    this.logger.log(`[trade-setups] ${sessionDate}: ${built} setups from ${ideas.length} news-idea symbols; skipped ${skipped.map((s) => `${s.symbol} (${s.why})`).join(', ') || 'none'}`);
    return { ran: true, sessionDate, built, skipped };
  }

  /** Last close + ATR(14) from daily candles (one broker backfill when short / stale), else the stock book's close × atr_pct. */
  private async priceAndAtr(symbol: string, row: StockBookRow | null, lastSession: string | null): Promise<{ close: number; atr: number; asOf: string | null } | null> {
    const fromCandles = async () => {
      const bars = await this.repo.dailyBars(symbol, DAILY_BARS);
      if (!bars || bars.length === 0) return null;
      const a = atrOf(bars);
      const last = bars[bars.length - 1];
      return a ? { close: last.close, atr: a, asOf: istYmd(last.day) } : null;
    };
    let p = await this.soft(`${symbol} daily bars`, fromCandles, null);
    if ((!p || (lastSession && p.asOf && p.asOf < lastSession)) && this.backfill) {
      try {
        if ((await this.backfill.fill(symbol, '1d')) > 0) p = (await this.soft(`${symbol} daily bars`, fromCandles, null)) ?? p;
      } catch (e) {
        this.logger.warn(`[trade-setups] ${symbol} 1d backfill failed: ${errText(e)}`);
      }
    }
    if (p) return p;
    if (row && row.close && row.atrPct && row.close > 0 && row.atrPct > 0) {
      return { close: row.close, atr: row.close * row.atrPct, asOf: `${row.asOf.toISOString().slice(0, 10)} (stock-move book)` };
    }
    return null;
  }

  private async futureFor(symbol: string, sessionDate: string, sessionOpen: Date) {
    const contracts = await this.soft(`${symbol} futures`, () => this.futures.list(symbol), [] as FutureContract[]);
    return pickFuture(contracts, sessionDate, (expiry) => daysToExpiry(expiry, 'NFO', sessionOpen, this.clock)?.tradingSessionsLeft ?? 99);
  }

  /** Live broker funds (snapshotted), else the last snapshot, else none (per-₹1-lakh sizing). */
  private async marginNow(): Promise<MarginInput> {
    const userId = this.config.ownerUserId;
    if (!userId) return { value: null, asOf: null, source: null };
    try {
      const live = await this.margin.live(userId);
      if (live && live.availableCash > 0) {
        await this.repo.saveMargin(userId, live.availableCash, live.net).catch(() => undefined);
        return { value: live.availableCash, asOf: new Date().toISOString(), source: 'LIVE' };
      }
    } catch (e) {
      this.logger.warn(`[trade-setups] live margin read failed, using the last known: ${errText(e)}`);
    }
    const last = await this.soft('last margin', () => this.repo.latestMargin(userId), null);
    return last ? { value: last.availableCash, asOf: last.asOf.toISOString(), source: 'LAST_KNOWN' } : { value: null, asOf: null, source: null };
  }

  /** Snapshot the broker funds while the session is warm (15:00 IST), so the night has a last-known value. */
  async snapshotMargin(): Promise<boolean> {
    const userId = this.config.ownerUserId;
    if (!this.config.enabled || !userId) return false;
    try {
      const live = await this.margin.live(userId);
      if (!live || !(live.availableCash > 0)) return false;
      await this.repo.saveMargin(userId, live.availableCash, live.net);
      return true;
    } catch (e) {
      this.logger.warn(`[trade-setups] margin snapshot failed: ${errText(e)}`);
      return false;
    }
  }

  // ─── Outcomes ─────────────────────────────────────────────────────────────

  /** Replay each unfilled setup of the last closed sessions on its 15-min bars. */
  async fillOutcomes(now: Date = new Date()): Promise<{ filled: number; pending: number }> {
    if (!this.config.enabled) return { filled: 0, pending: 0 };
    const sessions = lastSessionDates(now, this.clock, OUTCOME_RETRY_SESSIONS + 1);
    if (sessions.length === 0) return { filled: 0, pending: 0 };
    const rows = await this.repo.unfilled(sessions[sessions.length - 1], sessions[0]);
    let filled = 0;
    let pending = 0;
    for (const s of rows) {
      try {
        const from = istMidnightOf(s.sessionDate);
        const to = new Date(from.getTime() + DAY_MS);
        const read = () => this.repo.bars15m(s.symbol, from, to);
        let bars = await read();
        let o = evaluateOutcome({ side: s.side as 'LONG' | 'SHORT', atr: s.atr, prevClose: s.entryRef }, s.sessionDate, bars);
        if (o.status === 'NO_DATA' && this.backfill) {
          if ((await this.backfill.fill(s.symbol, '15m').catch(() => 0)) > 0) {
            bars = await read();
            o = evaluateOutcome({ side: s.side as 'LONG' | 'SHORT', atr: s.atr, prevClose: s.entryRef }, s.sessionDate, bars);
          }
        }
        // Give the bars a few sessions to arrive before storing NO_DATA for good.
        if (o.status === 'NO_DATA' && s.sessionDate !== sessions[sessions.length - 1]) {
          pending += 1;
          continue;
        }
        await this.repo.fill(s.id, o, now);
        filled += 1;
      } catch (e) {
        pending += 1;
        this.logger.warn(`[trade-setups] outcome for ${s.symbol} ${s.sessionDate} failed: ${errText(e)}`);
      }
    }
    if (rows.length) this.logger.log(`[trade-setups] outcomes: ${filled} filled, ${pending} pending`);
    return { filled, pending };
  }

  // ─── Night report ─────────────────────────────────────────────────────────

  /** The caller's own setups only (sized on their margin); another user gets none of them. */
  async forNextSession(userId: string, now: Date): Promise<TradeSetupsView> {
    const nextOpen = this.clock.nextOpen('NSE', now);
    const sessionDate = nextOpen ? istYmd(nextOpen) : null;
    const rows = sessionDate && userId ? await this.repo.forSession(userId, sessionDate) : [];
    return { sessionDate, setups: rows.map(toView), advisory: 'Advisory only — you place the order. Nothing here is sent to the broker, paper-traded or auto-traded.' };
  }

  private async soft<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.logger.warn(`[trade-setups] ${what} read failed: ${errText(e)}`);
      return fallback;
    }
  }
}

/** Newest idea per symbol (ideas arrive newest first) plus every distinct headline for the symbol. */
export function latestIdeaPerSymbol(rows: readonly IdeaRow[]): Array<{ symbol: string; latest: IdeaRow; headlines: string[] }> {
  const by = new Map<string, { symbol: string; latest: IdeaRow; headlines: string[] }>();
  for (const r of [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const symbol = normaliseStockSymbol(r.symbol);
    const cur = by.get(symbol);
    if (!cur) by.set(symbol, { symbol, latest: r, headlines: [r.headline] });
    else if (!cur.headlines.includes(r.headline)) cur.headlines.push(r.headline);
  }
  return [...by.values()];
}

const FACTOR_LABELS: Array<[FactorScore['name'], string]> = [
  ['oi', 'Options OI / PCR'],
  ['fii_dii', 'FII / DII'],
];

/** Context lines: each says "unavailable" (with why) rather than disappearing. */
export function contextLines(i: {
  isIndex: boolean;
  row: StockBookRow | null;
  mbm: { asOf: Date; regimes: Record<string, string> } | null;
  factors: FactorScore[] | null;
  vix: readonly number[];
  hasFuture: boolean;
}): ContextLine[] {
  const out: ContextLine[] = [];
  for (const [name, label] of FACTOR_LABELS) {
    const f = i.factors?.find((x) => x.name === name);
    if (!f) out.push({ label, text: 'unavailable (no scorecard for the news idea)', available: false });
    else out.push({ label, text: f.available ? f.value : `unavailable: ${f.reason}`, available: f.available });
  }
  out.push(
    i.hasFuture
      ? { label: 'Futures OI build-up', text: 'unavailable (futures OI is not captured yet)', available: false }
      : { label: 'Futures OI build-up', text: 'n/a (no futures for this stock)', available: false },
  );
  const v = i.vix.filter((x) => Number.isFinite(x) && x > 0);
  if (v.length >= 2) {
    const last = v[v.length - 1];
    const chg = ((last - v[v.length - 2]) / v[v.length - 2]) * 100;
    out.push({ label: 'India VIX', text: `${last.toFixed(2)} (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% d/d)`, available: true });
  } else {
    const f = i.factors?.find((x) => x.name === 'vix');
    out.push(f?.available ? { label: 'India VIX', text: f.value, available: true } : { label: 'India VIX', text: 'unavailable (no daily VIX closes)', available: false });
  }
  if (i.isIndex) {
    out.push(
      i.mbm
        ? {
            label: 'NIFTY move-size (MBM)',
            text: `${Object.entries(i.mbm.regimes).map(([h, r]) => `${h} ${r}`).join(', ')} · as of ${i.mbm.asOf.toISOString()}`,
            available: true,
          }
        : { label: 'NIFTY move-size (MBM)', text: 'unavailable (no stored prediction in 5 days)', available: false },
    );
  } else {
    out.push(
      i.row
        ? { label: 'Stock big-move model', text: stockMoveLabel(toReading({ ...i.row, horizonDays: 5 })), available: true }
        : { label: 'Stock big-move model', text: 'unavailable (not in the latest book)', available: false },
    );
  }
  return out;
}

function toView(r: StoredSetup): TradeSetupView {
  return {
    id: r.id,
    sessionDate: r.sessionDate,
    symbol: r.symbol,
    exchange: r.exchange,
    instrument: r.instrument,
    instrumentKind: r.instrumentKind,
    expiry: r.expiry,
    lotSize: r.lotSize,
    side: r.side,
    entryRule: r.entryRule,
    entryRef: r.entryRef,
    stop: r.stop,
    stopDistance: r.stopDistance,
    target1: r.target1,
    target2: r.target2,
    atr: r.atr,
    qty: r.qty,
    lots: r.lots,
    riskRs: r.riskRs,
    riskPct: r.riskPct,
    rewardT1Rs: r.rewardT1Rs,
    rewardT2Rs: r.rewardT2Rs,
    marginUsed: r.marginUsed,
    marginAvailable: r.marginAvailable,
    marginAsOf: r.marginAsOf ? r.marginAsOf.toISOString() : null,
    marginSource: r.marginSource,
    exceedsRisk: r.exceedsRisk,
    inputs: r.inputs as unknown as TradeSetupDraft['inputs'],
    outcome: r.outcomeStatus ? { status: r.outcomeStatus, r: r.outcomeR, hitT1: r.outcomeHitT1 } : null,
    updatedAt: r.updatedAt.toISOString(),
  };
}
