import { parseImageSetupConfig } from '../image-setup.config';
import {
  captionResultReason,
  clockCandidates,
  completeInstrument,
  expiryHintOf,
  freshnessOf,
  imageSignalText,
  IMAGE_SETUP_SCHEMA,
  isOptionSell,
  readImageSetupReply,
  validateImageSetup,
  withContractCheck,
  type ImageSetupExtraction,
} from './image-setup';
import { buildVocabulary } from './vocabulary';

const vocab = buildVocabulary(['RELIANCE-EQ', 'SBIN-EQ']);

/** The 2026-11-02 SWB short: NIFTY 03 NOV 2026 23200 PE, entry 87.55, stop 100.50, target 48. */
const SHORT: ImageSetupExtraction = {
  kind: 'NEW_SETUP',
  instrument: { raw: 'NIFTY 03 NOV 2026 23200 PE · NSE FO', underlying: 'NIFTY', expiry: '2026-11-03', strike: 23200, optionType: 'PE', exchange: 'NSE FO' },
  side: 'SELL',
  entry: 87.55,
  stopLoss: 100.5,
  targets: [48],
  currentPrice: 86.1,
  chartTimeframe: '1m',
  screenshotClock: '1:57',
  tool: 'position_tool',
  confidence: 0.9,
  notes: 'short position tool',
};
const LONG: ImageSetupExtraction = { ...SHORT, side: 'BUY', instrument: { ...SHORT.instrument, raw: 'NIFTY 03 NOV 2026 23200 CE', optionType: 'CE' }, entry: 120, stopLoss: 105, targets: [160, 140], currentPrice: 121 };

describe('readImageSetupReply — tolerant to a sloppy model reply', () => {
  it('reads the strict JSON as is', () => {
    expect(readImageSetupReply(JSON.stringify(SHORT))).toEqual(SHORT);
  });

  it('tolerates fences, prose around the object and trailing commas', () => {
    const body = JSON.stringify(SHORT).replace(/}$/, ',}');
    expect(readImageSetupReply('Here is the setup:\n```json\n' + body + '\n```\nHope this helps')).toMatchObject({ kind: 'NEW_SETUP', entry: 87.55 });
  });

  it('coerces printed prices, SHORT/LONG, PUT/CALL, a single target, a 0–100 confidence, kind spelling', () => {
    const r = readImageSetupReply(
      JSON.stringify({ kind: 'new setup', instrument: { raw: 'x', underlying: 'nifty', optionType: 'put', strike: '23,200' }, side: 'short', entry: '₹87.55', stopLoss: '100.50', targets: '48', currentPrice: 'n/a', confidence: 85, tool: 'Position Tool' }),
    );
    expect(r).toMatchObject({ kind: 'NEW_SETUP', side: 'SELL', entry: 87.55, stopLoss: 100.5, targets: [48], currentPrice: null, confidence: 0.85, tool: 'position_tool' });
    expect(r?.instrument).toMatchObject({ underlying: 'NIFTY', optionType: 'PE', strike: 23200, expiry: null });
  });

  it('missing optional fields default (no targets, no notes, unknown tool)', () => {
    expect(readImageSetupReply('{"kind":"NOT_A_SETUP"}')).toMatchObject({ kind: 'NOT_A_SETUP', side: null, targets: [], tool: 'none', confidence: 0, notes: '' });
  });

  it.each([
    ['prose only', 'I see a chart of NIFTY puts'],
    ['an array', '[1,2]'],
    ['broken JSON', '{"kind": "NEW_SETUP", "entry": 87.55'],
    ['unknown kind', '{"kind":"CHART"}'],
    ['no kind', '{"entry": 1}'],
    ['empty', ''],
  ])('%s → null', (_why, text) => expect(readImageSetupReply(text)).toBeNull());

  it('the schema asks for every field', () => {
    expect(IMAGE_SETUP_SCHEMA.required).toEqual(['kind', 'instrument', 'side', 'entry', 'stopLoss', 'targets', 'currentPrice', 'chartTimeframe', 'screenshotClock', 'tool', 'confidence', 'notes']);
  });
});

describe('validateImageSetup — geometry, numbers, instrument', () => {
  it('a SHORT with stop > entry > target is a valid SELL PE call', () => {
    const v = validateImageSetup(SHORT, { caption: '', vocab });
    expect(v).toMatchObject({ kind: 'NEW_SETUP', valid: true, reason: null });
    expect(v.signal).toMatchObject({ underlying: 'NIFTY', instrumentKind: 'PE', strike: 23200, side: 'SELL', entryType: 'AT', entryLow: 87.55, sl: 100.5, targets: [48], expiryHint: { day: 3, month: 11, year: 2026 }, tags: ['IMAGE_SETUP'], confidence: 0.85 });
  });

  it('a LONG mirrors it; targets come back nearest first', () => {
    const v = validateImageSetup(LONG, { caption: '', vocab });
    expect(v).toMatchObject({ valid: true, kind: 'NEW_SETUP' });
    expect(v.signal).toMatchObject({ side: 'BUY', instrumentKind: 'CE', targets: [140, 160] });
  });

  it.each([
    ['SELL with the stop below the entry', { ...SHORT, stopLoss: 80 }, /SELL needs stop > entry > target/],
    ['SELL with a target above the entry', { ...SHORT, targets: [48, 95] }, /levels contradict the side/],
    ['BUY with the stop above the entry', { ...LONG, stopLoss: 130 }, /BUY needs target > entry > stop/],
    ['a side the levels contradict (SELL drawn as a long)', { ...LONG, side: 'SELL' as const }, /levels contradict/],
    ['no side', { ...SHORT, side: null }, /no side/],
    ['no entry', { ...SHORT, entry: null }, /no positive entry/],
    ['a zero stop', { ...SHORT, stopLoss: 0 }, /no positive stop-loss/],
    ['no target', { ...SHORT, targets: [] }, /no positive target/],
    ['a negative target', { ...SHORT, targets: [48, -3] }, /target is not positive/],
    ['a negative current price', { ...SHORT, currentPrice: -1 }, /current price is not positive/],
    ['an unknown underlying', { ...SHORT, instrument: { ...SHORT.instrument, raw: 'FOOBAR 23200 PE', underlying: 'FOOBAR' } }, /unknown underlying FOOBAR/],
    ['a USOIL CFD the model mapped to CRUDEOIL', { ...LONG, instrument: { raw: 'CFDs on WTI Crude Oil · USOIL', underlying: 'CRUDEOIL', expiry: null, strike: null, optionType: null, exchange: null } }, /not an Indian exchange instrument/],
    ['BTCUSD', { ...SHORT, instrument: { raw: 'Bitcoin / U.S. Dollar', underlying: 'BTCUSD', expiry: null, strike: null, optionType: null, exchange: null } }, /not an Indian exchange instrument/],
    ['an option without an expiry', { ...SHORT, instrument: { ...SHORT.instrument, raw: null, expiry: null } }, /expiry unreadable/],
    ['an option without a strike', { ...SHORT, instrument: { ...SHORT.instrument, raw: null, strike: null } }, /without a strike/],
  ])('%s → NOT_A_SETUP with the reason', (_why, read, reason) => {
    const v = validateImageSetup(read as ImageSetupExtraction, { caption: '', vocab });
    expect(v).toMatchObject({ kind: 'NOT_A_SETUP', valid: false, signal: null });
    expect(v.reason).toMatch(reason);
  });

  it('the model\'s NOT_A_SETUP stays, with its note as the reason', () => {
    expect(validateImageSetup({ ...SHORT, kind: 'NOT_A_SETUP', notes: 'P&L screenshot' }, { caption: '', vocab })).toMatchObject({ kind: 'NOT_A_SETUP', valid: false, reason: 'model: P&L screenshot' });
  });

  it('fills the contract from a compact chart symbol (NIFTY261103P23350) or the header text', () => {
    expect(completeInstrument({ raw: 'NIFTY261103P23350', underlying: null, expiry: null, strike: null, optionType: null, exchange: null })).toMatchObject({ underlying: 'NIFTY', expiry: '2026-11-03', strike: 23350, optionType: 'PE' });
    expect(completeInstrument({ raw: 'BANKNIFTY25NOV2654000CE', underlying: null, expiry: null, strike: null, optionType: null, exchange: null })).toMatchObject({ underlying: 'BANKNIFTY', expiry: '25 NOV 2026', strike: 54000, optionType: 'CE' });
    expect(completeInstrument({ raw: 'NIFTY 03 NOV 2026 23200 PE · NSE FO', underlying: null, expiry: null, strike: null, optionType: null, exchange: null })).toMatchObject({ underlying: 'NIFTY', expiry: '03 NOV 2026', strike: 23200, optionType: 'PE' });
  });

  it('an index spot chart (Nifty 50 Index) is a valid read with nothing to trade', () => {
    const spot = { ...LONG, instrument: { raw: 'Nifty 50 Index', underlying: 'NIFTY', expiry: null, strike: null, optionType: null, exchange: 'NSE' }, entry: 23335.95, stopLoss: 23323.95, targets: [23382.4], currentPrice: 23342.45 };
    const v = validateImageSetup(spot, { caption: 'Ye hai before', vocab });
    expect(v).toMatchObject({ kind: 'NEW_SETUP', valid: true, signal: null, untradeable: expect.stringMatching(/index \/ spot/) });
  });

  it('a stock chart is an EQ call; a FUT header a future', () => {
    const stock = { ...LONG, instrument: { raw: 'RELIANCE · NSE', underlying: 'RELIANCE', expiry: null, strike: null, optionType: null, exchange: 'NSE' }, entry: 1400, stopLoss: 1380, targets: [1450], currentPrice: 1401 };
    expect(validateImageSetup(stock, { caption: '', vocab }).signal).toMatchObject({ instrumentKind: 'EQ', underlying: 'RELIANCE', strike: null });
    const fut = { ...stock, instrument: { raw: 'NIFTY NOV FUT', underlying: 'NIFTY', expiry: null, strike: null, optionType: null, exchange: 'NFO' }, entry: 23300, stopLoss: 23250, targets: [23400], currentPrice: 23301 };
    expect(validateImageSetup(fut, { caption: '', vocab }).signal).toMatchObject({ instrumentKind: 'FUT' });
  });

  it('withContractCheck: not in the master → NOT_A_SETUP; master unavailable → unchanged', () => {
    const v = validateImageSetup(SHORT, { caption: '', vocab });
    expect(withContractCheck(v, false)).toMatchObject({ kind: 'NOT_A_SETUP', valid: false, reason: 'contract not found in the instrument master', signal: null });
    expect(withContractCheck(v, null)).toBe(v);
    expect(withContractCheck(v, { tradingsymbol: 'NIFTY03NOV2623200PE' })).toBe(v);
  });
});

describe('kind rules — captions and price', () => {
  it.each([
    ['Target done 👍.  Mauka ayega toh chauka marenge', 'RESULT'],
    ['Guys both target done', 'RESULT'],
    ['target hogya', 'RESULT'],
    ['SL hit 😔', 'RESULT'],
    ['Profit booked', 'RESULT'],
    ['Before and after 💥🙏 in discussion group', 'RESULT'],
    ['', 'NEW_SETUP'],
    ['Sell karo isko', 'NEW_SETUP'],
  ])('a NEW_SETUP captioned %j → %s', (caption, kind) => {
    expect(validateImageSetup(SHORT, { caption, vocab }).kind).toBe(kind);
  });

  it('"before and after" turns only a NEW_SETUP into a RESULT; an UPDATE stays an UPDATE', () => {
    expect(validateImageSetup({ ...SHORT, kind: 'UPDATE', currentPrice: 72.8 }, { caption: 'Before and after', vocab }).kind).toBe('UPDATE');
  });

  it('"target done" makes an UPDATE a RESULT too', () => {
    expect(validateImageSetup({ ...SHORT, kind: 'UPDATE', currentPrice: 49.65 }, { caption: 'Target done 👍', vocab })).toMatchObject({ kind: 'RESULT', reason: expect.stringContaining('caption says "Target done"') });
  });

  it('a NEW_SETUP whose price is already at / through the target or the stop is a RESULT', () => {
    expect(validateImageSetup({ ...SHORT, currentPrice: 47.9 }, { caption: '', vocab })).toMatchObject({ kind: 'RESULT', reason: expect.stringContaining('through the target 48') });
    expect(validateImageSetup({ ...SHORT, currentPrice: 101 }, { caption: '', vocab })).toMatchObject({ kind: 'RESULT', reason: expect.stringContaining('through the stop 100.5') });
    expect(validateImageSetup({ ...LONG, currentPrice: 141 }, { caption: '', vocab }).kind).toBe('RESULT');
  });

  it('captionResultReason ignores ordinary chatter', () => {
    expect(captionResultReason('Nifty 😍 Level nikalna sikho')).toBeNull();
    expect(captionResultReason('Ye blue line hai mera target.')).toBeNull();
  });
});

describe('freshness gate (signal mode)', () => {
  const opts = { maxLagMin: 10, maxDriftPct: 15 };
  const ist = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00+05:30`);

  it('18210: screenshot 1:57, posted 14:19 IST → 22 min stale', () => {
    expect(freshnessOf({ ...SHORT, currentPrice: 72.8 }, ist('14:19'), opts)).toMatchObject({ fresh: false, lagMin: 22, reason: expect.stringContaining('22 min before the post') });
  });

  it('screenshot 2:31, posted 14:35, price near the entry → fresh', () => {
    expect(freshnessOf({ ...SHORT, screenshotClock: '2:31', currentPrice: 84 }, ist('14:35'), opts)).toMatchObject({ fresh: true, lagMin: 4 });
  });

  it('a fresh clock but the price far from the entry (18212: 49.65 vs 87.55) is not fresh', () => {
    expect(freshnessOf({ ...SHORT, screenshotClock: '2:31', currentPrice: 49.65 }, ist('14:35'), opts)).toMatchObject({ fresh: false, reason: expect.stringContaining('43.3% from the entry') });
    expect(freshnessOf({ ...SHORT, screenshotClock: '2:31', currentPrice: 47 }, ist('14:35'), opts)).toMatchObject({ fresh: false, reason: expect.stringContaining('not between') });
  });

  it('the price beyond the stop is not fresh; no current price is not fresh', () => {
    expect(freshnessOf({ ...SHORT, screenshotClock: '2:31', currentPrice: 101 }, ist('14:35'), opts).fresh).toBe(false);
    expect(freshnessOf({ ...SHORT, screenshotClock: '2:31', currentPrice: null }, ist('14:35'), opts)).toMatchObject({ fresh: false, reason: expect.stringContaining('no current price') });
  });

  it('an unreadable clock is not fresh; a small skew the other way is tolerated, more is not', () => {
    expect(freshnessOf({ ...SHORT, screenshotClock: null }, ist('14:35'), opts)).toMatchObject({ fresh: false, lagMin: null });
    expect(freshnessOf({ ...SHORT, screenshotClock: '2:36', currentPrice: 86 }, ist('14:35'), opts)).toMatchObject({ fresh: true, lagMin: -1 });
    expect(freshnessOf({ ...SHORT, screenshotClock: '2:40', currentPrice: 86 }, ist('14:35'), opts).fresh).toBe(false);
  });

  it('reads 12 h and 24 h clocks, with or without AM/PM', () => {
    expect(clockCandidates('1:57')).toEqual([117, 837]);
    expect(clockCandidates('14:31')).toEqual([871]);
    expect(clockCandidates('2:31 PM')).toEqual([871]);
    expect(clockCandidates('9.20 am')).toEqual([560]);
    expect(clockCandidates('nope')).toEqual([]);
    expect(freshnessOf({ ...SHORT, screenshotClock: '9:20', currentPrice: 86 }, ist('09:24'), opts)).toMatchObject({ fresh: true, lagMin: 4 });
  });
});

describe('signal text, expiry text, option writing, config', () => {
  it('the signal text the night review splits on', () => {
    const s = validateImageSetup(SHORT, { caption: '', vocab }).signal!;
    expect(imageSignalText(s)).toBe('[image] SELL NIFTY 23200 PE 03NOV AT 87.55 SL 100.5 T 48');
    expect(isOptionSell(s)).toBe(true);
    expect(isOptionSell({ instrumentKind: 'PE', side: 'BUY' })).toBe(false);
    expect(isOptionSell({ instrumentKind: 'FUT', side: 'SELL' })).toBe(false);
  });

  it.each([
    ['2026-11-03', { day: 3, month: 11, year: 2026 }],
    ['03 NOV 2026', { day: 3, month: 11, year: 2026 }],
    ['3 Nov 26', { day: 3, month: 11, year: 2026 }],
    ['03NOV26', { day: 3, month: 11, year: 2026 }],
    ['25 Nov', { day: 25, month: 11, year: null }],
    ['next week', null],
    [null, null],
  ])('expiry %j', (text, hint) => expect(expiryHintOf(text)).toEqual(hint));

  it('config: observe by default, only the SWB channel, haiku, option SELL off', () => {
    const c = parseImageSetupConfig({});
    expect(c).toMatchObject({ mode: 'observe', model: 'claude-haiku-5-5', dailyCap: 40, minGapMs: 15_000, freshMaxLagMin: 10, maxDriftPct: 15, allowOptionSell: false });
    expect([...c.channels]).toEqual(['cmvkyxugk01kutd01df3yclc6']);
    expect(parseImageSetupConfig({ IMAGE_SETUPS: 'signal', IMAGE_SETUP_CHANNELS: 'a, b', SIGNAL_ALLOW_OPTION_SELL: 'true' })).toMatchObject({ mode: 'signal', allowOptionSell: true });
    expect([...parseImageSetupConfig({ IMAGE_SETUP_CHANNELS: 'a, b' }).channels]).toEqual(['a', 'b']);
    expect(parseImageSetupConfig({ IMAGE_SETUPS: 'off' }).mode).toBe('off');
    expect(parseImageSetupConfig({ IMAGE_SETUPS: 'banana' }).mode).toBe('observe');
  });
});
