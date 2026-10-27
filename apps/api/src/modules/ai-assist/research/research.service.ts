import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { parseMasterExpiry, parseMasterStrike } from '../../market-data/services/master-contract';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { SentinelChartContextAdapter } from '../../trade-sentinel/adapters/chart-context.adapter';
import { NEWS_SHIM, type NewsShim } from '../../trade-sentinel/services/context-packet.service';
import { buildupSeries, chainSummary, pickExpiry, researchIntent, type BuildupDay, type ResearchData, type ResearchIntent, type StrikeRow } from './research-data';

type Row = Record<string, unknown>;
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const istYmd = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Strikes each side of spot quoted for the chain (one batched FULL quote: ≤ 50 tokens). */
const STRIKES_EACH_SIDE = 10;
const DERIVATIVE_SEGS = new Set(['NFO', 'BFO', 'MCX']);

/**
 * The advisor's research data (owner 2026-10-27; domain in research-data.ts). For a research question
 * about one F&O underlying it reads, over the OWNER's own Angel session (quotes / history only, never
 * an order): the option chain of the asked expiry (one batched FULL quote of ±10 strikes → OI, PCR,
 * max pain, walls), that expiry's future (30 sessions of daily OI + closes → build-up), the level book
 * and recent news. Every source is optional and fails into `missing` — never throws.
 */
@Injectable()
export class AdvisorResearchService {
  private readonly logger = new Logger(AdvisorResearchService.name);
  private underlyingsCache: { at: number; names: string[] } | null = null;

  constructor(
    @Optional() private readonly adapter?: AngelOneAdapterService,
    @Optional() private readonly feeds?: UserFeedManager,
    @Optional() private readonly levels?: SentinelChartContextAdapter,
    @Optional() @Inject(NEWS_SHIM) private readonly news?: NewsShim,
  ) {}

  private async master(): Promise<Row[]> {
    const rows = (await this.adapter?.getInstrumentMaster().catch(() => [])) ?? [];
    return rows as Row[];
  }

  /** Derivative underlyings in the master (IDEA, NIFTY, GOLD …), cached 6 h. */
  async underlyings(): Promise<string[]> {
    if (this.underlyingsCache && Date.now() - this.underlyingsCache.at < 6 * 3_600_000) return this.underlyingsCache.names;
    const names = new Set<string>();
    for (const r of await this.master()) if (DERIVATIVE_SEGS.has(up(r.exch_seg)) && r.name) names.add(up(r.name));
    this.underlyingsCache = { at: Date.now(), names: [...names] };
    return this.underlyingsCache.names;
  }

  /** The research intent of a question, or null (a normal chat question). Never throws. */
  async intentOf(question: string): Promise<ResearchIntent | null> {
    try {
      const names = await this.underlyings();
      return names.length ? researchIntent(question, names) : null;
    } catch {
      return null;
    }
  }

  async gather(intent: ResearchIntent, ownerUserId: string, now: Date = new Date()): Promise<ResearchData> {
    const missing: string[] = [];
    const sym = intent.symbol;
    const rows = (await this.master()).filter((r) => up(r.name) === sym && DERIVATIVE_SEGS.has(up(r.exch_seg)));
    const today = istYmd(now);
    const live = rows
      .map((r) => ({ r, expiry: parseMasterExpiry(r.expiry) }))
      .filter((x): x is { r: Row; expiry: Date } => x.expiry !== null && istYmd(x.expiry) >= today);
    const options = live.filter((x) => /^OPT/.test(up(x.r.instrumenttype)));
    const futures = live.filter((x) => /^FUT/.test(up(x.r.instrumenttype)));
    // Stock options are monthly, so the option expiries name the series.
    const expiry = pickExpiry((options.length ? options : futures).map((x) => istYmd(x.expiry)), intent.expiry);
    if (!expiry) missing.push(`no live ${sym} expiry in the contract master`);
    const fut = futures.find((x) => istYmd(x.expiry) === expiry) ?? futures.sort((a, b) => a.expiry.getTime() - b.expiry.getTime())[0];
    const lotSize = num(Number(fut?.r.lotsize ?? options[0]?.r.lotsize)) ?? null;

    // Spot: the future's own quote (cash / index lines are not in the derivative master).
    let spot: number | null = null;
    let futLtp: number | null = null;
    let futOi: number | null = null;
    if (fut && this.feeds) {
      try {
        const q = await this.feeds.fetchQuote(ownerUserId, String(fut.r.token), up(fut.r.exch_seg));
        futLtp = q && q.ltp > 0 ? q.ltp : null;
        futOi = num(q?.oi);
        spot = futLtp;
      } catch (e) {
        missing.push(`future quote: ${errText(e)}`);
      }
    } else if (!fut) missing.push(`no ${sym} future for ${expiry ?? 'any expiry'}`);

    // Option chain: ±10 strikes around spot for the expiry, one batched FULL quote.
    let chain: ResearchData['chain'] = null;
    const legs = options.filter((x) => istYmd(x.expiry) === expiry);
    if (legs.length && spot !== null && this.feeds) {
      const strikes = [...new Set(legs.map((x) => parseMasterStrike(x.r.strike)).filter((s): s is number => s !== null))].sort((a, b) => a - b);
      const atm = strikes.reduce((a, b) => (Math.abs(b - (spot as number)) < Math.abs(a - (spot as number)) ? b : a), strikes[0]);
      const i = strikes.indexOf(atm);
      const near = new Set(strikes.slice(Math.max(0, i - STRIKES_EACH_SIDE), i + STRIKES_EACH_SIDE + 1));
      const picked = legs.filter((x) => near.has(parseMasterStrike(x.r.strike) as number)).slice(0, 50);
      try {
        const quotes = await this.feeds.fetchQuotes(ownerUserId, picked.map((x) => ({ token: String(x.r.token), exchange: up(x.r.exch_seg) })));
        const byStrike = new Map<number, StrikeRow>();
        for (const x of picked) {
          const k = parseMasterStrike(x.r.strike) as number;
          const row = byStrike.get(k) ?? { strike: k, ceOi: null, peOi: null, ceLtp: null, peLtp: null };
          const q = quotes.get(String(x.r.token));
          if (up(x.r.symbol).endsWith('CE')) {
            row.ceOi = num(q?.oi);
            row.ceLtp = num(q?.ltp);
          } else {
            row.peOi = num(q?.oi);
            row.peLtp = num(q?.ltp);
          }
          byStrike.set(k, row);
        }
        chain = chainSummary([...byStrike.values()], spot);
        if (chain.ceOi + chain.peOi === 0) missing.push('option OI (the broker returned none)');
      } catch (e) {
        missing.push(`option chain quotes: ${errText(e)}`);
      }
    } else if (!legs.length) missing.push(`no ${sym} options for ${expiry ?? 'the expiry'}`);

    // Futures build-up: 30 days of daily OI + closes.
    let days: BuildupDay[] = [];
    if (fut && this.feeds) {
      const from = new Date(now.getTime() - 35 * 86_400_000);
      const ref = { token: String(fut.r.token), exchange: up(fut.r.exch_seg) };
      try {
        const [oi, bars] = await Promise.all([
          this.feeds.fetchOIWindow(ownerUserId, ref, 'ONE_DAY', from, now),
          this.feeds.fetchCandles(ownerUserId, ref.token, ref.exchange, '1d', from, now),
        ]);
        const oiByDay = new Map((oi ?? []).map((p) => [istYmd(p.ts), p.oi]));
        days = buildupSeries(
          (bars ?? []).map((b) => ({ date: istYmd(new Date(b.timestamp)), close: Number(b.close), oi: oiByDay.get(istYmd(new Date(b.timestamp))) ?? 0 })),
        );
        if (days.length === 0) missing.push('futures OI history (none returned)');
      } catch (e) {
        missing.push(`futures OI history: ${errText(e)}`);
      }
    }

    let levels: ResearchData['levels'] = null;
    if (this.levels && spot !== null) {
      try {
        const st = await this.levels.structureFor(sym, spot, ownerUserId);
        levels = { support: st.nearestSupport, resistance: st.nearestResistance, trend: st.factorValues.mtfTrend ?? null };
      } catch (e) {
        missing.push(`level book: ${errText(e)}`);
      }
    }

    const news: string[] = [];
    if (this.news) {
      try {
        const n = await this.news.recentFor(sym);
        const items = Array.isArray(n?.value) ? (n?.value as Array<Record<string, unknown>>) : [];
        for (const it of items.slice(0, 5)) if (typeof it.title === 'string') news.push(`${it.title}${typeof it.sentiment === 'string' ? ` (${it.sentiment})` : ''}`);
      } catch {
        // news is a nice-to-have
      }
    }
    missing.push('F&O ban list (not tracked by the app)');
    if (!this.feeds) missing.push('broker session (not wired)');

    return {
      symbol: sym,
      expiry,
      spot,
      spotSource: spot !== null ? `${fut ? String(fut.r.symbol) : 'future'} LTP` : '',
      lotSize,
      chain,
      futures: fut ? { tradingsymbol: String(fut.r.symbol), ltp: futLtp, oi: futOi, days } : null,
      levels,
      news,
      missing,
      at: now.toISOString(),
    };
  }

  /** gather() with a time box; null when it could not finish (the chat answers without it). */
  async gatherWithin(intent: ResearchIntent, ownerUserId: string, ms = 40_000): Promise<ResearchData | null> {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.gather(intent, ownerUserId),
        new Promise<null>((resolve) => {
          t = setTimeout(() => resolve(null), ms);
        }),
      ]);
    } catch (e) {
      this.logger.warn(`[advisor-research] ${intent.symbol}: ${errText(e)}`);
      return null;
    } finally {
      if (t) clearTimeout(t);
    }
  }
}
