import { deriveAliases, parseEquityL, stripSuffixes } from './alias-derivation';

const rows = [
  { symbol: 'TATAMOTORS', name: 'Tata Motors Limited' },
  { symbol: 'TATASTEEL', name: 'Tata Steel Limited' },
  { symbol: 'HINDZINC', name: 'Hindustan Zinc Limited' },
  { symbol: 'COALINDIA', name: 'Coal India Limited' },
  { symbol: 'OIL', name: 'Oil India Limited' },
  { symbol: 'SENCO', name: 'Senco Gold Limited' },
  { symbol: 'INFY', name: 'Infosys Limited' },
  { symbol: 'WIPRO', name: 'Wipro Limited' },
  { symbol: 'BEL', name: 'Bharat Electronics Limited' },
  { symbol: 'BHARATX', name: 'Bharat Limited' },
  { symbol: 'ABC1', name: 'Twin Name Limited' },
  { symbol: 'ABC2', name: 'Twin Name Ltd.' },
  { symbol: 'GOLDCO', name: 'Gold Limited' },
];
const aliasesOf = (sym: string, out = deriveAliases(rows)) => out.filter((a) => a.symbol === sym).map((a) => a.alias);

it('official name and the suffix-stripped name', () => {
  expect(aliasesOf('TATASTEEL')).toEqual(['Tata Steel', 'Tata Steel Limited']);
  expect(aliasesOf('HINDZINC')).toEqual(['Hindustan Zinc', 'Hindustan Zinc Limited']);
});
it('single-word aliases need ≥ 6 letters and must not be a common word', () => {
  expect(aliasesOf('INFY')).toEqual(['Infosys', 'Infosys Limited']);
  expect(aliasesOf('WIPRO')).toEqual(['Wipro Limited']);
  expect(aliasesOf('BHARATX')).toEqual(['Bharat Limited']);
  expect(aliasesOf('GOLDCO')).toEqual(['Gold Limited']);
});
it('an alias shared by two symbols is dropped (unless curated)', () => {
  const out = deriveAliases(rows);
  expect(out.filter((a) => a.alias === 'Twin Name')).toEqual([]);
  const cur = deriveAliases(rows, { 'Twin Name': 'ABC1' });
  expect(cur.filter((a) => a.alias === 'Twin Name')).toEqual([{ symbol: 'ABC1', alias: 'Twin Name', kind: 'curated' }]);
});
it('curated short forms are added; blocked aliases are removed', () => {
  const out = deriveAliases(rows, { 'L&T': 'LT' }, undefined, new Set(['Coal India']));
  expect(out).toContainEqual({ symbol: 'LT', alias: 'L&T', kind: 'curated' });
  expect(aliasesOf('COALINDIA', out)).toEqual(['Coal India Limited']);
});
it('an all-caps name carries no case signal and yields no alias (tickers cover it)', () => {
  expect(deriveAliases([{ symbol: '360ONE', name: '360 ONE WAM LIMITED' }], {}, undefined, undefined, {})).toEqual([]);
});
it('stripSuffixes removes "(India)", "Ltd." and "& Co" repeatedly', () => {
  expect(stripSuffixes('Bosch (India) Ltd.')).toBe('Bosch');
  expect(stripSuffixes('Shaw Wallace & Co Limited')).toBe('Shaw Wallace');
});
it('parseEquityL reads the NSE header (with its leading spaces) and quoted names', () => {
  const csv = 'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING\n20MICRONS,"20 Microns, Limited",EQ,06-OCT-2008\nTATAMOTORS,Tata Motors Limited,EQ,22-JUL-1998\n';
  expect(parseEquityL(csv)).toEqual([
    { symbol: '20MICRONS', name: '20 Microns, Limited' },
    { symbol: 'TATAMOTORS', name: 'Tata Motors Limited' },
  ]);
});
it('parseEquityL rejects a body that is not EQUITY_L (e.g. an HTML block page)', () => {
  expect(() => parseEquityL('<html><body>Access Denied</body></html>')).toThrow(/header not recognised/);
});

describe('ambiguous parent names (Tata Motors demerger: TMCV commercial, TMPV passenger)', () => {
  // NSE after the demerger: the CV company kept the name "Tata Motors Limited"
  // (TMCV); the old listed entity became "Tata Motors Passenger Vehicles Limited" (TMPV).
  const demerged = [
    { symbol: 'TMCV', name: 'Tata Motors Limited' },
    { symbol: 'TMPV', name: 'Tata Motors Passenger Vehicles Limited' },
  ];
  const owners = (alias: string, out = deriveAliases(demerged)) => out.filter((a) => a.alias === alias).map((a) => a.symbol).sort();

  it('the bare parent name maps to BOTH successors, never to whichever kept the name', () => {
    expect(owners('Tata Motors')).toEqual(['TMCV', 'TMPV']);
    expect(owners('Tata Motors Limited')).toEqual(['TMCV', 'TMPV']);
  });
  it('the specific names stay with their own company', () => {
    expect(owners('Tata Motors Passenger Vehicles')).toEqual(['TMPV']);
    expect(owners('Tata Motors PV')).toEqual(['TMPV']);
    expect(owners('Tata Motors CV')).toEqual(['TMCV']);
    expect(owners('Jaguar Land Rover')).toEqual(['TMPV']);
  });
  it('the ambiguity table is a parameter (empty ⇒ the derived single owner)', () => {
    expect(owners('Tata Motors', deriveAliases(demerged, {}, undefined, undefined, {}))).toEqual(['TMCV']);
  });
});
