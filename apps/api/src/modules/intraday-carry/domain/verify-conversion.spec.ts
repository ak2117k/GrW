import { classifyConvertResponse, convertPositionParams } from '../../auto-execution/services/per-user-broker-session.factory';
import { openRowFor, verifyConversion } from './verify-conversion';

describe('verifyConversion — success is only what a fresh position book shows (the SDK never rejects)', () => {
  const sym = 'NIFTY11NOV2524000CE';
  it('NRML row with full qty → CONVERTED', () => {
    expect(verifyConversion([{ tradingsymbol: sym, producttype: 'CARRYFORWARD', netqty: '75' }], sym, 75)).toBe('CONVERTED');
    expect(verifyConversion([{ tradingsymbol: sym, producttype: 'NRML', netqty: -75 }], sym, 75)).toBe('CONVERTED');
  });
  it('still INTRADAY → NOT_CONVERTED (the broker said "converted" but the book says MIS)', () => {
    expect(verifyConversion([{ tradingsymbol: sym, producttype: 'INTRADAY', netqty: '75' }], sym, 75)).toBe('NOT_CONVERTED');
  });
  it('split rows (part converted) → NOT_CONVERTED', () => {
    expect(
      verifyConversion(
        [
          { tradingsymbol: sym, producttype: 'CARRYFORWARD', netqty: '75' },
          { tradingsymbol: sym, producttype: 'INTRADAY', netqty: '75' },
        ],
        sym,
        150,
      ),
    ).toBe('NOT_CONVERTED');
    expect(verifyConversion([{ tradingsymbol: sym, producttype: 'CARRYFORWARD', netqty: '75' }], sym, 150)).toBe('NOT_CONVERTED');
  });
  it('no row → POSITION_GONE (a flat row counts as none)', () => {
    expect(verifyConversion([], sym, 75)).toBe('POSITION_GONE');
    expect(verifyConversion([{ tradingsymbol: sym, producttype: 'INTRADAY', netqty: '0' }], sym, 75)).toBe('POSITION_GONE');
    expect(verifyConversion([{ tradingsymbol: 'OTHER', producttype: 'CARRYFORWARD', netqty: '75' }], sym, 75)).toBe('POSITION_GONE');
  });
  it('openRowFor: the one open row of a contract, by exchange + token', () => {
    const rows = [{ exchange: 'NFO', symboltoken: '123', netqty: '75' }, { exchange: 'NFO', symboltoken: '9', netqty: '0' }];
    expect(openRowFor(rows, 'nfo', '123')).toBe(rows[0]);
    expect(openRowFor(rows, 'NFO', '9')).toBeNull();
  });
});

describe('classifyConvertResponse — the broker answer is never proof', () => {
  it('status true → accepted; {}, {status:false}, HTTP error, [] → not accepted', () => {
    expect(classifyConvertResponse({ status: true, message: 'SUCCESS' })).toEqual({ accepted: true, message: 'SUCCESS' });
    expect(classifyConvertResponse({}).accepted).toBe(false);
    expect(classifyConvertResponse({ status: false, message: 'Invalid', errorcode: 'AB1001' })).toEqual({ accepted: false, message: 'status false errorcode AB1001 Invalid' });
    expect(classifyConvertResponse({ status: 500, message: 'Internal Server Error' }).accepted).toBe(false);
    expect(classifyConvertResponse([]).accepted).toBe(false);
    expect(classifyConvertResponse(undefined).accepted).toBe(false);
  });
  it('params: the core fields win over the book row extras; old product sent under both spellings', () => {
    const p = convertPositionParams({
      exchange: 'NFO', symboltoken: '123', tradingsymbol: 'X', transactiontype: 'BUY', quantity: 75,
      oldproducttype: 'INTRADAY', newproducttype: 'CARRYFORWARD', extra: { symbolname: 'NIFTY', exchange: 'BAD' },
    });
    expect(p).toMatchObject({ exchange: 'NFO', quantity: '75', oldproducttype: 'INTRADAY', producttype: 'INTRADAY', newproducttype: 'CARRYFORWARD', symbolname: 'NIFTY', type: 'DAY' });
  });
});
