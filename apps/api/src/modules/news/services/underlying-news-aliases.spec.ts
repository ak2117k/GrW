import { aliasSymbols, newsKeyFor, UNDERLYING_NEWS_ALIASES } from './underlying-news-aliases';

const tag = (title: string, summary = '') => aliasSymbols(title, summary);

describe('aliasSymbols — commodity and index underlyings from headline keywords', () => {
  it('crude: crude, Brent, WTI, OPEC and oil prices tag CRUDEOIL', () => {
    expect(tag('Crude rises 2% as Middle East tensions flare')).toEqual(['CRUDEOIL']);
    expect(tag('Brent tops $106 a barrel')).toEqual(['CRUDEOIL']);
    expect(tag('WTI futures extend gains')).toEqual(['CRUDEOIL']);
    expect(tag('OPEC+ agrees to deeper output cuts')).toEqual(['CRUDEOIL']);
    expect(tag('Oil prices slip on demand worries')).toEqual(['CRUDEOIL']);
  });

  it('crude: edible oils, crude steel and ordinary "crude" do not', () => {
    expect(tag('India cuts import duty on crude palm oil')).toEqual([]);
    expect(tag('Crude steel output rises 6% in September')).toEqual([]);
    expect(tag('Govt hikes duty on crude soyabean oil and crude sunflower oil')).toEqual([]);
    expect(tag('Edible oil prices ease ahead of festive season')).toEqual([]);
    expect(tag('Oil India shares jump after Q2 results')).toEqual([]);
    expect(tag('ONGC, Oil and Gas stocks in focus')).toEqual([]);
  });

  it('gold: gold and bullion tag GOLD; gold loans and medals do not; Goldman never does', () => {
    expect(tag('Gold prices fall Rs 1,450/10g ahead of US data')).toEqual(['GOLD']);
    expect(tag('Bullion extends slide as dollar firms')).toEqual(['GOLD']);
    expect(tag('Muthoot Finance gold loan book grows 30%')).toEqual([]);
    expect(tag('Neeraj Chopra wins gold medal')).toEqual([]);
    expect(tag('Goldman Sachs upgrades HDFC Bank')).toEqual([]);
  });

  it('silver: silver tags SILVER; a silver lining, jubilee, medal or Silver Lake does not', () => {
    expect(tag('Silver down Rs 1,400/kg despite a soft dollar')).toEqual(['SILVER']);
    expect(tag('A silver lining for auto stocks')).toEqual([]);
    expect(tag('Silver Lake invests $500m in Reliance Retail')).toEqual([]);
    expect(tag('Company celebrates silver jubilee')).toEqual([]);
    expect(tag('Shooter bags silver medal')).toEqual([]);
  });

  it('a headline about both metals tags both, de-duplicated, first-seen order', () => {
    expect(tag('Gold prices fall; silver down too', 'Gold and silver opened lower')).toEqual(['GOLD', 'SILVER']);
  });

  it('natural gas: natural gas, Henry Hub and LNG tag NATURALGAS; Petronet LNG the company does not', () => {
    expect(tag('Natural gas futures slump on mild weather')).toEqual(['NATURALGAS']);
    expect(tag('Henry Hub prices hit two-month low')).toEqual(['NATURALGAS']);
    expect(tag('Asian LNG spot prices climb')).toEqual(['NATURALGAS']);
    expect(tag('Petronet LNG shares rise after Q2 results')).toEqual([]);
  });

  it('copper tags COPPER', () => {
    expect(tag('Copper hits record on supply fears')).toEqual(['COPPER']);
  });

  it('NIFTY: Nifty, NIFTY, Nifty 50 and GIFT Nifty; not the sectoral indices or Bank Nifty; not lowercase "nifty"', () => {
    expect(tag('Nifty ends above 25,000; Sensex gains 400 points')).toEqual(['NIFTY']);
    expect(tag('NIFTY 50 hits record high')).toEqual(['NIFTY']);
    expect(tag('Nifty50 slips in early trade')).toEqual(['NIFTY']);
    expect(tag('GIFT Nifty indicates a flat start')).toEqual(['NIFTY']);
    expect(tag('Nifty IT index falls 2% on weak US cues')).toEqual([]);
    expect(tag('Nifty Midcap 100 outperforms')).toEqual([]);
    expect(tag('Nifty Bank slips 1%')).toEqual(['BANKNIFTY']);
    expect(tag('Bank Nifty options: traders build shorts')).toEqual(['BANKNIFTY']);
    expect(tag('A nifty trick for saving tax')).toEqual([]);
  });

  it('a headline about both indices tags both', () => {
    expect(tag('Nifty, Bank Nifty end lower', '')).toEqual(['NIFTY', 'BANKNIFTY']);
    expect(tag('BANKNIFTY weekly expiry: Nifty IT drags')).toEqual(['BANKNIFTY']);
  });

  it('empty / null input tags nothing', () => {
    expect(aliasSymbols('', '')).toEqual([]);
    expect(aliasSymbols(null as never, undefined as never)).toEqual([]);
  });
});

describe('newsKeyFor — which relatedSymbols key a position underlying is looked up by', () => {
  it('MCX underlyings with an alias map to their key; minis to their parent', () => {
    expect(newsKeyFor('CRUDEOIL', 'MCX')).toEqual({ key: 'CRUDEOIL' });
    expect(newsKeyFor('CRUDEOILM', 'MCX')).toEqual({ key: 'CRUDEOIL' });
    expect(newsKeyFor('GOLDM', 'MCX')).toEqual({ key: 'GOLD' });
    expect(newsKeyFor('GOLDPETAL', 'MCX')).toEqual({ key: 'GOLD' });
    expect(newsKeyFor('SILVERMIC', 'MCX')).toEqual({ key: 'SILVER' });
    expect(newsKeyFor('NATGASMINI', 'MCX')).toEqual({ key: 'NATURALGAS' });
    expect(newsKeyFor('COPPER', 'MCX')).toEqual({ key: 'COPPER' });
  });

  it('an MCX underlying with no alias is UNTAGGABLE, with the reason — never a lookup that must return 0', () => {
    const r = newsKeyFor('ZINC', 'MCX');
    expect(r.key).toBeNull();
    expect((r as { reason: string }).reason).toMatch(/ZINC/);
    expect((r as { reason: string }).reason).toMatch(/never|cannot/i);
  });

  it('indices: NIFTY and BANKNIFTY map; FINNIFTY, MIDCPNIFTY and SENSEX are untaggable', () => {
    expect(newsKeyFor('NIFTY', 'NFO')).toEqual({ key: 'NIFTY' });
    expect(newsKeyFor('BANKNIFTY', 'NFO')).toEqual({ key: 'BANKNIFTY' });
    for (const idx of ['FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX']) expect(newsKeyFor(idx, 'NFO').key).toBeNull();
  });

  it('an equity (cash or stock F&O) is tagged by the listed-symbol index: its own base symbol', () => {
    expect(newsKeyFor('RELIANCE', 'NSE')).toEqual({ key: 'RELIANCE' });
    expect(newsKeyFor('SUZLON-EQ', 'NSE')).toEqual({ key: 'SUZLON' });
    expect(newsKeyFor('RELIANCE', 'NFO')).toEqual({ key: 'RELIANCE' });
    expect(newsKeyFor('kei')).toEqual({ key: 'KEI' });
  });

  it('every alias key is one newsKeyFor can return', () => {
    for (const key of Object.keys(UNDERLYING_NEWS_ALIASES)) expect(newsKeyFor(key, 'MCX').key ?? newsKeyFor(key, 'NFO').key).toBe(key);
  });
});
