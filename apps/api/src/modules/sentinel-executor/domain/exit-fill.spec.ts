import { findOrderFill, parseAngelIstTimestamp } from './exit-fill';

describe('parseAngelIstTimestamp', () => {
  it.each([
    ['14-Oct-2026 16:31:05', '2026-10-14T11:01:05.000Z'],
    ['14-OCT-2026 16:31:05', '2026-10-14T11:01:05.000Z'],
    ['2026-10-14 16:31:05', '2026-10-14T11:01:05.000Z'],
    [' 01-Jan-2027 00:00:00 ', '2026-12-31T18:30:00.000Z'],
  ])('%s → %s', (raw, iso) => expect(parseAngelIstTimestamp(raw)!.toISOString()).toBe(iso));
  it.each(['', null, undefined, 'garbage', '32-Oct-2026 16:31:05', '14-Xyz-2026 16:31:05', '14-Oct-2026 24:00:00', '2026-02-30 10:00:00', 12])(
    '%s → null', (raw) => expect(parseAngelIstTimestamp(raw)).toBeNull());
});

describe('findOrderFill', () => {
  const row = { orderid: 'O1', status: 'complete', text: '', averageprice: '527.10', filledshares: '100',
    exchorderupdatetime: '14-Oct-2026 16:31:05', exchtime: '14-Oct-2026 16:31:04', updatetime: '14-Oct-2026 16:31:06' };
  it('reads price, qty and the EXCHANGE update time first', () => {
    expect(findOrderFill([row], 'O1')).toEqual({ status: 'complete', text: '', averagePrice: 527.1, filledQty: 100, fillAt: new Date('2026-10-14T11:01:05Z') });
  });
  it('falls back exchtime → updatetime; zero/blank price ⇒ null', () => {
    expect(findOrderFill([{ ...row, exchorderupdatetime: '' }], 'O1')!.fillAt).toEqual(new Date('2026-10-14T11:01:04Z'));
    expect(findOrderFill([{ ...row, exchorderupdatetime: '', exchtime: '' }], 'O1')!.fillAt).toEqual(new Date('2026-10-14T11:01:06Z'));
    expect(findOrderFill([{ ...row, averageprice: '0' }], 'O1')!.averagePrice).toBeNull();
    expect(findOrderFill([{ ...row, averageprice: '', filledshares: undefined }], 'O1')).toMatchObject({ averagePrice: null, filledQty: null });
  });
  it('orderstatus is read when status is absent; status is lower-cased', () => {
    expect(findOrderFill([{ orderid: 'O1', orderstatus: 'Complete' }], 'O1')).toMatchObject({ status: 'complete', fillAt: null });
  });
  it('unknown order ⇒ null; junk rows never throw', () => {
    expect(findOrderFill([row], 'O2')).toBeNull();
    expect(findOrderFill([null, 'x', 3, row], 'O1')!.averagePrice).toBe(527.1);
  });
});
