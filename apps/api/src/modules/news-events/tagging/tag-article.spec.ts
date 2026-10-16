import { tagArticle } from './tag-article';
import { NameMatcher } from './name-matcher';
import { deriveAliases } from './alias-derivation';

const ctx = {
  matcher: new NameMatcher(deriveAliases([
    { symbol: 'TATAMOTORS', name: 'Tata Motors Limited' },
    { symbol: 'SENCO', name: 'Senco Gold Limited' },
    { symbol: 'HINDZINC', name: 'Hindustan Zinc Limited' },
    { symbol: 'SBIN', name: 'State Bank of India' },
  ], {})),
  listed: new Set(['SBIN', 'TATAMOTORS', 'SENCO', 'HINDZINC', 'NMDC']),
  sectors: { sectorOf: (s: string) => ({ SBIN: 'NIFTY PSU BANK', TATAMOTORS: 'NIFTY AUTO' } as Record<string, string>)[s] ?? null },
};
const t = (title: string, source = 'ET', category = 'company', summary = '') => tagArticle({ title, summary, source, category }, ctx);

it('company by name, with its sector and no market tag for company news', () => {
  expect(t('Tata Motors recalls 10,000 cars')).toEqual({ instruments: ['TATAMOTORS'], sectors: ['NIFTY AUTO'], indices: [], markets: [] });
});
it('name span consumed: Senco Gold is SENCO, not GOLD; Hindustan Zinc is not ZINC', () => {
  expect(t('Senco Gold Q2 profit doubles').instruments).toEqual(['SENCO']);
  expect(t('Hindustan Zinc raises output').instruments).toEqual(['HINDZINC']);
});
it('tickers still work; commodity keyword adds the benchmark and its MCX group', () => {
  expect(t('NMDC raises iron ore prices').instruments).toEqual(['NMDC']);
  expect(t('Gold prices fall as dollar firms', 'ET Commodities', 'sector')).toEqual({ instruments: ['GOLD'], sectors: ['MCX BULLION'], indices: [], markets: [] });
});
it('index, feed sector, phrase sector and market tags', () => {
  expect(t('PSU banks lift Nifty; RBI keeps rates on hold', 'ET BFSI', 'indian')).toEqual({
    instruments: [], sectors: ['NIFTY BANK', 'NIFTY FIN SERVICE', 'NIFTY PSU BANK'], indices: ['NIFTY'], markets: ['IN'],
  });
});
it("forceInstrument (an NSE announcement's own symbol) is first and adds its sector", () => {
  expect(tagArticle({ title: 'Board meeting outcome', summary: '', source: 'NSE Announcements', category: 'company', forceInstrument: 'SBIN' }, ctx))
    .toEqual({ instruments: ['SBIN'], sectors: ['NIFTY PSU BANK'], indices: [], markets: [] });
});
it('an all-caps headline tags no company', () => {
  expect(t('TATA MOTORS RECALLS CARS ACROSS INDIA TODAY').instruments).toEqual([]);
});
