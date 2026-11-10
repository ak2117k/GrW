// apps/api/src/modules/sentinel-executor/domain/uncertain-exit.spec.ts
import { aiExitOrderTag } from './exit-order';
import {
  UNCERTAIN_MIN_AGE_MS,
  UNCERTAIN_RECHECK_GAP_MS,
  decideUncertain,
  sentReferenceMs,
  type UncertainExitRow,
} from './uncertain-exit';
import { UNKNOWN_FATE_REASONS } from './auto-exit.types';
import { ORDER_NOT_FOUND } from './uncertain-exit';

// The 2026-11-10 incident shape: a long MCX put, MARKET SELL 30, answer `{}`.
const SENT = new Date('2026-11-10T13:20:00Z'); // 18:50 IST
const ROW: UncertainExitRow = {
  id: 'r1', userId: 'owner', verdictId: 'trg_cmtrigger1', trackerId: 't1', symbol: 'CRUDEOILM17NOV267950PE',
  exchange: 'MCX', token: '472790', side: 'SELL', quantity: 30, orderType: 'MARKET', reason: 'ORDER_UNCERTAIN',
  brokerMessage: 'no definitive broker answer: {}', orderSentAt: SENT, createdAt: new Date(SENT.getTime() - 3_000),
  updatedAt: new Date(SENT.getTime() + 2_500),
};
const TAG_M = aiExitOrderTag(ROW.verdictId, 'M', 'PRICE_TRIGGER');
const TAG_L = aiExitOrderTag(ROW.verdictId, 'L', 'PRICE_TRIGGER');
const POS_INTACT = [{ exchange: 'MCX', symboltoken: '472790', tradingsymbol: 'CRUDEOILM17NOV267950PE', netqty: '30', producttype: 'CARRYFORWARD', ltp: '61.5', lotsize: '10' }];
const LATER = SENT.getTime() + UNCERTAIN_MIN_AGE_MS;
const base = { row: ROW, book: [] as unknown[], positions: POS_INTACT as unknown[], qtyUnit: 'units' as const, nowMs: LATER, firstNotFoundAtMs: null as number | null };

describe('decideUncertain (exits of unknown fate, 2026-11-10)', () => {
  it('ORDER_NOT_FOUND is not an unknown-fate reason (so it stops blocking)', () => {
    expect(UNKNOWN_FATE_REASONS).not.toContain(ORDER_NOT_FOUND);
  });

  it('our tag in the book and complete ⇒ FILLED with the fill', () => {
    const book = [{ orderid: 'O1', ordertag: TAG_M, status: 'complete', averageprice: '60.2', filledshares: '30', exchorderupdatetime: '10-Nov-2026 18:50:03' }];
    const d = decideUncertain({ ...base, book });
    expect(d).toEqual({
      kind: 'ORDER_FILLED', leg: 'M', tag: TAG_M, orderId: 'O1',
      fill: { status: 'complete', text: '', averagePrice: 60.2, filledQty: 30, fillAt: new Date('2026-11-10T13:20:03Z') },
    });
  });

  it('our tag open (either leg) ⇒ the order exists (PLACED)', () => {
    expect(decideUncertain({ ...base, book: [{ orderid: 'O2', ordertag: TAG_M, status: 'open' }] }))
      .toEqual({ kind: 'ORDER_LIVE', leg: 'M', tag: TAG_M, orderId: 'O2', status: 'open' });
    const limitRow = { ...ROW, orderType: 'LIMIT' };
    expect(decideUncertain({ ...base, row: limitRow, book: [{ orderid: 'O1', ordertag: TAG_M, status: 'rejected' }, { orderid: 'O3', ordertag: TAG_L, status: 'trigger pending' }] }))
      .toMatchObject({ kind: 'ORDER_LIVE', leg: 'L', orderId: 'O3' });
  });

  it('our tag rejected / cancelled ⇒ REJECTED (unblocks)', () => {
    expect(decideUncertain({ ...base, book: [{ orderid: 'O1', ordertag: TAG_M, status: 'rejected', text: 'RMS: margin' }] }))
      .toEqual({ kind: 'ORDER_DEAD', leg: 'M', tag: TAG_M, orderId: 'O1', status: 'rejected', text: 'RMS: margin' });
    expect(decideUncertain({ ...base, book: [{ orderid: 'O1', ordertag: TAG_M, status: 'cancelled' }] }))
      .toMatchObject({ kind: 'ORDER_DEAD', status: 'cancelled' });
  });

  it('the LIMIT leg is the uncertain one once the row reached the fallback: a dead MARKET leg alone is not the answer', () => {
    const limitRow = { ...ROW, orderType: 'LIMIT' };
    const d = decideUncertain({ ...base, row: limitRow, book: [{ orderid: 'O1', ordertag: TAG_M, status: 'rejected' }] });
    expect(d).toMatchObject({ kind: 'NOT_FOUND_FIRST' });
    expect((d as { detail: string }).detail).toContain(TAG_L);
  });

  it('not found + position intact: first check only records; a second ≥ 30 s later says NOT_PLACED', () => {
    const first = decideUncertain(base);
    expect(first.kind).toBe('NOT_FOUND_FIRST');
    expect(decideUncertain({ ...base, nowMs: LATER + UNCERTAIN_RECHECK_GAP_MS - 1, firstNotFoundAtMs: LATER }))
      .toEqual({ kind: 'WAIT', why: 'RECHECK_TOO_SOON', keepStreak: true });
    expect(decideUncertain({ ...base, nowMs: LATER + UNCERTAIN_RECHECK_GAP_MS, firstNotFoundAtMs: LATER }).kind).toBe('NOT_PLACED');
  });

  it('a book with other people\'s orders (no tag of ours) still counts as not found', () => {
    const book = [{ orderid: 'X', ordertag: 'someone', status: 'complete', symboltoken: '472790', exchange: 'MCX' }];
    expect(decideUncertain({ ...base, book }).kind).toBe('NOT_FOUND_FIRST');
  });

  it('never concludes before 60 s after the send (Angel\'s book can lag)', () => {
    expect(decideUncertain({ ...base, nowMs: LATER - 1 })).toEqual({ kind: 'WAIT', why: 'TOO_EARLY', keepStreak: true });
    // No recorded send time ⇒ the row's last write (after the send) is the reference.
    expect(sentReferenceMs({ orderSentAt: null, updatedAt: ROW.updatedAt })).toBe(ROW.updatedAt.getTime());
    expect(decideUncertain({ ...base, row: { ...ROW, orderSentAt: null }, nowMs: LATER })).toMatchObject({ kind: 'WAIT', why: 'TOO_EARLY' });
  });

  it('either read unanswered ⇒ no change, and a pending first "not found" is kept', () => {
    expect(decideUncertain({ ...base, book: null })).toEqual({ kind: 'WAIT', why: 'BOOK_UNANSWERED', keepStreak: true });
    expect(decideUncertain({ ...base, positions: null })).toEqual({ kind: 'WAIT', why: 'POSITIONS_UNANSWERED', keepStreak: true });
  });

  it('position gone ⇒ POSITION_CHANGED (stays blocked)', () => {
    expect(decideUncertain({ ...base, positions: [] })).toEqual({ kind: 'POSITION_CHANGED', detail: 'the position is flat now' });
    expect(decideUncertain({ ...base, positions: [{ ...POS_INTACT[0], netqty: '0' }] }).kind).toBe('POSITION_CHANGED');
  });

  it('position reduced, grown or flipped ⇒ POSITION_CHANGED (stays blocked), even on the second check', () => {
    for (const netqty of ['20', '40', '-30']) {
      const d = decideUncertain({ ...base, positions: [{ ...POS_INTACT[0], netqty }], firstNotFoundAtMs: LATER - UNCERTAIN_RECHECK_GAP_MS });
      expect(d.kind).toBe('POSITION_CHANGED');
    }
  });

  it('a positions answer that cannot be read as this contract resets the streak (never NOT_PLACED)', () => {
    const two = [POS_INTACT[0], { ...POS_INTACT[0], producttype: 'INTRADAY' }];
    expect(decideUncertain({ ...base, positions: two, firstNotFoundAtMs: LATER - UNCERTAIN_RECHECK_GAP_MS }))
      .toEqual({ kind: 'WAIT', why: 'POSITION_UNREADABLE:AMBIGUOUS_POSITION_ROWS', keepStreak: false });
    expect(decideUncertain({ ...base, qtyUnit: undefined })).toMatchObject({ kind: 'WAIT', keepStreak: false });
  });

  it('lots mode compares in lots (the order quantity the executor recorded)', () => {
    const lotsRow = { ...ROW, quantity: 3 };
    expect(decideUncertain({ ...base, row: lotsRow, qtyUnit: 'lots' }).kind).toBe('NOT_FOUND_FIRST');
    expect(decideUncertain({ ...base, row: lotsRow, qtyUnit: 'units' }).kind).toBe('POSITION_CHANGED');
  });

  it('a short position\'s exit (BUY) is matched by sign too', () => {
    const shortRow = { ...ROW, side: 'BUY' };
    expect(decideUncertain({ ...base, row: shortRow, positions: [{ ...POS_INTACT[0], netqty: '-30' }] }).kind).toBe('NOT_FOUND_FIRST');
    expect(decideUncertain({ ...base, row: shortRow }).kind).toBe('POSITION_CHANGED');
  });

  it('a row with no recorded plan (exchange/token/side/quantity) is never concluded', () => {
    for (const patch of [{ exchange: null }, { token: null }, { side: null }, { quantity: null }, { quantity: 0 }]) {
      expect(decideUncertain({ ...base, row: { ...ROW, ...patch } })).toEqual({ kind: 'WAIT', why: 'NO_RECORDED_PLAN', keepStreak: false });
    }
  });

  it('AI and manual rows use their own tag prefixes', () => {
    const ai = { ...ROW, verdictId: 'cmverdict123' };
    const aiTag = aiExitOrderTag(ai.verdictId, 'M', 'AI');
    expect(decideUncertain({ ...base, row: ai, book: [{ orderid: 'O1', ordertag: aiTag, status: 'open' }] }).kind).toBe('ORDER_LIVE');
    // The price-trigger tag does not match an AI row.
    expect(decideUncertain({ ...base, row: ai, book: [{ orderid: 'O1', ordertag: TAG_M, status: 'open' }] }).kind).toBe('NOT_FOUND_FIRST');
    const man = { ...ROW, verdictId: 'man_t1_2' };
    const manTag = aiExitOrderTag(man.verdictId, 'M', 'MANUAL');
    expect(decideUncertain({ ...base, row: man, book: [{ orderid: 'O1', ordertag: manTag, status: 'complete' }] }).kind).toBe('ORDER_FILLED');
    // complete but no order id to read the fill by ⇒ still an order of ours (PLACED, the settler can't help, the block stays)
    expect(decideUncertain({ ...base, row: man, book: [{ ordertag: manTag, status: 'complete' }] }).kind).toBe('ORDER_LIVE');
  });
});
