import {
  ADVERSE_P_V1,
  CALIBRATION_MIN_SAMPLE,
  EXIT_JUSTIFIED_P,
  adverseProbability,
  chainPart,
  componentsOfRecord,
  fitAdverseModel,
  isJustified,
  movePart,
  newsPart,
  qualifyingNews,
  reliabilityTable,
  type AdverseInput,
  type NewsImpactLike,
} from './adverse-probability';
import type { NoiseComponent } from './noise-read';

const AT = new Date('2026-10-30T05:55:00Z');
const comp = (name: NoiseComponent['name'], lean: NoiseComponent['lean'], values?: NoiseComponent['values']): NoiseComponent => ({ name, lean, note: `${name} note`, ...(values ? { values } : {}) });
const news = (over: Partial<NewsImpactLike> = {}): NewsImpactLike => ({
  analysedAt: new Date(AT.getTime() - 20 * 60_000), direction: 'BEAR', magnitude: 'MED', confidence: 0.5, pricedIn: false,
  symbols: ['RELIANCE'], indexName: null, headline: 'Reliance cuts refining guidance', oneLine: 'guidance cut', ...over,
});
const input = (over: Partial<AdverseInput> = {}): AdverseInput => ({ want: 'BULLISH', exitAt: AT, underlying: 'RELIANCE', components: [], news: [], ...over });
const part = (i: AdverseInput, name: string) => adverseProbability(i).parts.find((p) => p.name === name)!;

describe('adverseProbability heuristic-v1 — each part', () => {
  it('MOVE: (moveN − 2.5) × 0.35, clamped to [−0.7, +1.0]; by lean when there is no moveN', () => {
    expect(movePart(comp('MOVE', 'NOISE', { moveN: 1 })).contribution).toBe(-0.525);
    expect(movePart(comp('MOVE', 'NEUTRAL', { moveN: 2.5 })).contribution).toBe(0);
    expect(movePart(comp('MOVE', 'REAL', { moveN: 4 })).contribution).toBe(0.525);
    expect(movePart(comp('MOVE', 'REAL', { moveN: 12 })).contribution).toBe(ADVERSE_P_V1.moveMax);
    expect(movePart(comp('MOVE', 'NOISE', { moveN: 0 })).contribution).toBe(ADVERSE_P_V1.moveMin);
    expect(movePart(comp('MOVE', 'REAL')).contribution).toBe(ADVERSE_P_V1.moveLean.REAL);
    // the candles_1m fallback (no read)
    expect(movePart(null, 5)).toMatchObject({ contribution: 0.875, read: true, note: expect.stringMatching(/candles_1m/) });
  });
  it('CHAIN: OI lean against the position is adverse, signed by want; ±0.8 cap', () => {
    // SENSEX 10-30: PE +3.1 %, CE −0.5 % → bullish lean ≈ +1.8 % = support for a bullish position
    expect(chainPart(comp('CHAIN', 'NOISE', { leanPct: 0.018 }), 'BULLISH').contribution).toBe(-0.72);
    expect(chainPart(comp('CHAIN', 'NOISE', { leanPct: 0.018 }), 'BEARISH').contribution).toBe(0.72);
    expect(chainPart(comp('CHAIN', 'REAL', { leanPct: -0.05 }), 'BULLISH').contribution).toBe(0.8);
    expect(chainPart(comp('CHAIN', 'REAL'), 'BULLISH').contribution).toBe(0.4);
  });
  it('FUTURES / VWAP / VOLUME by lean', () => {
    const i = input({ components: [comp('FUTURES', 'REAL'), comp('VWAP', 'NOISE'), comp('VOLUME', 'REAL')] });
    expect([part(i, 'FUTURES').contribution, part(i, 'VWAP').contribution, part(i, 'VOLUME').contribution]).toEqual([0.6, -0.4, 0.4]);
    const j = input({ components: [comp('FUTURES', 'NOISE'), comp('VWAP', 'REAL'), comp('VOLUME', 'NOISE')] });
    expect([part(j, 'FUTURES').contribution, part(j, 'VWAP').contribution, part(j, 'VOLUME').contribution]).toEqual([-0.6, 0.5, -0.3]);
  });
  it('NEWS: same underlying, directional MED+, not priced in, non-recap, in the 60 min before; against = +, for = −', () => {
    expect(newsPart('BULLISH', 'RELIANCE', AT, [news()]).contribution).toBe(0.4);
    expect(newsPart('BEARISH', 'RELIANCE', AT, [news()]).contribution).toBe(-0.4);
    expect(newsPart('BULLISH', 'RELIANCE', AT, [news({ magnitude: 'HIGH', confidence: 0.75 })]).contribution).toBe(1.0); // 0.7 × 1.5 = 1.05 → cap 1.0
    // filtered out: LOW, NEUTRAL, priced in, a recap headline, another symbol, too early, after the exit
    const out = [
      news({ magnitude: 'LOW' }), news({ direction: 'NEUTRAL' }), news({ pricedIn: true }),
      news({ headline: 'Sensex, Nifty turn lower; broader markets crash as oil tops $116/barrel' }), news({ oneLine: '[recap] x' }),
      news({ symbols: ['TCS'] }), news({ analysedAt: new Date(AT.getTime() - 61 * 60_000) }), news({ analysedAt: new Date(AT.getTime() + 60_000) }),
    ];
    expect(qualifyingNews('RELIANCE', AT, out)).toEqual([]);
    expect(newsPart('BULLISH', 'RELIANCE', AT, out)).toMatchObject({ contribution: 0, read: false });
    expect(newsPart('BULLISH', 'RELIANCE', AT, null)).toMatchObject({ contribution: 0, read: false, note: 'news not read' });
  });
  it('NEWS: an index impact (index_name NIFTY) is read for NIFTY and SENSEX, not for a stock', () => {
    const idx = news({ symbols: [], indexName: 'NIFTY', headline: 'RBI hikes repo rate by 50 bps' });
    expect(qualifyingNews('SENSEX', AT, [idx])).toHaveLength(1);
    expect(qualifyingNews('NIFTY', AT, [idx])).toHaveLength(1);
    expect(qualifyingNews('BANKNIFTY', AT, [idx])).toHaveLength(0);
    expect(qualifyingNews('RELIANCE', AT, [idx])).toHaveLength(0);
  });
});

describe('adverseProbability — sum, clamp, NO_DATA, null', () => {
  it('a transparent log-odds sum: p = sigmoid(prior + Σ contributions)', () => {
    const r = adverseProbability(input({ components: [comp('MOVE', 'REAL', { moveN: 4 }), comp('CHAIN', 'REAL', { leanPct: -0.01 })], news: [news()] }));
    // 0.525 + 0.4 + 0.4 = 1.325 → 0.79
    expect(r).toMatchObject({ basis: 'heuristic-v1', from: 'noise-read', p: 0.79 });
    expect(r.parts.map((p) => p.name)).toEqual(['MOVE', 'CHAIN', 'FUTURES', 'VWAP', 'VOLUME', 'NEWS']);
    expect(isJustified(r.p)).toBe(true);
  });
  it('clamped to [0.05, 0.95]', () => {
    const hi = adverseProbability(input({ components: [comp('MOVE', 'REAL', { moveN: 20 }), comp('CHAIN', 'REAL', { leanPct: -0.1 }), comp('FUTURES', 'REAL'), comp('VWAP', 'REAL'), comp('VOLUME', 'REAL')], news: [news({ magnitude: 'HIGH', confidence: 1 })] }));
    expect(hi.p).toBe(ADVERSE_P_V1.pMax);
    const lo = adverseProbability(input({ components: [comp('MOVE', 'NOISE', { moveN: 0 }), comp('CHAIN', 'NOISE', { leanPct: 0.1 }), comp('FUTURES', 'NOISE'), comp('VWAP', 'NOISE'), comp('VOLUME', 'NOISE')], news: [news({ direction: 'BULL', magnitude: 'HIGH', confidence: 1 })] }));
    expect(lo.p).toBe(ADVERSE_P_V1.pMin);
  });
  it('NO_DATA components contribute 0; a read with only NEUTRAL leans is p 0.5', () => {
    const r = adverseProbability(input({ components: [comp('MOVE', null), comp('CHAIN', null), comp('FUTURES', 'NEUTRAL'), comp('VWAP', null), comp('VOLUME', null)] }));
    expect(r.parts.every((p) => p.contribution === 0)).toBe(true);
    expect(r).toMatchObject({ p: 0.5, from: 'noise-read' });
  });
  it('nothing read (no component with data, no fallback move, no qualifying news) → p null', () => {
    expect(adverseProbability(input({ components: [comp('MOVE', null)], news: [] })).p).toBeNull();
    expect(adverseProbability(input({ components: null, news: null })).p).toBeNull();
    expect(adverseProbability(input({ components: null, news: null })).from).toBe('none');
  });
  it('no read: the candles_1m fallback move (+ news) is the basis; news alone is news-only', () => {
    expect(adverseProbability(input({ components: null, fallbackMoveN: 6, news: [news()] }))).toMatchObject({ from: 'candles_1m', p: 0.802 });
    expect(adverseProbability(input({ components: null, news: [news()] }))).toMatchObject({ from: 'news-only', p: 0.599 });
  });
  it('the threshold is a named constant 0.75; null is never justified', () => {
    expect(EXIT_JUSTIFIED_P).toBe(0.75);
    expect([isJustified(0.75), isJustified(0.749), isJustified(null)]).toEqual([true, false, false]);
  });
  it('a stored read JSONB → components (unknown names / leans dropped to null)', () => {
    const c = componentsOfRecord({ components: [{ name: 'MOVE', lean: 'REAL', note: 'm', values: { moveN: 3.4 } }, { name: 'CHAIN', lean: null, note: 'none' }, { name: 'BOGUS', lean: 'REAL' }] });
    expect(c).toEqual([{ name: 'MOVE', lean: 'REAL', note: 'm', values: { moveN: 3.4 } }, { name: 'CHAIN', lean: null, note: 'none' }]);
    expect(componentsOfRecord(null)).toEqual([]);
  });
});

describe('calibration', () => {
  const sample = (moveN: number, adverse: boolean) => ({ parts: adverseProbability(input({ components: [comp('MOVE', 'NEUTRAL', { moveN })] })).parts, adverse });
  it(`no model under ${CALIBRATION_MIN_SAMPLE} scored exits`, () => {
    expect(fitAdverseModel(Array.from({ length: CALIBRATION_MIN_SAMPLE - 1 }, (_, k) => sample(k % 6, k % 2 === 0)))).toBeNull();
  });
  it('fits a logistic model that a calibrated p then uses (basis calibrated-vN)', () => {
    // big moves continue, small ones revert
    const xs = Array.from({ length: 80 }, (_, k) => sample(k % 8, k % 8 >= 4));
    const m = fitAdverseModel(xs, 2)!;
    expect(m).toMatchObject({ version: 2, n: 80 });
    expect(m.coef.MOVE!).toBeGreaterThan(1);
    const r = adverseProbability(input({ components: [comp('MOVE', 'REAL', { moveN: 7 })], model: m }));
    expect(r.basis).toBe('calibrated-v2');
    expect(r.p!).toBeGreaterThan(0.75);
  });
  it('reliability table buckets 0–0.5, 0.5–0.75, 0.75–1', () => {
    expect(reliabilityTable([{ p: 0.3, adverse: true }, { p: 0.3, adverse: false }, { p: 0.6, adverse: true }, { p: 0.8, adverse: true }, { p: null, adverse: true }, { p: 0.9, adverse: null }])).toEqual([
      { bucket: '0–0.5', n: 2, adverse: 1, rate: 0.5, meanP: 0.3 },
      { bucket: '0.5–0.75', n: 1, adverse: 1, rate: 1, meanP: 0.6 },
      { bucket: '0.75–1', n: 1, adverse: 1, rate: 1, meanP: 0.8 },
    ]);
  });
});
