import { prefilter } from './prefilter';
import { parseSignal } from './rule-parser';
import { hasTradeInstruction, viewReason } from './view';
import { buildVocabulary } from './vocabulary';

const vocab = buildVocabulary(['RELIANCE-EQ', 'TATAMOTORS-EQ', 'HDFCBANK-EQ', 'INFY-EQ', 'TCS-EQ', 'SBIN-EQ', 'ITC-EQ']);

/** What the intake does with a text post before any LLM: SIGNAL (rule), VIEW, or neither. */
function classify(text: string): { parsed: ReturnType<typeof parseSignal>; view: string | null } {
  const pf = prefilter(text, vocab);
  const parsed = pf.pass ? parseSignal(text, vocab, pf.norm) : null;
  return { parsed, view: parsed ? null : viewReason(pf) };
}

/** Market commentary that must be VIEW: never a signal, never sent to the LLM. */
const VIEWS: string[] = [
  // prod 2026-10-23, Mr. P Investments — was parsed as NIFTY FUT BUY 33000–33400
  'Nifty IT near resistance area. A monthly close above 33000- 33400 levels needed! Volatile time ahead!',
  'Nifty near resistance 26200. A weekly close above 26200-26300 is needed for fresh upside.',
  'BANKNIFTY support at 51500 and resistance at 52800. Expected range 51500-52800 this week.',
  'Nifty Pharma looking strong, breakout above 22500 possible. Mark this level.',
  'Nifty Auto 24000 - 24500 is the key zone, volatile session expected',
  'NIFTY Metal outlook: bullish above 9200, bearish below 8900',
  'Nifty PSU Bank 7000 above sustains then 7300 likely',
  'Nifty FMCG weak below 56000, support 55200',
  'Nifty Realty: if 1000 breaks, then 950 next. View for the week.',
  'My view: Nifty may test 25800-25900 if 26000 is not reclaimed, mark this',
  'NIFTY daily close above 26100 needed for bulls, otherwise 25800 support',
  'Crude oil resistance 5650 and support 5550, volatile on inventory data',
  'Sensex outlook: 84000 is a hurdle, 82500 strong support',
  'Banknifty analysis: above 52500 bullish, below 51800 bearish, sideways in between',
  'NIFTY IT 33000 CE looking good, watch it',
];

describe('VIEW — commentary is never a signal', () => {
  it('has the Nifty IT post and at least 10 more', () => expect(VIEWS.length).toBeGreaterThanOrEqual(11));

  it.each(VIEWS)('%s', (text) => {
    const { parsed, view } = classify(text);
    expect(parsed).toBeNull();
    expect(view).not.toBeNull();
  });

  it('the Nifty IT post is a sector index, never NIFTY', () => {
    const pf = prefilter('Nifty IT near resistance area. A monthly close above 33000- 33400 levels needed! Volatile time ahead!', vocab);
    expect(pf.underlyings).toEqual([]);
    expect(pf.reason).toBe('sector-index');
    expect(viewReason(pf)).toBe('sector index (no derivatives)');
  });
});

describe('index aliases', () => {
  it.each([
    ['Nifty Bank 52000 CE buy above 300 SL 270 TGT 350', 'BANKNIFTY'],
    ['Nifty Fin Service 23500 PE buy 60 SL 45 TGT 80', 'FINNIFTY'],
    ['Finnifty 23500 CE buy 70 SL 55 TGT 90', 'FINNIFTY'],
    ['Nifty Midcap Select 12500 CE buy above 90 SL 75 TGT 110', 'MIDCPNIFTY'],
    ['Midcpnifty 12500 PE buy 80 SL 65 TGT 100', 'MIDCPNIFTY'],
    ['Nifty Next 50 FUT buy 70500 SL 70200 TGT 71000', 'NIFTYNXT50'],
    ['SENSEX 82000 CE buy 180 SL 150 TGT 220', 'SENSEX'],
    ['BANKEX 60000 PE buy 300 SL 260 TGT 360', 'BANKEX'],
  ])('%s → %s', (text, underlying) => {
    expect(classify(text).parsed).toMatchObject({ underlying });
  });

  it.each(['Nifty IT', 'Nifty Pharma', 'Nifty Auto', 'Nifty Metal', 'Nifty Realty', 'Nifty FMCG', 'Nifty PSU Bank', 'Nifty Midcap 100', 'Nifty Smallcap 250'])(
    '%s never resolves to NIFTY, even as a full call',
    (name) => {
      const { parsed, view } = classify(`BUY ${name} FUT above 33000 SL 32800 TGT 33400`);
      expect(parsed).toBeNull();
      expect(view).toBe('sector index (no derivatives)');
    },
  );

  it('a sector index next to a tradeable call does not block the call', () => {
    expect(classify('Nifty IT strong. BUY INFY 1500 CE @ 22 SL 18 TGT 28 32').parsed).toMatchObject({ underlying: 'INFY', strike: 1500 });
  });
});

describe('a rule SIGNAL needs an instruction: verb + (SL or target), or ABOVE/BELOW + SL + target', () => {
  it.each([
    ['"above x" alone', 'NIFTY FUT above 26000'],
    ['"above x" with a target only', 'NIFTY 26000 CE above 120 TGT 150'],
    ['a verb with neither SL nor target', 'BUY NIFTY 26000 CE @ 120'],
    ['a range "needed", no verb', 'NIFTY close above 26000-26100 needed'],
  ])('%s → no rule signal', (_why, text) => expect(classify(text).parsed).toBeNull());

  it.each([
    ['BTST with an SL', 'BTST TATAMOTORS 950 CE 18 SL 14', 'BUY'],
    ['STBT with a target', 'STBT SBIN FUT 820 TGT 808', 'SELL'],
    ['complete tip line without a verb', 'FINNIFTY 23500 PE ABOVE 60 SL 45 TGT 75 90', 'BUY'],
  ])('%s → signal', (_why, text, side) => expect(classify(text).parsed).toMatchObject({ side }));

  it('a call with analysis words but an explicit instruction is not a VIEW', () => {
    const text = 'Nifty holding support, bullish view. Buy 26000 CE @ 120 SL 100 TGT 150';
    expect(hasTradeInstruction(prefilter(text, vocab).norm.tokens)).toBe(true);
    expect(classify(text)).toMatchObject({ parsed: expect.objectContaining({ underlying: 'NIFTY', strike: 26000 }), view: null });
  });
});
