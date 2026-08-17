import {
  parseMasterExpiry,
  parseMasterStrike,
  parseOptionType,
  toDerivativeInput,
} from './master-contract';

/** A master row in Angel's own shape. */
const row = (over: Record<string, unknown> = {}) => ({
  exch_seg: 'NFO',
  symbol: 'KEI29SEP265800CE',
  token: '120317',
  name: 'KEI',
  expiry: '29SEP2026',
  strike: '580000',
  instrumenttype: 'OPTSTK',
  lotsize: '350',
  tick_size: '5',
  ...over,
});

const TODAY = new Date(2026, 7, 17); // 17 Aug 2026, local

describe('parseMasterExpiry', () => {
  it('reads both four-digit and two-digit years', () => {
    expect(parseMasterExpiry('29SEP2026')).toEqual(new Date(2026, 8, 29));
    expect(parseMasterExpiry('29SEP26')).toEqual(new Date(2026, 8, 29));
    expect(parseMasterExpiry('4SEP2026')).toEqual(new Date(2026, 8, 4));
  });

  it('builds at LOCAL midnight, not UTC', () => {
    // OptionsChainService has an explicit note about this: a local-midnight
    // date run through toISOString() shifts a Monday expiry back to Sunday.
    const d = parseMasterExpiry('29SEP2026')!;
    expect(d.getHours()).toBe(0);
    expect(d.getDate()).toBe(29);
  });

  it('returns null rather than an Invalid Date', () => {
    // A contract whose expiry cannot be read must be skipped, never stored
    // with a date nobody can trust.
    expect(parseMasterExpiry('')).toBeNull();
    expect(parseMasterExpiry(null)).toBeNull();
    expect(parseMasterExpiry('NOTADATE')).toBeNull();
    expect(parseMasterExpiry('29XXX2026')).toBeNull();
  });

  it('rejects a date that would silently roll into the next month', () => {
    // `new Date(2026, 1, 31)` is 3 March, not 31 February.
    expect(parseMasterExpiry('31FEB2026')).toBeNull();
  });
});

describe('parseMasterStrike', () => {
  it('converts PAISE to rupees', () => {
    // 580000 paise is a 5800 strike. Storing the raw number would put a KEI
    // strike at 580000 on a chart whose axis runs near 5,800.
    expect(parseMasterStrike('580000')).toBe(5800);
    expect(parseMasterStrike('2400000')).toBe(24000);
  });

  it('is null for futures and malformed values', () => {
    expect(parseMasterStrike('0')).toBeNull();
    expect(parseMasterStrike('')).toBeNull();
    expect(parseMasterStrike('abc')).toBeNull();
  });
});

describe('parseOptionType', () => {
  it('reads CE/PE from an option tradingsymbol', () => {
    expect(parseOptionType('KEI29SEP265800CE', 'OPTSTK')).toBe('CE');
    expect(parseOptionType('NIFTY28AUG2524000PE', 'OPTIDX')).toBe('PE');
  });

  it('is null for futures, which carry neither', () => {
    expect(parseOptionType('RELIANCE28AUG26FUT', 'FUTSTK')).toBeNull();
  });
});

describe('toDerivativeInput', () => {
  it('maps an option, carrying the UNDERLYING in name', () => {
    // THE FIELD THAT UNBLOCKS THE SENTINEL: resolveUnderlying reads `.name`,
    // and was finding no row at all rather than a row with a bad name.
    expect(toDerivativeInput(row(), TODAY)).toEqual({
      symbol: 'KEI29SEP265800CE',
      token: '120317',
      name: 'KEI',
      exchange: 'NFO',
      segment: 'NFO',
      lotSize: 350,
      tickSize: 5,
      expiry: new Date(2026, 8, 29),
      strike: 5800,
      optionType: 'CE',
    });
  });

  it('keeps a contract expiring TODAY — it trades until the close', () => {
    expect(toDerivativeInput(row({ expiry: '17AUG2026' }), TODAY)).not.toBeNull();
  });

  it('SKIPS an already-expired contract', () => {
    // The master carries every strike of every past expiry. Without this bound
    // the table grows without limit, and the boot cache with it.
    expect(toDerivativeInput(row({ expiry: '16AUG2026' }), TODAY)).toBeNull();
    expect(toDerivativeInput(row({ expiry: '29SEP2020' }), TODAY)).toBeNull();
  });

  it('skips cash rows — those keep their existing path untouched', () => {
    expect(toDerivativeInput(row({ exch_seg: 'NSE', expiry: '' }), TODAY)).toBeNull();
    expect(toDerivativeInput(row({ exch_seg: 'BSE', expiry: '' }), TODAY)).toBeNull();
  });

  it('skips a row with no readable expiry, symbol or token', () => {
    expect(toDerivativeInput(row({ expiry: 'GARBAGE' }), TODAY)).toBeNull();
    expect(toDerivativeInput(row({ symbol: '' }), TODAY)).toBeNull();
    expect(toDerivativeInput(row({ token: '' }), TODAY)).toBeNull();
  });

  it('maps MCX and futures, not just NSE options', () => {
    const fut = toDerivativeInput(
      row({
        exch_seg: 'MCX',
        symbol: 'CRUDEOIL17SEP26FUT',
        name: 'CRUDEOIL',
        instrumenttype: 'FUTCOM',
        strike: '0',
        expiry: '17SEP2026',
      }),
      TODAY,
    );
    expect(fut).toMatchObject({ exchange: 'MCX', name: 'CRUDEOIL', optionType: undefined });
    expect(fut?.strike).toBeUndefined();
  });

  it('falls back to the tradingsymbol when name is missing', () => {
    expect(toDerivativeInput(row({ name: '' }), TODAY)?.name).toBe('KEI29SEP265800CE');
  });

  it('excludes BFO and CDS — a sizing decision, measured', () => {
    // Against the live master: NFO 35,282 + MCX 16,699 live contracts, versus
    // BFO 40,880 + CDS 9,703. All four would take the table from 23,239 rows
    // to 102,564, and every active row is boot memory. No position has ever
    // been held in BSE derivatives or currency.
    expect(toDerivativeInput(row({ exch_seg: 'BFO' }), TODAY)).toBeNull();
    expect(toDerivativeInput(row({ exch_seg: 'CDS' }), TODAY)).toBeNull();
  });
});
