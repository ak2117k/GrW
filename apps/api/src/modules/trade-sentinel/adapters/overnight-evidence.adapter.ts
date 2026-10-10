import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NewsAggregatorService } from '../../news/services/news-aggregator.service';
import { NewsCategory } from '../../news/dto/news.dto';
import { MarketContextService } from '../../market-data/services/market-context.service';
import { YahooFinanceService } from '../../market-data/services/yahoo-finance.service';
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';
import { CommodityRollService } from '../../market-data/services/commodity-roll.service';
import { MarketQuoteResolver } from '../../market-data/services/market-quote-resolver.service';
import { SENTINEL_CLOCK, lastSessionClose } from '../overnight/overnight-calendar';
import { BreadthSectorService, type SectorPerformanceEntry } from '../../market-data/services/breadth-sector.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import type { NewsEvidence, NewsItemIn, NewsScope, RawOiAnalysis } from '../overnight/overnight-evidence';
import type {
  OvernightEvidenceQuery,
  OvernightEvidenceSource,
  RawCue,
  RawCues,
  RawOiEvidence,
} from '../ports/overnight-evidence.port';
import { normaliseSymbol } from '../symbols';
import { MarketCuesService } from '../../market-cues/market-cues.service';
import { unavailableSnapshot } from '../../market-cues/market-cues.snapshot';
import type { CueRecord, MarketCuesSnapshot, PreOpenBook } from '../../market-cues/market-cues.types';

/**
 * `OvernightEvidenceSource` over the services that already exist — no new
 * scrapers, no new feeds.
 *
 *   news     NewsAggregatorService — the STORED articles (it fetches on a
 *            schedule; this reads what is there, and reports when it last
 *            took anything in so the packet can call it stale).
 *   OI       OptionsChainService — the chain (NSE and, through its MCX branch,
 *            commodity options), its own getPCR / getMaxPain, and the stored
 *            `option_chain_snapshots` for the previous session.
 *   cues     CommodityRollService + MarketQuoteResolver (MCX crude, gold), MarketContextService
 *            (India VIX), YahooFinanceService (the underlying's change vs its
 *            previous close), NseSectorIndexService + BreadthSectorService
 *            (sector strength), and MarketCuesService for the US closes and
 *            futures, FII/DII, FII index OI, GIFT Nifty and the pre-open book.
 *
 * BROKER-REACHABLE, like every adapter here — which is why it sits behind a
 * port and is named only in `trade-sentinel.module.ts`. See the module note.
 *
 * The three services MarketDataModule / OptionsChainModule do not export are
 * resolved lazily through `ModuleRef` (non-strict), the same way the tick source
 * reaches the hub; a container without them still boots and the affected
 * inputs read "not wired" rather than failing the review.
 */
@Injectable()
export class SentinelOvernightEvidenceAdapter implements OvernightEvidenceSource {
  private readonly logger = new Logger(SentinelOvernightEvidenceAdapter.name);

  constructor(
    private readonly articles: NewsAggregatorService,
    private readonly marketContext: MarketContextService,
    private readonly yahoo: YahooFinanceService,
    private readonly sectors: NseSectorIndexService,
    private readonly prisma: PrismaService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  // ─── News ──────────────────────────────────────────────────────────────────

  async news(q: OvernightEvidenceQuery): Promise<NewsEvidence> {
    const since = q.since.toISOString();
    const base = q.underlying ? normaliseSymbol(q.underlying) : null;
    const isIndex = base !== null && INDEX_NEWS_TERM[base] !== undefined;
    const sector = base && !isIndex && venue(q.exchange) !== 'MCX' ? await this.sectorFor(q.userId, base) : null;

    const asks: Array<Promise<NewsItemIn[]>> = [];
    // Order matters: dedupe keeps the FIRST scope that surfaced a headline.
    if (base) {
      asks.push(this.articles.getNewsForSymbol(base).then((rows) => rows.map((r) => item(r, 'symbol'))));
    }
    if (sector) {
      asks.push(this.listed({ category: NewsCategory.SECTOR, search: sector.sector, from: since, limit: 20 }, 'sector'));
    }
    const indexTerm = venue(q.exchange) === 'MCX' ? null : base && isIndex ? INDEX_NEWS_TERM[base] : 'Nifty';
    if (indexTerm) asks.push(this.listed({ search: indexTerm, from: since, limit: 20 }, 'index'));
    asks.push(this.listed({ category: NewsCategory.INDIAN, from: since, limit: 20 }, 'macro'));
    asks.push(this.listed({ category: NewsCategory.GLOBAL, from: since, limit: 20 }, 'macro'));

    const [groups, latest] = await Promise.all([
      Promise.all(asks),
      this.articles.getNews({ limit: 1 } as never).catch(() => ({ data: [] as Array<{ fetchedAt?: Date }> })),
    ]);
    const newest = (latest as { data: Array<{ fetchedAt?: Date }> }).data[0]?.fetchedAt;
    return {
      items: groups.flat(),
      lastFetchAt: newest instanceof Date ? newest.toISOString() : null,
    };
  }

  private async listed(
    filters: { category?: NewsCategory; search?: string; from: string; limit: number },
    scope: NewsScope,
  ): Promise<NewsItemIn[]> {
    const { data } = await this.articles.getNews(filters as never);
    return data.map((r) => item(r, scope));
  }

  // ─── OI ────────────────────────────────────────────────────────────────────

  async oi(q: OvernightEvidenceQuery): Promise<RawOiEvidence> {
    const none = (reason: string): RawOiEvidence => ({ analysis: { available: false, reason }, legGreeks: null });
    const chainSvc = this.lazy(OptionsChainService);
    if (!chainSvc) return none('options-chain.service is not wired into this process — OI analysis unavailable');
    if (!q.underlying) return none('the underlying could not be resolved, so no options chain was looked up');
    const underlying = normaliseSymbol(q.underlying);

    const expiries = await chainSvc.getExpiries(underlying);
    if (!expiries || expiries.length === 0) {
      return none(`no option expiries for ${underlying} on ${q.exchange} — OI analysis unavailable for this underlying`);
    }
    // THE POSITION'S OWN EXPIRY, OR NOTHING, for an option: another expiry's OI
    // and greeks are not this contract's, and using them silently would put a
    // wrong theta and a wrong build-up in front of the judge with provenance. A
    // future has no option expiry of its own, so it reads the nearest one and
    // the source string says so.
    let expiry: string;
    let expiryNote = '';
    if (q.segment === 'FUT') {
      expiry = expiries[0];
      expiryNote = `; nearest option expiry — the future expires ${q.expiry ?? 'unknown'}`;
    } else {
      if (!q.expiry) return none('the contract expiry is unknown, so its options chain cannot be chosen');
      const own = expiries.find((e) => e.slice(0, 10) === q.expiry);
      if (!own) {
        return none(`no chain snapshot for ${q.expiry} (${underlying}) — another expiry’s OI and greeks are not this contract’s`);
      }
      expiry = own;
    }
    const { chain, spotPrice } = await chainSvc.getOptionsChainWithSpot(underlying, expiry);
    if (!chain || chain.length === 0) return none(`the options chain for ${underlying} ${expiry} came back empty`);

    const at = q.now.toISOString();
    let ceOi = 0;
    let peOi = 0;
    let oiChange = 0;
    let hasOiChange = false;
    let callWall: number | null = null;
    let putWall: number | null = null;
    let topCe = 0;
    let topPe = 0;
    for (const e of chain) {
      const ce = e.ceData?.oi ?? 0;
      const pe = e.peData?.oi ?? 0;
      ceOi += ce;
      peOi += pe;
      for (const d of [e.ceData?.oiChange, e.peData?.oiChange]) {
        if (Number.isFinite(d as number) && d !== 0) {
          oiChange += d as number;
          hasOiChange = true;
        }
      }
      if (ce > topCe) {
        topCe = ce;
        callWall = e.strikePrice;
      }
      if (pe > topPe) {
        topPe = pe;
        putWall = e.strikePrice;
      }
    }
    const oiPresent = ceOi > 0 || peOi > 0;
    const pcr = oiPresent ? chainSvc.getPCR(chain) : 0;
    const maxPain = oiPresent ? chainSvc.getMaxPain(chain) : 0;

    // The previous session's chain: the newest snapshot captured BEFORE the
    // session this review looks back on began (IST midnight of the last close).
    const sessionDay = Date.parse(`${istYmd(q.since)}T00:00:00.000Z`) - IST_OFFSET_MS;
    const prevRow = await this.prisma.optionChainSnapshot.findFirst({
      where: { underlying, expiryDate: new Date(expiry), capturedAt: { lt: new Date(sessionDay) } },
      orderBy: { capturedAt: 'desc' },
    });
    const prevChain = (prevRow?.chainJson ?? null) as unknown as typeof chain | null;
    let prevSession: Extract<RawOiAnalysis, { available: true }>['prevSession'] = null;
    if (prevRow && Array.isArray(prevChain)) {
      const pc = prevChain.reduce((s, e) => s + (e.ceData?.oi ?? 0), 0);
      const pp = prevChain.reduce((s, e) => s + (e.peData?.oi ?? 0), 0);
      prevSession = {
        at: prevRow.capturedAt.toISOString(),
        pcr: pc > 0 ? Math.round((pp / pc) * 100) / 100 : null,
        totalCeOi: pc > 0 || pp > 0 ? pc : null,
        totalPeOi: pc > 0 || pp > 0 ? pp : null,
        spot: Number(prevRow.spotPrice) || null,
      };
    }

    let contract: Extract<RawOiAnalysis, { available: true }>['contract'] = null;
    let legGreeks: RawOiEvidence['legGreeks'] = null;
    if (q.option) {
      const pick = (rows: typeof chain | null) => {
        const row = rows?.find((e) => e.strikePrice === q.option?.strike);
        return row ? (q.option?.optionType === 'CE' ? row.ceData : row.peData) : null;
      };
      const legNow = pick(chain);
      const legPrev = pick(prevChain);
      if (legNow) {
        contract = {
          strike: q.option.strike,
          optionType: q.option.optionType,
          ltp: legNow.ltp > 0 ? legNow.ltp : null,
          oi: oiPresent ? legNow.oi : null,
          oiChange: Number.isFinite(legNow.oiChange) && legNow.oiChange !== 0 ? legNow.oiChange : null,
          prev: legPrev ? { ltp: legPrev.ltp > 0 ? legPrev.ltp : null, oi: legPrev.oi > 0 ? legPrev.oi : null } : null,
        };
        const g = (n: number) => (Number.isFinite(n) && n !== 0 ? n : null);
        if ([legNow.delta, legNow.theta, legNow.vega].some((n) => g(n) !== null)) {
          legGreeks = {
            delta: g(legNow.delta),
            gamma: g(legNow.gamma),
            theta: g(legNow.theta),
            vega: g(legNow.vega),
            iv: g(legNow.iv),
            source: `options-chain.service greeks (${underlying} ${expiry}, strike ${q.option.strike} ${q.option.optionType})`,
            at,
          };
        }
      }
    }

    const change = await this.underlyingChange(underlying, q.exchange);
    return {
      analysis: {
        available: true,
        source: `options-chain.service (${underlying} ${expiry}${expiryNote})`,
        at,
        expiry,
        spot: spotPrice > 0 ? spotPrice : q.underlyingLtp,
        pcr: pcr > 0 ? pcr : null,
        maxPain: maxPain > 0 ? maxPain : null,
        callWall: oiPresent ? callWall : null,
        putWall: oiPresent ? putWall : null,
        totalCeOi: oiPresent ? ceOi : null,
        totalPeOi: oiPresent ? peOi : null,
        totalOiChange: hasOiChange ? oiChange : null,
        underlyingPriceChange:
          change && Number.isFinite(change.regularMarketChange) && change.regularMarketChange !== 0
            ? { value: change.regularMarketChange, source: 'yahoo-finance.service (session change vs previous close)' }
            : null,
        prevSession,
        contract,
      },
      legGreeks,
    };
  }

  // ─── Market cues ───────────────────────────────────────────────────────────

  async cues(q: OvernightEvidenceQuery): Promise<RawCues> {
    const base = q.underlying ? normaliseSymbol(q.underlying) : null;
    const [commodities, vix, change, sector, market] = await Promise.all([
      this.commodityCues(q.userId, q.now),
      this.vixCue(q.now),
      this.underlyingChangeCue(base, q.exchange, q.now),
      this.sectorCue(q.userId, base, q.exchange, q.now),
      this.marketCues(q.now),
    ]);
    return {
      market,
      crudeOil: commodities.crude,
      gold: commodities.gold,
      indiaVix: vix,
      underlyingChange: change,
      sectorStrength: sector,
    };
  }

  /** Today's NSE pre-open book, fetched if this process does not have today's yet. */
  async preOpen(now: Date): Promise<CueRecord<PreOpenBook>> {
    const svc = this.lazy(MarketCuesService);
    if (!svc) return unavailableSnapshot('market-cues.service is not wired into this process').preOpen;
    return (await svc.ensure(['preOpen'], now)).preOpen;
  }

  /**
   * The market-cues snapshot (US, FII/DII, FII OI, GIFT). Mostly served from the
   * service's cache; a group this process has never read (or whose read is not
   * ok and is over half an hour old) is fetched once, shared by every position.
   */
  private async marketCues(now: Date): Promise<MarketCuesSnapshot> {
    const svc = this.lazy(MarketCuesService);
    if (!svc) return unavailableSnapshot('market-cues.service is not wired into this process');
    try {
      return await svc.ensure(['us', 'fiiDii', 'fiiOi', 'gift'], now);
    } catch (err) {
      return unavailableSnapshot(`market-cues.service failed: ${message(err)}`);
    }
  }

  /**
   * MCX crude and gold, front month, over the user's own session. Dated by the
   * venue: while MCX trades, the quote's own timestamp; once it has closed, the
   * MCX session close — the price IS that close, whatever the quote says.
   */
  private async commodityCues(userId: string, now: Date): Promise<{ crude: RawCue; gold: RawCue }> {
    const roll = this.lazy(CommodityRollService);
    const resolver = this.lazy(MarketQuoteResolver);
    if (!roll || !resolver) {
      const r: RawCue = { reading: null, reason: 'commodity-roll / market-quote-resolver are not wired into this process' };
      return { crude: r, gold: r };
    }
    try {
      const contracts = await roll.resolveFrontMonthTokens();
      const quotes = await resolver.resolveQuotes(
        userId,
        contracts.map((c) => ({ token: c.token, exchange: c.exchange || 'MCX', symbol: c.symbol })),
      );
      const mcxOpen = SENTINEL_CLOCK.phase('MCX', now) === 'open';
      const close = lastSessionClose('MCX', now);
      const pick = (name: string, test: (s: string) => boolean): RawCue => {
        const contract = contracts.find((c) => test(c.symbol.toUpperCase()));
        const quote = contract ? quotes.get(contract.token) : undefined;
        if (!contract || !quote || !Number.isFinite(quote.ltp) || quote.ltp <= 0) {
          return { reading: null, reason: `MCX ${name} front month could not be quoted over this user's session` };
        }
        const stamp = quote.timestamp instanceof Date ? quote.timestamp : new Date(quote.timestamp);
        const dated =
          mcxOpen && Number.isFinite(stamp.getTime())
            ? { at: stamp.toISOString(), basis: 'quote time' as const }
            : close
              ? { at: close.toISOString(), basis: 'previous session close' as const }
              : null;
        if (!dated) return { reading: null, reason: `MCX ${name}: no quote time and no session close to date it by` };
        return {
          reading: { value: quote.ltp, change: quote.change, changePercent: quote.changePercent, ...dated },
          source: `market-quote-resolver (MCX ${name} front-month future ${contract.contractSymbol}; change vs previous close)`,
        };
      };
      return { crude: pick('CRUDEOIL', (s) => s.startsWith('CRUDE')), gold: pick('GOLD', (s) => s === 'GOLD') };
    } catch (err) {
      const r: RawCue = { reading: null, reason: `MCX commodity quotes failed: ${message(err)}` };
      return { crude: r, gold: r };
    }
  }

  private async vixCue(now: Date): Promise<RawCue> {
    const close = lastSessionClose('NSE', now);
    if (!close) return { reading: null, reason: 'no previous NSE session close to date India VIX by' };
    try {
      const h = await this.marketContext.getVixHistory();
      if (!h) return { reading: null, reason: 'market-context.service returned no India VIX history' };
      const change = Math.round((h.today - h.yesterday) * 100) / 100;
      return {
        reading: {
          value: h.today,
          change,
          changePercent: h.yesterday > 0 ? Math.round(((h.today - h.yesterday) / h.yesterday) * 10000) / 100 : null,
          // Daily closes carry no time of their own: dated to the NSE close they describe.
          at: close.toISOString(),
          basis: 'previous session close',
        },
        source: 'market-context.service getVixHistory (latest two ^INDIAVIX daily closes)',
      };
    } catch (err) {
      return { reading: null, reason: `market-context.service failed: ${message(err)}` };
    }
  }

  private async underlyingChangeCue(base: string | null, exchange: string, now: Date): Promise<RawCue> {
    if (!base) return { reading: null, reason: 'the underlying could not be resolved' };
    const close = lastSessionClose(base === 'SENSEX' ? 'BSE' : 'NSE', now);
    try {
      const q = await this.underlyingChange(base, exchange);
      if (!q || !Number.isFinite(q.regularMarketPrice) || q.regularMarketPrice <= 0) {
        return {
          reading: null,
          reason:
            venue(exchange) === 'MCX'
              ? 'yahoo-finance.service has no MCX mapping — the underlying’s previous-close change is unavailable'
              : `yahoo-finance.service returned no quote for ${base}`,
        };
      }
      return {
        reading: {
          value: q.regularMarketPrice,
          change: q.regularMarketChange,
          changePercent: q.regularMarketChangePercent,
          // Yahoo returns no quote time here; the venue is closed, so this IS the
          // last session's close vs the one before it — not an overnight move.
          at: (close ?? now).toISOString(),
          basis: 'previous session close',
        },
        source: `yahoo-finance.service getQuoteChange (${base}: last session's close vs the session before)`,
      };
    } catch (err) {
      return { reading: null, reason: `yahoo-finance.service failed: ${message(err)}` };
    }
  }

  private async sectorCue(userId: string, base: string | null, exchange: string, now: Date): Promise<RawCues['sectorStrength']> {
    if (!base) return { value: null, reason: 'the underlying could not be resolved' };
    if (venue(exchange) === 'MCX') return { value: null, reason: 'a commodity has no equity sector' };
    if (INDEX_NEWS_TERM[base] !== undefined) return { value: null, reason: 'the underlying is an index — no single sector' };
    try {
      const sector = await this.sectorFor(userId, base);
      if (!sector) return { value: null, reason: `no sector index resolved or quoted for ${base}` };
      return {
        value: {
          sector: sector.sector,
          index: sector.symbol,
          changePercent: sector.changePercent,
          direction: Math.abs(sector.changePercent) < 0.1 ? 'FLAT' : sector.changePercent > 0 ? 'UP' : 'DOWN',
        },
        source:
          'nse-sector-index.service + breadth-sector.service (sector index: last session close vs the session ' +
          'before; dated to that close — the quote carries no time of its own)',
        at: (lastSessionClose('NSE', now) ?? now).toISOString(),
      };
    } catch (err) {
      return { value: null, reason: `sector lookup failed: ${message(err)}` };
    }
  }

  private async sectorFor(
    userId: string,
    base: string,
  ): Promise<{ sector: string; symbol: string; changePercent: number } | null> {
    const breadth = this.lazy(BreadthSectorService);
    if (!breadth) return null;
    const token = await this.sectors.getSectorIndexForSymbol(base).catch(() => null);
    if (!token) return null;
    const rows = await breadth.getSectorPerformance(userId).catch((): SectorPerformanceEntry[] => []);
    const row = rows.find((r) => r.token === token);
    return row ? { sector: row.sector, symbol: row.symbol, changePercent: row.changePercent } : null;
  }

  private async underlyingChange(base: string, exchange: string) {
    if (venue(exchange) === 'MCX') return null;
    const token = INDEX_TOKENS[base] ?? '';
    return this.yahoo.getQuoteChange(base, token && base === 'SENSEX' ? 'BSE' : 'NSE', token);
  }

  private lazy<T>(cls: new (...args: never[]) => T): T | null {
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get(cls, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istYmd(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function venue(exchange: string): 'MCX' | 'EQUITY' {
  return String(exchange ?? '').toUpperCase() === 'MCX' ? 'MCX' : 'EQUITY';
}

/** Index underlyings → the word headlines use for them. */
const INDEX_NEWS_TERM: Record<string, string> = {
  NIFTY: 'Nifty',
  BANKNIFTY: 'Bank Nifty',
  FINNIFTY: 'Fin Nifty',
  MIDCPNIFTY: 'Midcap',
  SENSEX: 'Sensex',
};

/** Index underlyings → the tokens yahoo-finance.service maps (same as market-context.service). */
const INDEX_TOKENS: Record<string, string> = {
  NIFTY: '99926000',
  BANKNIFTY: '99926009',
  FINNIFTY: '99926037',
  SENSEX: '99919000',
};

function item(
  r: { title: string; source: string; url?: string | null; sentiment?: string | null; publishedAt: Date },
  scope: NewsScope,
): NewsItemIn {
  return {
    title: r.title,
    source: r.source,
    url: r.url ?? null,
    sentiment: r.sentiment ?? null,
    publishedAt: r.publishedAt.toISOString(),
    scope,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
