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
  expect(aliasesOf('TATAMOTORS')).toEqual(['Tata Motors', 'Tata Motors Limited']);
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
  expect(deriveAliases([{ symbol: '360ONE', name: '360 ONE WAM LIMITED' }], {})).toEqual([]);
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
