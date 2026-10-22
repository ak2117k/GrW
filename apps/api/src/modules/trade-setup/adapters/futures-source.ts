import type { FutureContract } from '../domain/trade-setup.logic';
import type { FuturesSource } from '../services/trade-setup.service';

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** The master's "DDMMMYYYY" expiry → 'YYYY-MM-DD'; null when it does not parse. */
export function masterExpiry(raw: unknown): string | null {
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(String(raw ?? '').trim().toUpperCase());
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${MONTHS[m[2]]}-${m[1]}`;
}

/** FUTSTK / FUTIDX rows of the Angel NFO master for one underlying name. PURE. */
export function futuresFromMaster(master: readonly Record<string, unknown>[], name: string): FutureContract[] {
  const want = name.trim().toUpperCase();
  const out: FutureContract[] = [];
  for (const r of master) {
    const type = String(r.instrumenttype ?? '').toUpperCase();
    if (type !== 'FUTSTK' && type !== 'FUTIDX') continue;
    if (String(r.name ?? '').trim().toUpperCase() !== want) continue;
    const expiry = masterExpiry(r.expiry);
    if (!expiry) continue;
    out.push({ tradingSymbol: String(r.symbol), token: String(r.token), expiry, lotSize: parseInt(String(r.lotsize ?? '1'), 10) || 1 });
  }
  return out.sort((a, b) => a.expiry.localeCompare(b.expiry));
}

/**
 * The broker's cached instrument master first (options / futures are resolved on demand from it,
 * not from the `instruments` table); the table as a fallback when the master cannot be loaded.
 */
export function makeFuturesSource(
  master: { fetchInstrumentMaster(exchange: string): Promise<any[]> },
  table: (name: string) => Promise<Array<{ symbol: string; token: string; expiry: Date | null; lotSize: number }>>,
): FuturesSource {
  return {
    list: async (name) => {
      try {
        const rows = futuresFromMaster(await master.fetchInstrumentMaster('NFO'), name);
        if (rows.length) return rows;
      } catch {
        // fall through to the table
      }
      return (await table(name))
        .filter((r) => r.expiry)
        .map((r) => ({
          tradingSymbol: r.symbol,
          token: r.token,
          // instruments.expiry is stored at UTC midnight of the IST date.
          expiry: (r.expiry as Date).toISOString().slice(0, 10),
          lotSize: r.lotSize || 1,
        }));
    },
  };
}
