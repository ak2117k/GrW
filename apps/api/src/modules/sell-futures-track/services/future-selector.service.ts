import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { ROLL_DAYS } from '../constants';

export interface ResolvedFuture {
  token: string;
  tradingsymbol: string;
  exchange: 'NFO';
  expiry: Date;
  lotSize: number;
}

/**
 * A handful of well-known F&O stocks. Used ONLY to surface a warning when a
 * stock that should have a future fails to resolve (a quiet-miss this codebase
 * is sensitive to — see spec §Risk, the TATAMOTORS gotcha). Not exhaustive and
 * not a gate: resolution is always driven by the live master.
 */
const KNOWN_FNO_SYMBOLS = new Set([
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'TATASTEEL',
  'TATAMOTORS', 'AXISBANK', 'ITC', 'LT', 'BAJFINANCE', 'BAJAJAUTO', 'MARUTI',
  'WIPRO', 'HINDUNILVR', 'KOTAKBANK', 'ADANIENT', 'HCLTECH', 'SUNPHARMA',
]);

/**
 * Stock equity-symbol → nearest tradeable monthly FUTSTK contract on NFO.
 *
 * The linchpin of the SELL-futures track: every short is placed on the
 * resolved future, not the equity. Resolution reuses the adapter's cached
 * instrument master (`fetchInstrumentMaster('NFO')`) and mirrors the
 * filtering pattern of `getOptionContracts`.
 *
 * Matching bridges the equity-symbol ↔ futures-`name` gap two ways so a
 * known-F&O stock isn't silently skipped (spec §Risk):
 *   1. normalized `name` equality (strip -EQ, non-alphanumerics, upper-case);
 *   2. normalized futures `tradingsymbol` prefix (UNDERLYING + expiry digits).
 */
@Injectable()
export class FutureSelectorService {
  private readonly logger = new Logger(FutureSelectorService.name);

  private static readonly MONTHS: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };

  constructor(private readonly adapter: AngelOneAdapterService) {}

  async resolve(symbol: string): Promise<ResolvedFuture | null> {
    const normSym = FutureSelectorService.normalize(symbol);
    if (!normSym) return null;

    let master: any[];
    try {
      master = await this.adapter.fetchInstrumentMaster('NFO');
    } catch (err) {
      this.logger.warn(
        `future-selector: master fetch failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const contracts = master
      .filter((i: any) => i.instrumenttype === 'FUTSTK' && this.matches(i, normSym))
      .map((i: any) => ({
        token: String(i.token),
        tradingsymbol: String(i.symbol),
        exchange: 'NFO' as const,
        expiry: FutureSelectorService.parseExpiry(String(i.expiry ?? '')),
        lotSize: parseInt(String(i.lotsize ?? '1'), 10) || 1,
      }))
      // Keep only non-expired contracts with a valid parsed expiry.
      .filter((c) => !isNaN(c.expiry.getTime()) && c.expiry >= startOfToday)
      .sort((a, b) => a.expiry.getTime() - b.expiry.getTime());

    if (contracts.length === 0) {
      if (KNOWN_FNO_SYMBOLS.has(normSym)) {
        this.logger.warn(
          `future-selector: ${normSym} looks like an F&O stock but no FUTSTK contract resolved ` +
          `(master rename/demerger? — see spec §Risk). Short skipped.`,
        );
      }
      return null;
    }

    // Nearest expiry; roll to next month when within ROLL_DAYS of it.
    let chosen = contracts[0];
    const msToExpiry = chosen.expiry.getTime() - Date.now();
    if (msToExpiry <= ROLL_DAYS * 24 * 60 * 60 * 1000 && contracts.length > 1) {
      chosen = contracts[1];
    }
    return chosen;
  }

  /** Upper-case, trim, strip a trailing -EQ series suffix and any non-alphanumerics. */
  private static normalize(symbol: string): string {
    return String(symbol ?? '')
      .toUpperCase()
      .trim()
      .replace(/-EQ$/, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  private matches(row: any, normSym: string): boolean {
    if (FutureSelectorService.normalize(row.name ?? '') === normSym) return true;
    // Fallback: futures tradingsymbol begins with the underlying followed by an
    // expiry digit (e.g. RELIANCE30JUN26FUT). Bridges renamed `name` fields.
    const sym = FutureSelectorService.normalize(row.symbol ?? '');
    if (sym.startsWith(normSym)) {
      const next = sym.charAt(normSym.length);
      if (next >= '0' && next <= '9') return true;
    }
    return false;
  }

  /**
   * Parse the master's "DDMMMYYYY" expiry (e.g. "30JUN2026") to a local-midnight
   * Date. Prefer the manual parse (engine-independent, clean midnight for the
   * roll-day math); fall back to the native parser only if the format is off.
   */
  private static parseExpiry(raw: string): Date {
    const s = raw.trim();
    const day = parseInt(s.substring(0, 2), 10);
    const mon = FutureSelectorService.MONTHS[s.substring(2, 5).toUpperCase()];
    const year = parseInt(s.substring(5), 10);
    if (!isNaN(day) && mon !== undefined && !isNaN(year)) {
      return new Date(year, mon, day);
    }
    return new Date(s);
  }
}
