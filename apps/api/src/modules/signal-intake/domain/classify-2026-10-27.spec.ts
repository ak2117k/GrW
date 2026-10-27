import { classifyCommentary } from './info';
import { prefilter } from './prefilter';
import { parseSignal } from './rule-parser';
import { normalise } from './text';
import { buildVocabulary } from './vocabulary';

/**
 * Real posts prod stored as NOISE / INFO on 2026-10-21..27 that carried useful information (owner
 * 2026-10-27: "CMP is the current price, support is the support, for is the target — analyse the
 * text that is useful").
 */
const vocab = buildVocabulary([
  'MVELECTRO-EQ', 'KMEW-EQ', 'KROSS-EQ', 'ACUTAAS-EQ', 'SONACOMS-EQ', 'SONATSOFTW-EQ', 'SEJALLTD-EQ', 'ATHERENERG-EQ',
  'PAYTM-EQ', 'NAZARA-EQ', 'RADICO-EQ', 'DIVISLAB-EQ', 'TVSMOTOR-EQ', 'GLOBALVECT-EQ', 'MARKSANS-EQ', 'SUPERHOUSE-EQ', 'TECH-EQ',
  'KPITTECH-EQ', 'STRONGHLD-EQ', 'EXCELINDUS-EQ',
]);

const classify = (text: string) => classifyCommentary(text, prefilter(text, vocab), vocab);
const tokens = (text: string) => normalise(text, vocab).tokens;

describe('loose stock names (company names / nicknames / typos tip channels post)', () => {
  it.each([
    ['two words joined', 'Equity Pick MV ELECTRO CMP 785', 'MVELECTRO'],
    ['joined, cut to the 10-letter NSE symbol', 'Ather energy on fire', 'ATHERENERG'],
    ['a unique start of one symbol, beside a market word', 'SONACOM EXCELLENT RESULTS', 'SONACOMS'],
    ['a unique start, beside a market word', 'SEJAL GLASS LOOKS GAP UP OPENING', 'SEJALLTD'],
    ['one letter off one symbol, beside a market word', 'Very Strong Result By Acutsas Chemical', 'ACUTAAS'],
  ])('%s', (_why, text, symbol) => {
    expect(tokens(text)).toContain(symbol);
  });

  it.each([
    ['common words never become stocks', 'Global markets look strong today', ['GLOBALVECT', 'STRONGHLD']],
    ['a prefix shared by two symbols is not unique', 'SONA results today', ['SONACOMS', 'SONATSOFTW']],
    ['no market word nearby: no loose match', 'Excelle thoughts for the weekend', ['EXCELINDUS']],
    ['a word that is itself a symbol stays itself', 'TECH stocks rally', ['KPITTECH']],
  ])('%s', (_why, text, never) => {
    for (const s of never) expect(tokens(text)).not.toContain(s);
  });
});

describe('cash calls laid out as CMP / Support / For', () => {
  it.each([
    ['Equity Pick', 'Equity Pick MV ELECTRO CMP 785 Support 765 For 820-850', 'MVELECTRO', 785, 765, [820, 850]],
    ['Momentum Stock', 'Momentum Stock \n\nOnly High RS Stock \n\nKMEW\n\nCMP 3300\n\nSupport 3000\n\nFor 3700-4200+', 'KMEW', 3300, 3000, [3700, 4200]],
    ['company suffix LTD', 'Equity Pick \n\nKROSS LTD \n\nCMP 294\n\nSupport 285\n\n\nFor 310-330++', 'KROSS', 294, 285, [310, 330]],
  ])('%s', (_why, text, underlying, entry, sl, targets) => {
    expect(prefilter(text, vocab).pass).toBe(true);
    expect(parseSignal(text, vocab)).toMatchObject({ underlying, instrumentKind: 'EQ', side: 'BUY', entryLow: entry, sl, targets });
  });
});

describe('information kinds', () => {
  const item = (text: string) => {
    const c = classify(text);
    expect(c?.kind).toBe('INFO');
    return c!.items;
  };

  it('a results post is a CATALYST with its direction', () => {
    expect(item('Very Strong Result By Acutsas Chemical')).toEqual([expect.objectContaining({ underlying: 'ACUTAAS', bias: 'BULL', kind: 'CATALYST' })]);
    expect(item('SONACOM EXCELLENT RESULTS 🔥🔥')).toEqual([expect.objectContaining({ underlying: 'SONACOMS', bias: 'BULL', kind: 'CATALYST' })]);
    expect(item('SEJAL GLASS LOOKS GAP UP OPENING')).toEqual([expect.objectContaining({ underlying: 'SEJALLTD', bias: 'BULL', kind: 'CATALYST' })]);
  });

  it('a breakout level / a momentum list is a WATCH', () => {
    expect(item('Radico breakout above 4330')).toEqual([expect.objectContaining({ underlying: 'RADICO', bias: 'BULL', kind: 'WATCH', levels: [4330] })]);
    const list = item('AFTER OPENING \n\nMOMENTUM POSSIBLE IN\n\nATHER ENERGY \nPAYTM \nNAZARA TECH');
    expect(list.map((i) => i.underlying).sort()).toEqual(['ATHERENERG', 'NAZARA', 'PAYTM']);
    expect(list.every((i) => i.kind === 'WATCH' && i.bias === 'BULL')).toBe(true);
  });

  it('a stock view without a level is still information', () => {
    expect(item('Ather energy on fire 🔥🔥')).toEqual([expect.objectContaining({ underlying: 'ATHERENERG', bias: 'BULL' })]);
  });

  it('global / macro news is MACRO, scored against NIFTY', () => {
    const brazil = '🇧🇷 BRAZIL MARKET CRASH! 🚨\n🔹 Lula wins the election.\n🔹 Bolsonaro loses.\n🔹 Brazil ETF (EWZ) falls 20%.';
    expect(item(brazil)).toEqual([expect.objectContaining({ underlying: 'NIFTY', bias: 'BEAR', kind: 'MACRO' })]);
  });

  it('a market-wide view with no stock named is a NIFTY view', () => {
    expect(item('Selling pressure in market')).toEqual([expect.objectContaining({ underlying: 'NIFTY', bias: 'BEAR', kind: 'MARKET' })]);
    expect(item("Bullish Day Possible After Gap Down Opening Let's See")).toEqual([expect.objectContaining({ underlying: 'NIFTY', bias: 'BULL', kind: 'MARKET' })]);
    expect(item('India vix is highly volatile now')).toEqual([expect.objectContaining({ underlying: 'NIFTY', bias: 'NEUTRAL', kind: 'MARKET' })]);
  });

  it('Hinglish "current lag gya" on crude is a spike up', () => {
    expect(item('US oil ko fir current lag gya guys')).toEqual([expect.objectContaining({ underlying: 'CRUDEOIL', bias: 'BULL' })]);
  });
});

describe('brag posts about an option are RECAP, not a view', () => {
  it.each([
    '22750 pe done target',
    '22750 pe 3x hogyi . bola tha wait karo mauka dega fasa kar',
    '22820 se aya maja Double hogyi put Maje karo ab🧿🧿🔥🔥🔥',
  ])('%s', (text) => {
    expect(classify(text)?.kind).toBe('RECAP');
  });
});

describe('still noise', () => {
  it.each([
    'Good morning guys 🙏🏻 Have a great learning day',
    'Levels active ✔️✔️✔️✔️✔️✔️✔️✔️✔️',
    'Super Solid Stock',
    'Its time for the Biggest Sale of the year 🔥 DIWALI SALE 🚀 Starts today at 1pm. Get ready everyone with amazing discounts 🚀',
    'Let market create a strong price action here. Already a good opening done!',
    'One More Earnings Stock On My Radar',
  ])('%s', (text) => {
    const c = classify(text);
    expect(c === null || c.kind === 'NOISE').toBe(true);
  });
});
