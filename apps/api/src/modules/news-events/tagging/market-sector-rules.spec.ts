import { FEED_SECTOR, marketTags, sectorPhraseTags } from './market-sector-rules';

it.each([
  ['indian', 'Markets open flat', ['IN']],
  ['global', 'Asian stocks mixed', ['GLOBAL']],
  ['sector', 'RBI holds repo rate; Fed signals a pause', ['IN', 'GLOBAL']],
  ['company', 'SEBI tightens F&O rules', ['IN']],
  ['company', 'China stimulus lifts metals', ['GLOBAL']],
  ['company', 'Tata Motors recalls 10,000 cars', []],
  ['sector', 'the fed-up investor', []],
])('marketTags(%s, %s)', (category, text, want) => {
  expect(marketTags(category, text)).toEqual(want);
});

it.each([
  ['PSU banks rally on merger talk', ['NIFTY PSU BANK']],
  ['IT stocks drag Nifty', ['NIFTY IT']],
  ['it stocks up', []],
  ['Auto sales rise 12% in September', ['NIFTY AUTO']],
  ['NBFCs face tighter norms', ['NIFTY FIN SERVICE']],
])('sectorPhraseTags(%s)', (text, want) => {
  expect(sectorPhraseTags(text)).toEqual(want);
});

it('feed → sector', () => {
  expect(FEED_SECTOR['ET BFSI']).toEqual(['NIFTY BANK', 'NIFTY FIN SERVICE']);
  expect(FEED_SECTOR['ET Auto']).toEqual(['NIFTY AUTO']);
});
