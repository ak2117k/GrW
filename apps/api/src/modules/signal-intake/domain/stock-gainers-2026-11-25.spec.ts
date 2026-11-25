import { prefilter } from './prefilter';
import { parseSignal } from './rule-parser';
import type { ParsedSignal } from './types';
import { buildVocabulary } from './vocabulary';

/**
 * Stock Gainers (SEBI Registered) calls filed INFO in prod (2026-10-26 … 2026-11-25) because the
 * channel's nicknames ("HUL", "Bajaj auto", "Midcp", "INDIANBNK" …) and layouts ("ce.47", "VUEW")
 * were not read. Texts are the stored posts, verbatim. Every target symbol is an NSE cash line in
 * the Angel instrument master (checked 2026-11-25).
 */

const vocab = buildVocabulary([
  'HINDUNILVR-EQ', 'BAJAJ-AUTO-EQ', 'ALKEM-EQ', 'COCHINSHIP-EQ', 'SUNPHARMA-EQ', 'INDIANB-EQ', 'ATHERENERG-EQ',
  'INDUSINDBK-EQ', 'KALYANKJIL-EQ', 'KALYANI-BE', 'KALYANIFRG-BE', 'INDUSTOWER-EQ', 'HINDALCO-EQ', 'BAJAJFINSV-EQ',
  'BAJAJHLDNG-EQ', 'INDIGO-EQ', 'INDHOTEL-EQ', 'IOB-EQ', 'SUNTV-EQ', 'MIDHANI-EQ', 'ZYDUSLIFE-EQ', 'FORTIS-EQ',
]);

const DISCLAIMER =
  'Disclaimer :-\nAbove calls are Not Buy or Sell Levels,These opinions are for educational purposes only, based on research. Consult your financial advisor before investing.';

type Want = Partial<ParsedSignal>;

const CALLS: Array<[string, string, Want]> = [
  ['HUL = HINDUNILVR (2026-11-25 11:17)',
    `HUL\n\nHUL 2060 CE 75-77\n\nSUPPORT 60\n\nVIEW 90\n\n\n${DISCLAIMER}`,
    { underlying: 'HINDUNILVR', instrumentKind: 'CE', strike: 2060, side: 'BUY', entryType: 'RANGE', entryLow: 75, entryHigh: 77, sl: 60, targets: [90] }],
  ['INDUSBANK = INDUSINDBK, VUEW = VIEW (2026-11-20 11:24)',
    `INDUSBANK \n\nINDUSBANK 1000 CE 8++\n\nSUPPORT 3\n\nVUEW 15\n\n\n${DISCLAIMER}`,
    { underlying: 'INDUSINDBK', instrumentKind: 'CE', strike: 1000, side: 'BUY', entryLow: 8, entryHigh: 8, sl: 3, targets: [15] }],
  ['KALYAN JEWELLERS = KALYANKJIL, CMP / Support / For 8+++ (2026-11-19 12:53)',
    'HERO ZERO \n\n\nKALYAN JEWELLERS \n680CE\n\nCMP 4\n\nSupport 1\n\n\nFor 8+++',
    { underlying: 'KALYANKJIL', instrumentKind: 'CE', strike: 680, side: 'BUY', entryLow: 4, entryHigh: 4, sl: 1, targets: [8] }],
  ['Bajaj auto = BAJAJ-AUTO (2026-11-19 11:03)',
    `Bajaj auto 10800 ce 114-116\n\n\nsupport  70\n\n\nview 170\n\n\n\n.${DISCLAIMER}`,
    { underlying: 'BAJAJ-AUTO', instrumentKind: 'CE', strike: 10800, side: 'BUY', entryType: 'RANGE', entryLow: 114, entryHigh: 116, sl: 70, targets: [170] }],
  ['Midcp = MIDCPNIFTY, above range (2026-11-19 10:46)',
    `Midcp\n\nmidcp 14100 ce above 125-130\n\nsupport 90\n\nview 160\n.${DISCLAIMER}`,
    { underlying: 'MIDCPNIFTY', instrumentKind: 'CE', strike: 14100, side: 'BUY', entryLow: 125, entryHigh: 130, sl: 90, targets: [160] }],
  ['Midco = MIDCPNIFTY, PE (2026-11-18 10:23)',
    `Midco 14200 pe 160-170\n\n\nsupport 70\n\nview 240\n.${DISCLAIMER}`,
    { underlying: 'MIDCPNIFTY', instrumentKind: 'PE', strike: 14200, side: 'BUY', entryType: 'RANGE', entryLow: 160, entryHigh: 170, sl: 70, targets: [240] }],
  ['ALKEM LAB = ALKEM, CMP is the entry, "Support 50 points" = stop 145 − 50, no target (2026-11-12 12:33)',
    'Bullish View On \n\nALKEM LAB\n\n5300CE\n\nCMP 145\n\n\nSupport 50 points \nRESULT TODAY',
    { underlying: 'ALKEM', instrumentKind: 'CE', strike: 5300, side: 'BUY', entryLow: 145, entryHigh: 145, sl: 95, targets: [] }],
  ['Midcp = MIDCPNIFTY (2026-11-11 12:58)',
    `Midcp\n\nmidcp 14500 ce 100-110\n\nsupport 50\n\nview 140\n\nholding \n${DISCLAIMER}`,
    { underlying: 'MIDCPNIFTY', instrumentKind: 'CE', strike: 14500, side: 'BUY', entryType: 'RANGE', entryLow: 100, entryHigh: 110, sl: 50, targets: [140] }],
  ['cochinship = COCHINSHIP, contract written twice (2026-11-09 13:08)',
    `cochinship 1280 ce 1280 ce 44-45\n\nsupport 30\n\nview 60\n\n${DISCLAIMER}`,
    { underlying: 'COCHINSHIP', instrumentKind: 'CE', strike: 1280, side: 'BUY', entryType: 'RANGE', entryLow: 44, entryHigh: 45, sl: 30, targets: [60] }],
  ['SUNPHARMA "ce.47" = entry 47 (2026-11-09 10:30)',
    `SUNPHARMA \n\nSUNPHARMA 1920 ce.47\n\n\nsupport 30\n\n\nview 65\nHOLDING \n\n${DISCLAIMER}`,
    { underlying: 'SUNPHARMA', instrumentKind: 'CE', strike: 1920, side: 'BUY', entryLow: 47, entryHigh: 47, sl: 30, targets: [65] }],
  ['INDIAN BNK / INDIANBNK = INDIANB (2026-11-05 11:09)',
    `INDIAN BNK\n\n\nINDIANBNK 880 CE 24\n\n\nSUPPORT 17\n\nVIEW 30\nHOLDING \n\n${DISCLAIMER}`,
    { underlying: 'INDIANB', instrumentKind: 'CE', strike: 880, side: 'BUY', entryLow: 24, entryHigh: 24, sl: 17, targets: [30] }],
  ['ATHER ENERGY = ATHERENERG, full post (2026-10-26 14:27)',
    'OPTION BUYING VIEW \n\nATHER ENERGY 1420CE\n\nCMP 37\n\nSupport 20\n\n\nFor 57+\n\n\nRisky View Due To Result',
    { underlying: 'ATHERENERG', instrumentKind: 'CE', strike: 1420, side: 'BUY', entryLow: 37, entryHigh: 37, sl: 20, targets: [57] }],
];

describe('Stock Gainers calls missed in prod (2026-11-25)', () => {
  it.each(CALLS)('%s', (_why, text, want) => {
    expect(prefilter(text, vocab).pass).toBe(true);
    const got = parseSignal(text, vocab);
    expect(got).not.toBeNull();
    expect(got).toMatchObject(want);
  });

  it.each([
    ['BN study post, CMP + "Must Study" (2026-11-25 09:26)', 'BN\n63500PE\n\nCMP 1165\n\nMust Study \nWith 100 points Support'],
    ['BN "Support 60 points" commentary (2026-11-23 15:02)', 'BN\n\n63000PE\n\nCMP 400+\n\nSupport 60 points'],
  ])('stays commentary: %s', (_why, text) => {
    const pf = prefilter(text, vocab);
    expect(pf.pass ? parseSignal(text, vocab, pf.norm) : null).toBeNull();
  });

  describe('"Support N points" is a distance from the entry; a bare "Support N" is a price', () => {
    it('Support 50 points with CMP 145 → SL 95', () => {
      expect(parseSignal('Bullish View On ALKEM LAB 5300CE CMP 145 Support 50 points', vocab)).toMatchObject({ entryLow: 145, sl: 95 });
    });

    it('Support 50 pts reads the same way', () => {
      expect(parseSignal('Bullish View On ALKEM LAB 5300CE CMP 145 Support 50 pts', vocab)).toMatchObject({ entryLow: 145, sl: 95 });
    });

    it('Support 200 points with CMP 145 → no stop → not a call', () => {
      const text = 'Bullish View On ALKEM LAB 5300CE CMP 145 Support 200 points';
      const pf = prefilter(text, vocab);
      expect(pf.pass ? parseSignal(text, vocab, pf.norm) : null).toBeNull();
    });

    it('a bare "SUPPORT 60" (HUL) is still the stop price 60', () => {
      expect(parseSignal(`HUL\n\nHUL 2060 CE 75-77\n\nSUPPORT 60\n\nVIEW 90\n\n\n${DISCLAIMER}`, vocab)).toMatchObject({ sl: 60 });
    });

    it('with a target: CMP 37 Support 20 points For 57 → SL 17', () => {
      expect(parseSignal('ATHER ENERGY 1420CE CMP 37 Support 20 points For 57', vocab)).toMatchObject({ sl: 17, targets: [57] });
    });
  });

  it.each([
    ['MIDCO alone is not the index', 'Midco results strong, support 140 view 160'],
    ['HUL in prose without a contract', 'HUL results today, support 2400 view 2500'],
  ])('a nickname needs a contract beside it: %s', (_why, text) => {
    const pf = prefilter(text, vocab);
    expect(pf.pass ? parseSignal(text, vocab, pf.norm) : null).toBeNull();
  });
});
