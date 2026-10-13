import { INDICES, SECTOR_INDICES } from '@td/shared/constants';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
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
 * One row per exchange:token. `INDICES` wins over `SECTOR_INDICES`, so token
 * 99926009 is 'BANKNIFTY' (what the scanner and level book look up), not the
 * sector alias 'NIFTY BANK' — two rows sharing a token would make a token
 * lookup return whichever row the database happened to give back first.
 * MIDCPNIFTY is not in the shared INDICES; its token comes from the hub's
 * INDEX_UNDERLYINGS map, the single place the API already defines it.
 *
 * Segment is 'INDEX', the label the scanner's segment filter and
 * scripts/backfill-candles.mjs already use.
 */
export const CORE_INDEX_INSTRUMENTS: readonly UpsertInstrumentInput[] = (() => {
  const out: UpsertInstrumentInput[] = [];
  const seen = new Set<string>();
  const add = (symbol: string, token: string, exchange: string) => {
    const key = `${exchange}:${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ symbol, token, exchange, name: symbol, segment: 'INDEX', lotSize: 1, tickSize: 0.05 });
  };
  for (const d of Object.values(INDICES)) add(d.symbol, d.token, d.exchange);
  for (const d of Object.values(INDEX_UNDERLYINGS)) add(d.symbol ?? '', d.token, d.exchange);
  for (const d of Object.values(SECTOR_INDICES)) add(d.symbol, d.token, d.exchange);
  return Object.freeze(out.filter((r) => r.symbol));
})();

/** Segment labels that count as an index row (the scanner accepts both). */
export const INDEX_SEGMENTS: ReadonlySet<string> = new Set(['INDEX', 'INDICES']);
