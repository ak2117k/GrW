import { analyseInfo, asInfoItems, classifyCommentary, type CommentaryClass, type RefPrices } from './info';
import { prefilter } from './prefilter';
import { parseSignal } from './rule-parser';
import { detectUpdate } from './updates';
import { buildVocabulary } from './vocabulary';

const vocab = buildVocabulary(['RELIANCE-EQ', 'TATAMOTORS-EQ', 'HDFCBANK-EQ', 'INFY-EQ', 'SBIN-EQ', 'OIL-EQ']);
/** Last closes the service would read from candles_1d (NIFTY was ~22,400 in these posts). */
const REFS: RefPrices = new Map([
  ['NIFTY', 22_400],
  ['BANKNIFTY', 51_500],
  ['SENSEX', 81_500],
]);

/** What the intake does with a text post: rule SIGNAL first, then the commentary class (null = pre-filter / LLM path). */
function classify(text: string, refs: RefPrices | null = REFS): CommentaryClass | 'SIGNAL' | 'UPDATE' | null {
  const pf = prefilter(text, vocab);
  if (pf.pass && parseSignal(text, vocab, pf.norm)) return 'SIGNAL';
  const c = classifyCommentary(text, pf, vocab, refs ?? undefined);
  if (c?.kind === 'RECAP') return c;
  if (detectUpdate(text, vocab, pf.norm)) return 'UPDATE';
  return c;
}
const kindOf = (text: string) => {
  const c = classify(text);
  return c === null ? 'NOISE' : typeof c === 'string' ? c : c.kind;
};

describe('INFO — the owner examples (Stock Wale Bhaiyaa Learning Group, 2026-10-24)', () => {
  it('crude + NIFTY conditional → 2 items: crude BULL 110–120, NIFTY BEAR towards 21000 if crude rises', () => {
    const c = classify('AGAR CRUDE OIL AISE HE CHALTA RAHA TOH 110-120$ DUR NAHI   NIFTY 21000 SE DUR NAHI   CRUDE OIL KO RUKNA PADEGA');
    expect(c).toMatchObject({ kind: 'INFO', needsLlm: false });
    expect((c as CommentaryClass).items).toEqual([
      { underlying: 'CRUDEOIL', bias: 'BULL', levels: [110, 120], targetLevel: 110, oi: null, condition: null, horizon: null, kind: 'VIEW' },
      { underlying: 'NIFTY', bias: 'BEAR', levels: [21000], targetLevel: 21000, oi: null, condition: { driver: 'CRUDE', direction: 'UP' }, horizon: null, kind: 'VIEW' },
    ]);
  });

  it('without a reference price the same post is INFO, wants refs, and has no bias (→ LLM fallback)', () => {
    const c = classify('AGAR CRUDE OIL AISE HE CHALTA RAHA TOH 110-120$ DUR NAHI   NIFTY 21000 SE DUR NAHI   CRUDE OIL KO RUKNA PADEGA', null) as CommentaryClass;
    expect(c).toMatchObject({ kind: 'INFO', wantsRefs: true, needsLlm: true });
    expect(c.items.map((i) => i.bias)).toEqual([null, null]);
  });

  it('an un-named NIFTY level off the 50s grid ("22480 se pehle … negative mat hona") is INFO, not NOISE (2026-10-28)', () => {
    const c = classify('22480 se pehle bht jyda negative mat hona guys 🙏 \nOI mix hai abhi toh decision nahi ara hai \nScalping se ho para hai');
    expect(c).toMatchObject({ kind: 'INFO' });
    expect((c as CommentaryClass).items[0]).toMatchObject({ underlying: 'NIFTY', levels: [22480] });
  });

  it('heavy put OI at 22400 acted as support → NIFTY BULL with the OI note', () => {
    const c = classify('Mai khud put lene wala tha   But mai kabhi OI k against nahi jata  22400 pe itna heavy tha k put me ghuse he nahi aur ye natak hua up me toh bach gya');
    expect(c).toMatchObject({ kind: 'INFO', needsLlm: false });
    expect((c as CommentaryClass).items).toEqual([
      { underlying: 'NIFTY', bias: 'BULL', levels: [22400], targetLevel: null, oi: { strike: 22400, side: 'PE', note: 'put OI heavy → support' }, condition: null, horizon: null, kind: 'VIEW' },
    ]);
  });

  it('image caption "22400 ki put oi dekho 3x hai" → NIFTY 22400 PE OI 3x, BULL', () => {
    const c = classify('22400 ki put oi dekho 3x hai . matlab ye sab upar fakne k liye aye hai');
    expect(c).toMatchObject({ kind: 'INFO' });
    expect((c as CommentaryClass).items).toEqual([
      { underlying: 'NIFTY', bias: 'BULL', levels: [22400], targetLevel: null, oi: { strike: 22400, side: 'PE', note: 'put OI 3x → support' }, condition: null, horizon: null, kind: 'VIEW' },
    ]);
  });

  it('US oil rising → NIFTY panic below 22000, horizon months', () => {
    const c = classify(
      "I don't want to put you in tension but if US oil keep on rising thn 22000 ke niche you'll see a panic selling and it will be brutal 😞. Next few months are real test...",
    );
    expect(c).toMatchObject({ kind: 'INFO', needsLlm: false });
    expect((c as CommentaryClass).items).toEqual([
      { underlying: 'NIFTY', bias: 'BEAR', levels: [22000], targetLevel: null, oi: null, condition: { driver: 'CRUDE', direction: 'UP' }, horizon: 'MONTHS', kind: 'VIEW' },
    ]);
  });

  it('the day recap is RECAP (kept, never a signal)', () => {
    expect(kindOf('Live Analysis of 23th OCT\nBANKNIFTY 52000CE 180 TO 260\nMIDCP 13100CE 109 TO 70')).toBe('RECAP');
    expect(kindOf('Live Analysis of 23th OCT … MIDCP 13100CE 109 TO 70')).toBe('RECAP');
  });

  it.each([
    'Good morning guys 🙏🏻 Have a great weekend',
    'OCT BATCH is open … What\'s app us',
    'TODAY BIG OFFER … paid group',
    'JOIN EVENING LIVE: youtube.com/live/abc',
    'LAST 15 DAYS PNL 46,60,239 ++ PROFIT BOOK',
    '#POSITIONAL_UPDATE_421✔️✔️✔️',
  ])('real noise stays NOISE: %s', (text) => expect(kindOf(text)).toBe('NOISE'));
});

type Expect = { kind: 'INFO' | 'NOISE' | 'RECAP'; items?: Array<Record<string, unknown>> };

/** ≥ 15 more fixtures. */
const FIXTURES: Array<[string, Expect]> = [
  ['NIFTY 1000 points jackpot — join premium', { kind: 'NOISE' }],
  ['Join our VIP group for Nifty banknifty calls 99% accuracy', { kind: 'NOISE' }],
  ['Happy Diwali to all members 🪔', { kind: 'NOISE' }],
  ['Nifty was fun today 😂', { kind: 'NOISE' }],
  ['🔥🔥🔥', { kind: 'NOISE' }],
  ['https://t.me/somechannel', { kind: 'NOISE' }],
  ['Nifty bearish below 22000. Join premium for full analysis', { kind: 'INFO', items: [{ underlying: 'NIFTY', bias: 'BEAR', levels: [22000] }] }],
  ['Nifty 22500 resistance, 22200 support', { kind: 'INFO', items: [{ underlying: 'NIFTY', bias: 'NEUTRAL', levels: [22500, 22200] }] }],
  ['Banknifty bearish below 51000', { kind: 'INFO', items: [{ underlying: 'BANKNIFTY', bias: 'BEAR', levels: [51000] }] }],
  ['PCR 1.4 in nifty, put writing at 22300', { kind: 'INFO', items: [{ underlying: 'NIFTY', bias: 'BULL', oi: { strike: 22300, side: 'PE', note: 'put OI writing → support' } }] }],
  ['Heavy call writing at 23000 CE, nifty upside capped', { kind: 'INFO', items: [{ underlying: 'NIFTY', bias: 'BEAR', oi: { strike: 23000, side: 'CE', note: 'call OI heavy → resistance' } }] }],
  ['Gold 75000 tak jayega, badhega', { kind: 'INFO', items: [{ underlying: 'GOLD', bias: 'BULL', levels: [75000], targetLevel: 75000 }] }],
  ['Crude girega 5800 tak', { kind: 'INFO', items: [{ underlying: 'CRUDEOIL', bias: 'BEAR', levels: [5800], targetLevel: 5800 }] }],
  ['NG breakout above 250', { kind: 'INFO', items: [{ underlying: 'NATURALGAS', bias: 'BULL', levels: [250] }] }],
  ['Agar nifty 22000 tootega toh 21500 dekhne ko milega', { kind: 'INFO', items: [{ underlying: 'NIFTY', bias: 'BEAR', levels: [22000, 21500], targetLevel: 21500, condition: null }] }],
  ['Reliance 1300 ke upar bullish, swing view', { kind: 'INFO', items: [{ underlying: 'RELIANCE', bias: 'BULL', levels: [1300], horizon: 'WEEKS' }] }],
  ['Sensex 80000 se dur nahi', { kind: 'INFO', items: [{ underlying: 'SENSEX', bias: 'BEAR', targetLevel: 80000 }] }],
  ['Market me panic selling, nifty 21800 support todega aaj', { kind: 'INFO', items: [{ underlying: 'NIFTY', bias: 'BEAR', levels: [21800], horizon: 'INTRADAY' }] }],
  ['Brent crude 95 ke upar gaya toh nifty 21500 tak girega', { kind: 'INFO', items: [{ underlying: 'NIFTY', bias: 'BEAR', condition: { driver: 'CRUDE', direction: 'UP' } }] }],
  ["Today's result: BANKNIFTY 52000 CE 210 to 340 ✅ NIFTY 22500 PE 95 to 160 ✅", { kind: 'RECAP' }],
  ['Yesterday calls result: RELIANCE 1300 CE 18 to 31 done', { kind: 'RECAP' }],
];

describe('INFO / NOISE / RECAP fixtures', () => {
  it('has at least 15', () => expect(FIXTURES.length).toBeGreaterThanOrEqual(15));

  it.each(FIXTURES)('%s', (text, exp) => {
    const c = classify(text);
    const kind = c === null ? 'NOISE' : typeof c === 'string' ? c : c.kind;
    expect(kind).toBe(exp.kind);
    if (exp.items) expect((c as CommentaryClass).items).toEqual(exp.items.map((i) => expect.objectContaining(i)));
  });

  it('a call with SL/target is never INFO (the parse path keeps it)', () => {
    const pf = prefilter('Nifty bullish, BUY 22400 CE above 120 SL 100 TGT 160', vocab);
    expect(classifyCommentary('Nifty bullish, BUY 22400 CE above 120 SL 100 TGT 160', pf, vocab)).toBeNull();
  });

  it('a bare level with no bias is INFO and asks for the LLM', () => {
    const c = classify('Nifty 22000 pe kya hoga dekhte hai') as CommentaryClass;
    expect(c).toMatchObject({ kind: 'INFO', needsLlm: true, items: [{ underlying: 'NIFTY', bias: null, levels: [22000] }] });
  });

  it('a sector index is INFO without items (no derivatives, never NIFTY)', () => {
    const c = classify('Nifty IT near resistance area. A monthly close above 33000- 33400 levels needed!') as CommentaryClass;
    expect(c).toMatchObject({ kind: 'INFO', reason: 'sector index (no derivatives)', items: [], needsLlm: false });
  });

  it('asInfoItems drops malformed rows', () => {
    expect(asInfoItems([{ underlying: 'NIFTY', bias: 'UP', levels: ['x', 22000] }, { bias: 'BULL' }, null])).toEqual([
      { underlying: 'NIFTY', bias: null, levels: [22000], targetLevel: null, oi: null, condition: null, horizon: null },
    ]);
  });

  it('analyseInfo confidence is higher for named entities with worded bias', () => {
    expect(analyseInfo('Banknifty bearish below 51000', vocab).confidence).toBeGreaterThan(analyseInfo('22000 ke niche panic', vocab).confidence);
  });
});
