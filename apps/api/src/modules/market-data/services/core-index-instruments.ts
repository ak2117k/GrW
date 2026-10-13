import type { UpsertInstrumentInput } from '../repositories/market-data.repository';

/**
 * The index rows the `instruments` table must ALWAYS carry.
 *
 * WHY THIS EXISTS: the master refresh (`InstrumentMasterRefreshCron`) upserts
 * cash equities (blank `instrumenttype`) and live derivative contracts. Index
 * rows are `AMXIDX` in Angel's scrip master and fall through both filters, so
 * the table never held NIFTY/BANKNIFTY/FINNIFTY in production — and the
 * UniverseScannerWorker, LevelBookCron and DailyBackfillWorker all logged
 * "not in instruments table / No instrument row" and skipped them.
 *
 * Built from the shared constants rather than from the master's AMXIDX rows on
 * purpose: the master names indices "Nifty 50" / "Nifty Bank", while every
 * consumer looks up the CANONICAL symbol the app uses everywhere else ('NIFTY'
 * on 'NSE', by symbol in the scanner and by token in the level book and the
 * backfill). The constants are that canonical naming; the master is not.
 *
 * One row per exchange:token, FIRST group wins — so passing INDICES before
 * SECTOR_INDICES makes token 99926009 'BANKNIFTY' (what the scanner and level
 * book look up), not the sector alias 'NIFTY BANK'. Two rows sharing a token
 * would make a token lookup return whichever row the database gave back first.
 *
 * Segment is 'INDEX', the label the scanner's segment filter and
 * scripts/backfill-candles.mjs already use.
 *
 * The concrete list is built in instrument.service.ts (CORE_INDEX_INSTRUMENTS)
 * from packages/shared INDICES + the hub's INDEX_UNDERLYINGS (MIDCPNIFTY) +
 * SECTOR_INDICES.
 */
export interface IndexConstant {
  symbol: string;
  token: string;
  exchange: string;
}

export function buildCoreIndexInstruments(
  ...groups: ReadonlyArray<Readonly<Record<string, IndexConstant>>>
): readonly UpsertInstrumentInput[] {
  const out: UpsertInstrumentInput[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const d of Object.values(group)) {
      if (!d?.symbol || !d.token || !d.exchange) continue;
      const key = `${d.exchange}:${d.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        symbol: d.symbol,
        token: d.token,
        exchange: d.exchange,
        name: d.symbol,
        segment: 'INDEX',
        lotSize: 1,
        tickSize: 0.05,
      });
    }
  }
  return Object.freeze(out);
}

/** Segment labels that count as an index row (the scanner accepts both). */
export const INDEX_SEGMENTS: ReadonlySet<string> = new Set(['INDEX', 'INDICES']);
