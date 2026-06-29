import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Cron } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { YahooFinanceService } from './yahoo-finance.service';
import {
  StockSectorRepository,
  StockSectorRow,
} from '../repositories/stock-sector.repository';

/**
 * Broad NSE constituent CSV. We pull the single widest published list —
 * NIFTY 500 — instead of fetching the 15 separate sectoral-index lists.
 * Every row carries an `Industry` column, so one fetch gives us both the
 * symbol universe AND the industry classification needed to resolve a
 * stock to its sector index. This covers ~500 stocks vs ~200-400 from the
 * union of the sectoral lists, and crucially includes mid/small-caps.
 *
 * Format (verified 2026-05-12, unchanged on the 500 list):
 *   Company Name,Industry,Symbol,Series,ISIN Code
 *   Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021
 */
const NIFTY_500_CSV_URL =
  'https://archives.nseindia.com/content/indices/ind_nifty500list.csv';

/** The 15 NIFTY sectoral-index tokens we track (Angel One NSE). */
const SECTOR_TOKEN = {
  BANK: '99926009',
  FIN_SERVICE: '99926011',
  IT: '99926013',
  FMCG: '99926015',
  PHARMA: '99926017',
  ENERGY: '99926019',
  AUTO: '99926021',
  METAL: '99926023',
  REALTY: '99926027',
  INFRA: '99926029',
  MEDIA: '99926031',
  PSU_BANK: '99926033',
  PVT_BANK: '99926035',
  HEALTHCARE: '99926041',
  CONSUMER_DURABLES: '99926039',
} as const;

/**
 * NSE `Industry` string → NIFTY sector-index token.
 *
 * Keys are the exact `Industry` values NSE publishes in the constituent
 * CSVs (lower-cased here for case-insensitive matching). Industries with
 * no clean sectoral index (e.g. "Diversified", "Diversified FMCG" sits
 * elsewhere, "Insurance", "Capital Markets") are deliberately left out —
 * the lookup yields null for those, matching the old behaviour.
 *
 * Telecom and Media both fold into NIFTY MEDIA (NIFTY's only
 * communication-adjacent sectoral index). Industrial / capital-goods
 * industries fold into NIFTY INFRA.
 */
const INDUSTRY_TO_SECTOR_TOKEN: Record<string, string> = {
  // ─── IT ───
  'information technology': SECTOR_TOKEN.IT,
  'it - software': SECTOR_TOKEN.IT,
  'it - hardware': SECTOR_TOKEN.IT,
  'it - services': SECTOR_TOKEN.IT,
  'it enabled services': SECTOR_TOKEN.IT,
  software: SECTOR_TOKEN.IT,

  // ─── Banks ───
  banks: SECTOR_TOKEN.BANK,
  'banks - private sector': SECTOR_TOKEN.PVT_BANK,
  'banks - public sector': SECTOR_TOKEN.PSU_BANK,

  // ─── Financials (non-bank) ───
  finance: SECTOR_TOKEN.FIN_SERVICE,
  'financial services': SECTOR_TOKEN.FIN_SERVICE,
  'financial technology (fintech)': SECTOR_TOKEN.FIN_SERVICE,

  // ─── Pharma / Healthcare ───
  'pharmaceuticals & biotechnology': SECTOR_TOKEN.PHARMA,
  pharmaceuticals: SECTOR_TOKEN.PHARMA,
  'healthcare services': SECTOR_TOKEN.HEALTHCARE,
  healthcare: SECTOR_TOKEN.HEALTHCARE,
  'health care equipment & supplies': SECTOR_TOKEN.HEALTHCARE,

  // ─── FMCG / Consumer staples ───
  'food products': SECTOR_TOKEN.FMCG,
  beverages: SECTOR_TOKEN.FMCG,
  'agricultural food & other products': SECTOR_TOKEN.FMCG,
  'personal products': SECTOR_TOKEN.FMCG,
  'household products': SECTOR_TOKEN.FMCG,
  'diversified fmcg': SECTOR_TOKEN.FMCG,
  cigarettes: SECTOR_TOKEN.FMCG,
  'cigarettes & tobacco products': SECTOR_TOKEN.FMCG,
  // NSE 2026 rollup: replaces the granular FMCG sub-industries above.
  'fast moving consumer goods': SECTOR_TOKEN.FMCG,

  // ─── Consumer durables ───
  'consumer durables': SECTOR_TOKEN.CONSUMER_DURABLES,
  'household appliances': SECTOR_TOKEN.CONSUMER_DURABLES,
  'leisure products': SECTOR_TOKEN.CONSUMER_DURABLES,

  // ─── Auto ───
  automobiles: SECTOR_TOKEN.AUTO,
  'auto components': SECTOR_TOKEN.AUTO,
  'auto ancillaries': SECTOR_TOKEN.AUTO,
  // NSE 2026 rollup: merges Automobiles + Auto Components into one industry.
  'automobile and auto components': SECTOR_TOKEN.AUTO,

  // ─── Metals / Mining ───
  'ferrous metals': SECTOR_TOKEN.METAL,
  'non - ferrous metals': SECTOR_TOKEN.METAL,
  'non-ferrous metals': SECTOR_TOKEN.METAL,
  'metals & minerals trading': SECTOR_TOKEN.METAL,
  'minerals & mining': SECTOR_TOKEN.METAL,
  'industrial minerals': SECTOR_TOKEN.METAL,
  // NSE 2026 rollup: merges ferrous + non-ferrous + mining into one industry.
  'metals & mining': SECTOR_TOKEN.METAL,

  // ─── Energy / Oil & Gas / Power ───
  'petroleum products': SECTOR_TOKEN.ENERGY,
  'oil': SECTOR_TOKEN.ENERGY,
  gas: SECTOR_TOKEN.ENERGY,
  power: SECTOR_TOKEN.ENERGY,
  'coal': SECTOR_TOKEN.ENERGY,
  'consumable fuels': SECTOR_TOKEN.ENERGY,
  // NSE 2026 rollup: merges oil + gas + coal + consumable fuels.
  'oil gas & consumable fuels': SECTOR_TOKEN.ENERGY,

  // ─── Realty ───
  realty: SECTOR_TOKEN.REALTY,

  // ─── Infra / Industrials / Capital goods ───
  'construction': SECTOR_TOKEN.INFRA,
  'cement & cement products': SECTOR_TOKEN.INFRA,
  cement: SECTOR_TOKEN.INFRA,
  'industrial products': SECTOR_TOKEN.INFRA,
  'industrial manufacturing': SECTOR_TOKEN.INFRA,
  'engineering services': SECTOR_TOKEN.INFRA,
  'electrical equipment': SECTOR_TOKEN.INFRA,
  'construction materials': SECTOR_TOKEN.INFRA,
  'transport infrastructure': SECTOR_TOKEN.INFRA,
  'aerospace & defense': SECTOR_TOKEN.INFRA,
  // NSE 2026 rollup: industrial / capital-goods bucket (largest unmapped, 63 rows).
  'capital goods': SECTOR_TOKEN.INFRA,

  // ─── Telecom / Media → NIFTY MEDIA ───
  'telecom - services': SECTOR_TOKEN.MEDIA,
  'telecom - equipment & accessories': SECTOR_TOKEN.MEDIA,
  'telecom services': SECTOR_TOKEN.MEDIA,
  media: SECTOR_TOKEN.MEDIA,
  'media & entertainment': SECTOR_TOKEN.MEDIA,
  entertainment: SECTOR_TOKEN.MEDIA,
  'media - print/television/radio': SECTOR_TOKEN.MEDIA,
  // NSE 2026 rollups: telecom + media now ship as broader industry strings.
  telecommunication: SECTOR_TOKEN.MEDIA,
  'media entertainment & publication': SECTOR_TOKEN.MEDIA,
};

/**
 * Hardcoded fallback used if the DB has no row for a symbol AND the broad
 * refresh has never landed (boot before first refresh, NSE down on first
 * run). Copied from the previous static map so behaviour degrades
 * gracefully.
 */
const STATIC_FALLBACK: Record<string, string> = {
  HDFCBANK: SECTOR_TOKEN.BANK, ICICIBANK: SECTOR_TOKEN.BANK, SBIN: SECTOR_TOKEN.BANK,
  AXISBANK: SECTOR_TOKEN.BANK, KOTAKBANK: SECTOR_TOKEN.BANK, INDUSINDBK: SECTOR_TOKEN.BANK,
  BAJFINANCE: SECTOR_TOKEN.FIN_SERVICE,
  TCS: SECTOR_TOKEN.IT, INFY: SECTOR_TOKEN.IT, WIPRO: SECTOR_TOKEN.IT,
  HCLTECH: SECTOR_TOKEN.IT, TECHM: SECTOR_TOKEN.IT, LTIM: SECTOR_TOKEN.IT,
  MARUTI: SECTOR_TOKEN.AUTO, TATAMOTORS: SECTOR_TOKEN.AUTO, M_M: SECTOR_TOKEN.AUTO,
  BAJAJ_AUTO: SECTOR_TOKEN.AUTO,
  RELIANCE: SECTOR_TOKEN.ENERGY, ONGC: SECTOR_TOKEN.ENERGY, GAIL: SECTOR_TOKEN.ENERGY,
  BPCL: SECTOR_TOKEN.ENERGY, IOC: SECTOR_TOKEN.ENERGY, HINDPETRO: SECTOR_TOKEN.ENERGY,
  NTPC: SECTOR_TOKEN.ENERGY, POWERGRID: SECTOR_TOKEN.ENERGY,
  TATASTEEL: SECTOR_TOKEN.METAL, HINDALCO: SECTOR_TOKEN.METAL, JSWSTEEL: SECTOR_TOKEN.METAL,
  VEDL: SECTOR_TOKEN.METAL, HINDCOPPER: SECTOR_TOKEN.METAL, HINDZINC: SECTOR_TOKEN.METAL,
  SUNPHARMA: SECTOR_TOKEN.PHARMA, DIVISLAB: SECTOR_TOKEN.PHARMA, DRREDDY: SECTOR_TOKEN.PHARMA,
  CIPLA: SECTOR_TOKEN.PHARMA,
  HINDUNILVR: SECTOR_TOKEN.FMCG, ITC: SECTOR_TOKEN.FMCG, NESTLEIND: SECTOR_TOKEN.FMCG,
  BRITANNIA: SECTOR_TOKEN.FMCG,
};

/**
 * Yahoo Finance's broad sector classification → NIFTY sector index token.
 * Used as Tier-3 fallback for stocks outside the NIFTY 500 universe.
 */
const YAHOO_SECTOR_TO_NIFTY: Record<string, string> = {
  'Financial Services': SECTOR_TOKEN.FIN_SERVICE,
  'Technology': SECTOR_TOKEN.IT,
  'Consumer Defensive': SECTOR_TOKEN.FMCG,
  'Consumer Cyclical': SECTOR_TOKEN.CONSUMER_DURABLES,
  'Healthcare': SECTOR_TOKEN.PHARMA,
  'Energy': SECTOR_TOKEN.ENERGY,
  'Basic Materials': SECTOR_TOKEN.METAL,
  'Industrials': SECTOR_TOKEN.INFRA,
  'Real Estate': SECTOR_TOKEN.REALTY,
  'Communication Services': SECTOR_TOKEN.MEDIA,
  'Utilities': SECTOR_TOKEN.ENERGY,
};

const YAHOO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a stock symbol to its NIFTY sector-index token.
 *
 * The daily `refresh()` downloads the broad NIFTY 500 constituent CSV,
 * maps each row's NSE `Industry` to a sector-index token, and upserts
 * `(symbol, industry, sectorIndexToken)` into the `stock_sectors` table.
 *
 * `getSectorIndexForSymbol` resolves in 3 tiers:
 *   Tier 1: the `stock_sectors` DB table (~500 stocks, incl. mid/small-cap)
 *   Tier 2: static hardcoded large-cap fallback (boot before first refresh)
 *   Tier 3: Yahoo Finance asset profile (anything outside NIFTY 500)
 */
@Injectable()
export class NseSectorIndexService implements OnModuleInit {
  private readonly logger = new Logger(NseSectorIndexService.name);
  private lastRefreshAt: Date | null = null;

  /**
   * Per-symbol Yahoo lookup cache. Stores the resolved NIFTY sector token
   * (or null) with a 24h TTL — classifications are stable on a daily
   * timescale.
   */
  private yahooCache = new Map<string, { sectorToken: string | null; cachedAt: number }>();

  constructor(
    private readonly http: HttpService,
    private readonly yahoo: YahooFinanceService,
    private readonly stockSectorRepo: StockSectorRepository,
  ) {}

  async onModuleInit() {
    // Don't block startup — fetch async, fall back to static if it takes time.
    this.refresh().catch((err) => {
      this.logger.warn(
        `Initial sector refresh failed: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  /** Cron at 06:00 IST daily (00:30 UTC) — well before market open. */
  @Cron('30 0 * * 1-5')
  async dailyRefresh() {
    this.logger.log('Daily NSE sector-index refresh triggered');
    await this.refresh();
  }

  /**
   * Manually trigger a refresh. Downloads the broad NIFTY 500 CSV, resolves
   * each row's industry to a sector token, and upserts the lot into the
   * `stock_sectors` table. Returns the count of symbols persisted.
   * On a failed fetch the existing table is left untouched (returns 0).
   * Public for ops endpoints + tests.
   */
  async refresh(): Promise<number> {
    let rows: StockSectorRow[];
    try {
      rows = await this.fetchUniverse();
    } catch (err) {
      this.logger.warn(
        `NSE NIFTY 500 fetch failed: ${err instanceof Error ? err.message : err} — keeping existing stock_sectors table`,
      );
      return 0;
    }

    if (rows.length === 0) {
      this.logger.warn('NSE NIFTY 500 CSV parsed to 0 rows — keeping existing table');
      return 0;
    }

    const persisted = await this.stockSectorRepo.upsertMany(rows);
    this.lastRefreshAt = new Date();
    const mapped = rows.filter((r) => r.sectorIndexToken !== null).length;
    this.logger.log(
      `NSE sector refresh: ${persisted} stocks persisted (${mapped} mapped to a sector index, ${rows.length - mapped} unmapped)`,
    );
    return persisted;
  }

  /**
   * Look up sector index token for a stock symbol. Returns null if not found.
   * Bare-symbol lookup (case-insensitive). Strips series suffixes like -EQ/-BE
   * before matching, since Chartink sends bare names.
   *
   * Tier 1: `stock_sectors` DB table — a row here is authoritative even
   *         when its token is null (industry has no clean sector index);
   *         we do NOT fall through to slow tiers in that case.
   * Tier 2: static hardcoded fallback for offline boot (~40 large caps).
   * Tier 3: Yahoo Finance asset profile (handles names outside NIFTY 500).
   */
  async getSectorIndexForSymbol(symbol: string): Promise<string | null> {
    if (!symbol) return null;
    const bare = symbol.toUpperCase().replace(/-(EQ|BE|BL|IV|RL)$/, '');

    // Tier 1: DB-backed broad map
    const row = await this.stockSectorRepo.findBySymbol(bare);
    if (row) {
      // Authoritative — null token means "industry has no sector index".
      return row.sectorIndexToken ?? null;
    }

    // Tier 2: static hardcoded fallback (for offline boot)
    const tier2 = STATIC_FALLBACK[bare];
    if (tier2) return tier2;

    // Tier 3: Yahoo Finance asset profile (handles names outside NIFTY 500)
    return this.resolveFromYahoo(bare);
  }

  private async resolveFromYahoo(bare: string): Promise<string | null> {
    const cached = this.yahooCache.get(bare);
    if (cached && Date.now() - cached.cachedAt < YAHOO_CACHE_TTL_MS) {
      return cached.sectorToken;
    }
    const profile = await this.yahoo.getAssetProfile(bare);
    const sectorToken = profile?.sector
      ? YAHOO_SECTOR_TO_NIFTY[profile.sector] ?? null
      : null;
    this.yahooCache.set(bare, { sectorToken, cachedAt: Date.now() });
    if (sectorToken) {
      this.logger.log(
        `Yahoo fallback: ${bare} → sector "${profile?.sector}" → token ${sectorToken}`,
      );
    }
    return sectorToken;
  }

  /** For ops/admin endpoints. */
  async getStats(): Promise<{ count: number; lastRefreshAt: Date | null }> {
    const count = await this.stockSectorRepo.count();
    return { count, lastRefreshAt: this.lastRefreshAt };
  }

  /**
   * Map an NSE `Industry` string to a NIFTY sector-index token. Returns
   * null for industries with no clean sectoral index. Public for tests.
   */
  industryToSectorToken(industry: string): string | null {
    if (!industry) return null;
    return INDUSTRY_TO_SECTOR_TOKEN[industry.trim().toLowerCase()] ?? null;
  }

  /** Fetch + parse the broad NIFTY 500 CSV into upsert-ready rows. */
  private async fetchUniverse(): Promise<StockSectorRow[]> {
    const response = await firstValueFrom(
      this.http.get<string>(NIFTY_500_CSV_URL, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/csv,*/*',
        },
        responseType: 'text',
        timeout: 15_000,
      }),
    );
    return this.parseConstituentsCsv(response.data);
  }

  /**
   * Parse NSE's constituent CSV. Format (verified 2026-05-12):
   *   Company Name,Industry,Symbol,Series,ISIN Code
   *   Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021
   *   ...
   * Extracts BOTH `Symbol` and `Industry` from every row and resolves
   * the industry to a sector-index token.
   */
  private parseConstituentsCsv(csv: string): StockSectorRow[] {
    const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const headerCols = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const symbolIdx = headerCols.findIndex((c) => c === 'symbol');
    const industryIdx = headerCols.findIndex((c) => c === 'industry');
    if (symbolIdx < 0 || industryIdx < 0) return [];

    const rows: StockSectorRow[] = [];
    const seen = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCsvLine(lines[i]);
      if (cols.length <= Math.max(symbolIdx, industryIdx)) continue;
      const symbol = (cols[symbolIdx] ?? '').trim().toUpperCase();
      const industry = (cols[industryIdx] ?? '').trim();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      rows.push({
        symbol,
        industry,
        sectorIndexToken: this.industryToSectorToken(industry),
      });
    }
    return rows;
  }

  /** Minimal CSV line parser handling quoted fields (company names contain commas). */
  private parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }
}
