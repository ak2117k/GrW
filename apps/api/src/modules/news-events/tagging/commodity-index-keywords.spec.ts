import { COMMODITY_KEYWORDS_V2, INDEX_KEYWORDS_V2, keywordTags } from './commodity-index-keywords';
import { INDEX_UNDERLYINGS_V2, MCX_BENCHMARKS_V2, MCX_PARENT_V2, MCX_UNDERLYINGS } from '../keys';

const tag = (t: string) => keywordTags(t);

describe('completeness (spec §5.3)', () => {
  it('every MCX underlying on the (reconciled) master maps to a benchmark with keywords', () => {
    for (const u of MCX_UNDERLYINGS) expect(COMMODITY_KEYWORDS_V2[MCX_PARENT_V2[u] ?? u]?.length ?? 0).toBeGreaterThan(0);
    for (const b of MCX_BENCHMARKS_V2) expect(COMMODITY_KEYWORDS_V2[b]?.length ?? 0).toBeGreaterThan(0);
  });
  it('every index underlying has keywords', () => {
    for (const i of INDEX_UNDERLYINGS_V2) expect(INDEX_KEYWORDS_V2[i]?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('new commodities and their guards', () => {
  it.each([
    ['LME lead prices climb on supply worries', ['LEAD'], []],
    ['Lead futures slip on MCX', ['LEAD'], []],
    ['Infosys to lead the rally in IT', [], []],
    ['HDFC Bank will lead the pack', [], []],
    ['Zinc rallies to a two-year high', ['ZINC'], []],
    ['Hindustan Zinc Q2 profit rises', [], []],
    ['Aluminium prices ease; aluminum stocks fall', ['ALUMINIUM'], []],
    ['Nickel jumps 4% on Indonesia curbs', ['NICKEL'], []],
    ['Company recalls nickel-plated fittings', [], []],
    ['Cotton prices firm on lower arrivals', ['COTTON'], []],
    ['Kapas futures hit upper circuit', ['COTTON'], []],
    ['Cotton shirts sell out', [], []],
    ['Mentha oil gains on export demand', ['MENTHAOIL'], []],
    ['Coal India shares rise; Oil India up 3%', [], []],
  ])('%s', (text, commodities, indices) => {
    expect(tag(text)).toEqual({ commodities, indices });
  });
});

describe('indices', () => {
  it.each([
    ['Sensex falls 500 points', [], ['SENSEX']],
    ['Sensex 50 constituents rejig', [], ['SENSEX50']],
    ['Bankex slips as lenders drag', [], ['BANKEX']],
    ['FinNifty weekly expiry today', [], ['FINNIFTY']],
    ['Nifty Midcap Select options volumes jump', [], ['MIDCPNIFTY']],
    ['Nifty Next 50 index rebalancing', [], ['NIFTYNXT50']],
    ['Nifty ends at record; Bank Nifty lags', [], ['NIFTY', 'BANKNIFTY']],
    ['a nifty little gadget', [], []],
  ])('%s', (text, commodities, indices) => {
    expect(tag(text)).toEqual({ commodities, indices });
  });
});

it('empty text tags nothing', () => {
  expect(keywordTags('   ')).toEqual({ commodities: [], indices: [] });
});
