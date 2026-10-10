/**
 * Market-cues records → overnight packet blocks, per window. Pure.
 *
 * Same discipline as every other block: present WITH provenance (the record's
 * own source time, never the review time) or absent WITH the reason. A stale
 * record is still shown — its age is information — but says `status: 'stale'`
 * and why.
 *
 * Which window reads what:
 *   15:45 after-close (NSE)   the previous US close and the US index futures;
 *                             FII/DII and FII OI shown as the PREVIOUS session's,
 *                             today's marked not yet published (NSE publishes
 *                             ~18:00–20:00 IST); no GIFT gap.
 *   23:45 after-close (MCX),  US, FII/DII, FII OI and GIFT Nifty.
 *   08:30 pre-open review,
 *   09:10 pre-open check
 */
import type { Prisma } from '@prisma/client';
import { absent, present, type Block } from '../services/context-packet.service';
import type {
  CueRecord,
  FiiDerivatives,
  FiiDiiCash,
  GiftGap,
  MarketCuesSnapshot,
  UsCueKey,
  UsQuote,
} from '../../market-cues/market-cues.types';
import type { ReviewWindow } from './overnight-calendar';
import { cueBlock, type Cue } from './overnight-evidence';
import type { PreOpenMatch } from './pre-open-check';

const US_LABEL: Record<UsCueKey, { name: string; future: boolean }> = {
  nasdaq: { name: 'Nasdaq Composite', future: false },
  sp500: { name: 'S&P 500', future: false },
  dow: { name: 'Dow Jones Industrial Average', future: false },
  nasdaqFutures: { name: 'Nasdaq-100 futures', future: true },
  sp500Futures: { name: 'S&P 500 futures', future: true },
};

const NOT_YET_FII = 'not yet published (NSE publishes ~18:00–20:00 IST)';
const NOT_YET_FII_OI = 'not yet published (NSE archives the participant-OI file in the evening)';

function isAfterCloseEquity(w: ReviewWindow): boolean {
  return w.kind === 'OVERNIGHT_REVIEW' && w.venue === 'EQUITY';
}

/** One US cue: the index's previous US session close, or the future's overnight quote. */
export function usCueBlock(key: UsCueKey, rec: CueRecord<UsQuote>, now: Date): Block<Cue> {
  const label = US_LABEL[key];
  if (!rec.values) return absent(`${label.name}: ${rec.reason ?? 'no reading'} — US direction is UNSEEN, not flat`);
  const block = cueBlock(
    {
      value: rec.values.last,
      change: rec.values.change,
      changePercent: rec.values.changePercent,
      at: rec.sourceTime,
      basis: label.future ? 'quote time' : 'previous session close',
    },
    `${rec.source}; ${rec.basis}`,
    now,
  );
  if (!block.available) return block;
  return {
    ...block,
    value: {
      ...block.value,
      status: rec.status === 'stale' ? 'stale' : 'ok',
      ...(rec.reason ? { note: rec.reason } : {}),
    },
  };
}

export function fiiFlowsBlock(rec: CueRecord<FiiDiiCash>, window: ReviewWindow, now: Date): Block<Prisma.InputJsonValue> {
  if (!rec.values) {
    return absent(`FII/DII cash flows: ${rec.reason ?? 'no reading'} — FII positioning is UNSEEN`);
  }
  const v = rec.values;
  const todayPending = isAfterCloseEquity(window) || (rec.reason ?? '').includes('not yet published');
  return present(
    {
      session: v.date,
      unit: v.unit,
      fii: { ...v.fii },
      dii: v.dii ? { ...v.dii } : null,
      ...(v.dii ? {} : { diiNote: 'DII not available from this source (the NSDL fallback reports FPI only)' }),
      status: rec.status === 'stale' ? 'stale' : 'ok',
      ...(todayPending ? { todaysFigure: NOT_YET_FII } : {}),
      ...(rec.reason ? { note: rec.reason } : {}),
      ageMinutes: ageMinutes(rec.sourceTime, now),
    },
    `${rec.source}; ${rec.basis}`,
    rec.sourceTime as string,
  );
}

export function fiiDerivativesBlock(rec: CueRecord<FiiDerivatives>, window: ReviewWindow): Block<Prisma.InputJsonValue> {
  if (!rec.values) {
    return absent(`FII index F&O positioning: ${rec.reason ?? 'no reading'} — UNSEEN`);
  }
  const v = rec.values;
  const net = (x: { long: number; short: number }) => ({ long: x.long, short: x.short, net: x.long - x.short });
  const todayPending = isAfterCloseEquity(window) || (rec.reason ?? '').includes('not yet published');
  return present(
    {
      session: v.date,
      unit: v.unit,
      indexFutures: net(v.indexFutures),
      indexCalls: net(v.indexCalls),
      indexPuts: net(v.indexPuts),
      changeVsPreviousSession: v.change
        ? {
            previousSession: v.change.previousDate,
            indexFutures: { ...v.change.indexFutures },
            indexCalls: { ...v.change.indexCalls },
            indexPuts: { ...v.change.indexPuts },
          }
        : null,
      status: rec.status === 'stale' ? 'stale' : 'ok',
      ...(todayPending ? { todaysFile: NOT_YET_FII_OI } : {}),
      ...(rec.reason ? { note: rec.reason } : {}),
    },
    `${rec.source}; ${rec.basis}`,
    rec.sourceTime as string,
  );
}

export function giftNiftyBlock(rec: CueRecord<GiftGap>, window: ReviewWindow, now: Date): Block<Prisma.InputJsonValue> {
  if (isAfterCloseEquity(window)) {
    return absent(
      'GIFT Nifty is read in the 23:45 and 08:30 reviews and the 09:10 check, not at 15:45 — the NSE session ' +
        'has only just closed and GIFT’s evening session has barely begun',
    );
  }
  if (!rec.values) return absent(`GIFT Nifty: ${rec.reason ?? 'no reading'} — the implied opening gap is UNSEEN`);
  const g = rec.values;
  return present(
    {
      gift: g.gift.price,
      giftExpiry: g.gift.expiry,
      giftAt: g.gift.at,
      giftAgeMinutes: ageMinutes(g.gift.at, now),
      giftDayChange: g.gift.dayChange,
      niftyFutureClose: g.niftyFuture?.close ?? null,
      niftyFutureExpiry: g.niftyFuture?.expiry ?? null,
      niftyFutureSession: g.niftyFuture?.sessionDate ?? null,
      gap: g.gap,
      gapPercent: g.gapPercent,
      expiryMatches: g.expiryMatches,
      comparison: g.comparison,
      status: rec.status === 'stale' ? 'stale' : 'ok',
      ...(rec.reason ? { note: rec.reason } : {}),
    },
    `${rec.source}; ${rec.basis}`,
    rec.sourceTime as string,
  );
}

/** The 09:10 check's pre-open figure for this position; absent in every other window. */
export function preOpenGapBlock(
  window: ReviewWindow,
  match: PreOpenMatch | null,
  bookReason: string | null,
  source = 'NSE market-data-pre-open (via market-cues)',
): Block<Prisma.InputJsonValue> {
  if (window.kind !== 'PRE_OPEN_CHECK') {
    return absent(
      'only the 09:10 pre-open check reads an NSE pre-open IEP (orders 09:00–09:08, matched by 09:08); this review runs outside it',
    );
  }
  if (!match) {
    return absent(
      `no pre-open IEP for this position's underlying${bookReason ? ` (${bookReason})` : ''} — the opening level is UNSEEN; ` +
        'NSE index futures and options have no IEP in the verified pre-open source',
    );
  }
  const e = match.entry;
  const gap = Math.round((e.iep - e.previousClose) * 100) / 100;
  return present(
    {
      label: match.label,
      underlying: match.underlying,
      instrument: e.instrument,
      iep: e.iep,
      previousClose: e.previousClose,
      gap,
      gapPercent: Math.round((gap / e.previousClose) * 10000) / 100,
    },
    `${source} — ${e.instrument === 'CASH' ? 'cash-equity' : 'futures'} IEP for ${match.underlying}`,
    e.at,
  );
}

export type OvernightMarketCueBlocks = {
  nasdaq: Block<Cue>;
  sp500: Block<Cue>;
  dow: Block<Cue>;
  nasdaqFutures: Block<Cue>;
  sp500Futures: Block<Cue>;
  giftNifty: Block<Prisma.InputJsonValue>;
  fiiFlows: Block<Prisma.InputJsonValue>;
  fiiDerivatives: Block<Prisma.InputJsonValue>;
};

export function marketCueBlocks(snap: MarketCuesSnapshot, window: ReviewWindow, now: Date): OvernightMarketCueBlocks {
  return {
    nasdaq: usCueBlock('nasdaq', snap.us.nasdaq, now),
    sp500: usCueBlock('sp500', snap.us.sp500, now),
    dow: usCueBlock('dow', snap.us.dow, now),
    nasdaqFutures: usCueBlock('nasdaqFutures', snap.us.nasdaqFutures, now),
    sp500Futures: usCueBlock('sp500Futures', snap.us.sp500Futures, now),
    giftNifty: giftNiftyBlock(snap.gift, window, now),
    fiiFlows: fiiFlowsBlock(snap.fiiDii, window, now),
    fiiDerivatives: fiiDerivativesBlock(snap.fiiOi, window),
  };
}

function ageMinutes(at: string | null, now: Date): number | null {
  const t = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((now.getTime() - t) / 60_000)) : null;
}
