/**
 * Which positions the 09:12 PRE-OPEN CHECK judges, and what pre-open figure each
 * one is shown. Pure — imports only pure modules and types (see the note at the
 * top of `overnight-calendar.ts`).
 *
 * The pre-open covers what can be priced before the open on NSE: every open NSE
 * F&O FUTURE is checked; an OPTION is checked only when its underlying has an
 * IEP in the book (options themselves have no pre-open). MCX is never checked.
 *
 * LABELLED BY WHAT THE IEP PRICES. The verified NSE pre-open payload carries the
 * CASH pre-open of the F&O securities; a futures row is used as a futures IEP
 * only when the book says it is one. An option's figure is always an ESTIMATE of
 * the underlying's gap, never a price for the option.
 */
import type { SessionClock } from '../../market-hub/session-clock';
import type { PreOpenBook, PreOpenEntry } from '../../market-cues/market-cues.types';
import type { RosterEntry } from '../services/roster.service';
import { segmentFor } from '../charges';
import { PRE_OPEN_CHECK, SENTINEL_CLOCK, selectForWindow } from './overnight-calendar';
import { parseOptionSymbol } from './overnight-evidence';

export interface PreOpenMatch {
  underlying: string;
  entry: PreOpenEntry;
  /** What the figure is, in words the judge reads first. */
  label: string;
}

/** The underlying of a broker F&O tradingsymbol: `RELIANCE27OCT26FUT`, `NIFTY13OCT2625000CE`. Null for anything else. */
export function derivativeUnderlying(symbol: string): string | null {
  const s = String(symbol ?? '').trim().toUpperCase();
  const opt = parseOptionSymbol(s);
  if (opt) return opt.underlying;
  const fut = /^([A-Z&-]+?)\d{2}[A-Z]{3}\d{2}FUT$/.exec(s);
  return fut ? fut[1] : null;
}

export function preOpenMatchFor(e: RosterEntry, book: PreOpenBook | null): PreOpenMatch | null {
  if (!book) return null;
  const underlying = derivativeUnderlying(e.symbol);
  const iep = underlying ? book.entries[underlying] : undefined;
  if (!underlying || !iep) return null;
  const isFuture = segmentFor({ exchange: e.exchange, symbol: e.symbol, kind: e.kind }) === 'FUT';
  let label: string;
  if (isFuture) {
    label =
      iep.instrument === 'FUTURE'
        ? `future IEP — the NSE F&O pre-open price for ${underlying}'s current-month future`
        : `underlying cash pre-open IEP gap estimate — ${underlying} cash equity's IEP vs its previous close, applied to this future (no futures IEP was available)`;
  } else {
    label =
      iep.instrument === 'FUTURE'
        ? `underlying future IEP gap estimate — ${underlying}'s current-month future IEP vs its previous close; options have no pre-open, this is NOT the option's price`
        : `underlying cash pre-open IEP gap estimate — ${underlying} cash equity's IEP vs its previous close; options have no pre-open, this is NOT the option's price`;
  }
  return { underlying, entry: iep, label };
}

/**
 * The 09:12 selection: the window's own filter (NSE venues, F&O, 09:08–09:15,
 * a trading day), then split by whether the position HAS its input.
 *
 * NO INPUT, NO JUDGE CALL. A position whose underlying has no IEP in today's
 * book — every index future and index option on the verified source, or every
 * position when the book is stale or failed — would cost an Opus call to repeat
 * the 08:30 review. It is skipped, with the reason, for the caller to record.
 */
export function selectForPreOpenCheck(
  entries: readonly RosterEntry[],
  book: PreOpenBook | null,
  now: Date,
  clock: SessionClock = SENTINEL_CLOCK,
  bookReason: string | null = null,
): { checked: Array<{ entry: RosterEntry; match: PreOpenMatch }>; skipped: Array<{ entry: RosterEntry; reason: string }> } {
  const checked: Array<{ entry: RosterEntry; match: PreOpenMatch }> = [];
  const skipped: Array<{ entry: RosterEntry; reason: string }> = [];
  for (const e of selectForWindow(entries, PRE_OPEN_CHECK, now, clock)) {
    const match = preOpenMatchFor(e, book);
    if (match) {
      checked.push({ entry: e, match });
      continue;
    }
    const underlying = derivativeUnderlying(e.symbol) ?? e.symbol;
    skipped.push({
      entry: e,
      reason: book
        ? `no pre-open IEP for ${underlying} in today's NSE pre-open book (index F&O has none on the verified source)`
        : (bookReason ?? 'no NSE pre-open book for today'),
    });
  }
  return { checked, skipped };
}
