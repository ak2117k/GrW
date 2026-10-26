import { prefilter } from './prefilter';
import { parseSignal } from './rule-parser';
import type { ParsedSignal } from './types';
import { buildVocabulary } from './vocabulary';

const vocab = buildVocabulary([
  'RELIANCE-EQ', 'TATAMOTORS-EQ', 'TATASTEEL-EQ', 'HDFCBANK-EQ', 'SBIN-EQ', 'INFY-EQ', 'ICICIBANK-EQ', 'ITC-EQ',
  'TCS-EQ', 'BEL-EQ', 'IDEA-EQ', 'MCX-EQ', 'BSE-EQ', 'SAIL-EQ', 'ABB-EQ', 'AXISBANK-EQ',
]);

type Want = Partial<ParsedSignal>;

/** ≥ 30 realistic Indian tip formats: text → the fields the parser must produce. */
const FIXTURES: Array<[string, Want]> = [
  ['BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160/200',
    { underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, side: 'BUY', entryType: 'ABOVE', entryLow: 120, entryHigh: 120, sl: 100, targets: [140, 160, 200] }],
  ['BANKNIFTY 52000 PE buy 300-310 sl 270 target 350 400',
    { underlying: 'BANKNIFTY', instrumentKind: 'PE', strike: 52000, side: 'BUY', entryType: 'RANGE', entryLow: 300, entryHigh: 310, sl: 270, targets: [350, 400] }],
  ['Buy TATAMOTORS 950CE @18 sl 14 tgt 22,26',
    { underlying: 'TATAMOTORS', instrumentKind: 'CE', strike: 950, side: 'BUY', entryType: 'AT', entryLow: 18, sl: 14, targets: [22, 26] }],
  ['NIFTY FUT sell below 24050 sl 24120 tgt 23950',
    { underlying: 'NIFTY', instrumentKind: 'FUT', strike: null, side: 'SELL', entryType: 'BELOW', entryLow: 24050, sl: 24120, targets: [23950] }],
  ['RELIANCE cash buy 1250-1255 SL 1238 T1 1270 T2 1285',
    { underlying: 'RELIANCE', instrumentKind: 'EQ', side: 'BUY', entryType: 'RANGE', entryLow: 1250, entryHigh: 1255, sl: 1238, targets: [1270, 1285] }],
  ['🔥🔥 BANKNIFTY 51500 CE 🚀\nBuy above 250\n🎯 280/320\n🛑 220',
    { underlying: 'BANKNIFTY', instrumentKind: 'CE', strike: 51500, entryType: 'ABOVE', entryLow: 250, sl: 220, targets: [280, 320] }],
  ['Nifty 24100 PE kharido 95 ke upar, SL 80, target 110 130',
    { underlying: 'NIFTY', instrumentKind: 'PE', strike: 24100, side: 'BUY', entryType: 'ABOVE', entryLow: 95, sl: 80, targets: [110, 130] }],
  ['HERO ZERO 🦸 NIFTY 24500 CE buy above 5 target 20 40 80 SL 0 (risky)',
    { underlying: 'NIFTY', strike: 24500, entryType: 'ABOVE', entryLow: 5, sl: null, targets: [20, 40, 80], tags: ['HERO_ZERO'] }],
  ['BTST: BUY TATASTEEL 150 CE @ 4.5 SL 3.5 TGT 6/7',
    { underlying: 'TATASTEEL', strike: 150, instrumentKind: 'CE', entryLow: 4.5, sl: 3.5, targets: [6, 7], horizon: 'BTST' }],
  ['SENSEX 82000 CE BUY 180-185 SL 150 TARGET 220/260 #Expiry',
    { underlying: 'SENSEX', strike: 82000, entryType: 'RANGE', entryLow: 180, entryHigh: 185, sl: 150, targets: [220, 260] }],
  ['FINNIFTY 23500 PE ABOVE 60 SL 45 TGT 75 90',
    { underlying: 'FINNIFTY', instrumentKind: 'PE', side: 'BUY', entryType: 'ABOVE', entryLow: 60, sl: 45, targets: [75, 90] }],
  ['BNF 52000 CE buy @ 410 sl 380 tgt 450-480',
    { underlying: 'BANKNIFTY', strike: 52000, entryType: 'AT', entryLow: 410, sl: 380, targets: [450, 480] }],
  ['INFY Buy 1850 SL 1820 Target 1900 1950 Positional',
    { underlying: 'INFY', instrumentKind: 'EQ', entryType: 'AT', entryLow: 1850, sl: 1820, targets: [1900, 1950], horizon: 'POSITIONAL' }],
  ['Sell HDFCBANK FUT below 1680 SL 1700 target 1650/1630',
    { underlying: 'HDFCBANK', instrumentKind: 'FUT', side: 'SELL', entryType: 'BELOW', entryLow: 1680, sl: 1700, targets: [1650, 1630] }],
  ['NIFTY 28 OCT 24000 CE buy above 150 sl 130 tgt 180',
    { underlying: 'NIFTY', strike: 24000, entryLow: 150, sl: 130, targets: [180], expiryHint: { day: 28, month: 10, year: null } }],
  ['NIFTY28OCT2624000CE BUY 150 SL 130 TGT 180 200',
    { underlying: 'NIFTY', strike: 24000, instrumentKind: 'CE', entryLow: 150, sl: 130, targets: [180, 200], expiryHint: { day: 28, month: 10, year: 2026 } }],
  ['Crude oil buy above 5650 sl 5620 target 5700 5750',
    { underlying: 'CRUDEOIL', instrumentKind: 'FUT', side: 'BUY', entryType: 'ABOVE', entryLow: 5650, sl: 5620, targets: [5700, 5750] }],
  ['GOLD FUT sell 72500-72550 SL 72700 TGT 72200',
    { underlying: 'GOLD', instrumentKind: 'FUT', side: 'SELL', entryType: 'RANGE', entryLow: 72500, entryHigh: 72550, sl: 72700, targets: [72200] }],
  ['Buy Nifty 24200 Call @ 110 SL 90 Tgt 130/150',
    { underlying: 'NIFTY', instrumentKind: 'CE', strike: 24200, entryLow: 110, sl: 90, targets: [130, 150] }],
  ['Buy BankNifty 52000 Put above 300 stoploss 270 targets 340, 380',
    { underlying: 'BANKNIFTY', instrumentKind: 'PE', strike: 52000, entryType: 'ABOVE', entryLow: 300, sl: 270, targets: [340, 380] }],
  ['MIDCPNIFTY 12500 CE buy above 90 sl 75 tgt 110',
    { underlying: 'MIDCPNIFTY', strike: 12500, entryLow: 90, sl: 75, targets: [110] }],
  ['STBT SBIN FUT sell below 820 sl 828 tgt 808',
    { underlying: 'SBIN', instrumentKind: 'FUT', side: 'SELL', entryType: 'BELOW', entryLow: 820, sl: 828, targets: [808], horizon: 'BTST' }],
  ['ICICIBANK 1400 CE Buy Range 22-24 Stop Loss 18 Target 30 36 2 Lots',
    { underlying: 'ICICIBANK', strike: 1400, entryType: 'RANGE', entryLow: 22, entryHigh: 24, sl: 18, targets: [30, 36], qty: 2 }],
  ['NIFTY 24000 PE BUY 120 SL 100 TGT 140 QTY 75',
    { underlying: 'NIFTY', instrumentKind: 'PE', entryLow: 120, sl: 100, targets: [140], qty: 75 }],
  ['Bank Nifty 51800 PE ➡ BUY ABOVE 280, SL - 250, TGT - 320 / 360 / 400',
    { underlying: 'BANKNIFTY', strike: 51800, instrumentKind: 'PE', entryType: 'ABOVE', entryLow: 280, sl: 250, targets: [320, 360, 400] }],
  ['TATAMOTORS FUT long 960 sl 950 tgt 975 990',
    { underlying: 'TATAMOTORS', instrumentKind: 'FUT', side: 'BUY', entryLow: 960, sl: 950, targets: [975, 990] }],
  ['Buy ITC 2nd Nov 430 CE @ 6.5 SL 5 Target 8, 10',
    { underlying: 'ITC', strike: 430, instrumentKind: 'CE', entryLow: 6.5, sl: 5, targets: [8, 10], expiryHint: { day: 2, month: 11, year: null } }],
  ['NIFTY 24000 CE BUY ABOVE 120 TGT 140 160',
    { underlying: 'NIFTY', entryLow: 120, sl: null, targets: [140, 160], confidence: 0.75 }],
  ['Sell NIFTY 24500 CE at 80-85 SL 100 target 60 40',
    { underlying: 'NIFTY', side: 'SELL', instrumentKind: 'CE', entryType: 'RANGE', entryLow: 80, entryHigh: 85, sl: 100, targets: [60, 40] }],
  ['intraday: RELIANCE buy above 1262 sl 1255 tgt 1270 1278 1285',
    { underlying: 'RELIANCE', instrumentKind: 'EQ', entryType: 'ABOVE', entryLow: 1262, sl: 1255, targets: [1270, 1278, 1285], horizon: 'INTRADAY' }],
  ['BUY 1 LOT NIFTY 24300 PE ABOVE 140 SL 125 TGT 160/180',
    { underlying: 'NIFTY', strike: 24300, instrumentKind: 'PE', entryLow: 140, sl: 125, targets: [160, 180], qty: 1 }],
  ['BANKNIFTY 52000 CE 🟢 BUY ➡ 310 - 320 🛑 SL 290 🎯 TGT 350++',
    { underlying: 'BANKNIFTY', entryType: 'RANGE', entryLow: 310, entryHigh: 320, sl: 290, targets: [350] }],
  ['SBIN NOV 800 CE buy 12 sl 9 tgt 15 18 20',
    { underlying: 'SBIN', strike: 800, entryLow: 12, sl: 9, targets: [15, 18, 20], expiryHint: { day: null, month: 11, year: null } }],
  ['Nifty 24,000 CE buy above ₹120 | SL ₹105 | Target ₹135 / ₹150',
    { underlying: 'NIFTY', strike: 24000, entryType: 'ABOVE', entryLow: 120, sl: 105, targets: [135, 150] }],
  ['📢 Swing call: AXISBANK buy around 1180-1190, stop loss 1150, targets 1240 / 1280 (2-3 weeks)',
    { underlying: 'AXISBANK', instrumentKind: 'EQ', entryType: 'RANGE', entryLow: 1180, entryHigh: 1190, sl: 1150, targets: [1240, 1280], horizon: 'POSITIONAL' }],
  ['NF 24050 PE abv 88 sl 72 tgt 100-115-130',
    { underlying: 'NIFTY', strike: 24050, instrumentKind: 'PE', entryType: 'ABOVE', entryLow: 88, sl: 72, targets: [100, 115, 130] }],
];

describe('rule parser — tip fixtures', () => {
  it('has at least 30 fixtures', () => expect(FIXTURES.length).toBeGreaterThanOrEqual(30));

  it.each(FIXTURES)('%s', (text, want) => {
    expect(prefilter(text, vocab).pass).toBe(true);
    const got = parseSignal(text, vocab);
    expect(got).not.toBeNull();
    expect(got).toMatchObject(want);
  });
});

describe('rule parser — calls missed in prod on 2026-10-26', () => {
  const prodVocab = buildVocabulary(['HAL-EQ', 'ATHERENERG-EQ', 'FORTIS-EQ', 'INDIGO-EQ', 'ZYDUSLIFE-EQ', 'DRREDDY-EQ']);

  it.each<[string, string, Want]>([
    ['Unicode bold letters (MCX COMODITY CALL OPTION)',
      '🔝𝗕𝘂𝘆 𝗖𝗿𝘂𝗱𝗲 𝗼𝗶𝗹 10700 CE (𝟭𝟳 𝗡𝗼𝘃 𝗘𝘅) ✔️𝗕𝘂𝘆:-  225/230 💥𝗧𝗮𝗿𝗴𝗲𝘁:- you ⚠️𝗦𝗹:- you #𝐅𝐫𝐞𝐞_𝐉𝐚𝐜𝐤𝐩𝐨𝐭_𝐃𝐞𝐦𝐨 👍',
      { underlying: 'CRUDEOIL', instrumentKind: 'CE', strike: 10700, side: 'BUY', entryType: 'RANGE', entryLow: 225, entryHigh: 230, sl: null, targets: [], expiryHint: { day: 17, month: 11, year: null } }],
    ['strike + PE ABOVE premium, no verb / SL / target (MCX COMMODITY)',
      '▶️ BANKNIFTY 54400 PE 27 OCT 📈ABOVE  387 🙏🙏🙏',
      { underlying: 'BANKNIFTY', instrumentKind: 'PE', strike: 54400, side: 'BUY', entryType: 'ABOVE', entryLow: 387, sl: null, targets: [], expiryHint: { day: 27, month: 10, year: null } }],
    ['channel nickname HEL = HAL',
      '▶️ #HEL 4700 PE 🛒 ABOVE - 64   📈#STOCK_OPTIONS 📊 #OCTOBER',
      { underlying: 'HAL', instrumentKind: 'PE', strike: 4700, side: 'BUY', entryType: 'ABOVE', entryLow: 64 }],
    ['Stock Gainers CMP / Support / For',
      'OPTION BUYING VIEW ATHER ENERGY 1420CE CMP 37 Support 20 For 57+ Risky View Due To Result',
      { underlying: 'ATHERENERG', instrumentKind: 'CE', strike: 1420, side: 'BUY', entryLow: 37, sl: 20, targets: [57] }],
    ['Stock Gainers cash above / support / view, disclaimer ignored',
      'Fortis Fortis cash above 731 support 720 view 740 Disclaimer :- Above calls are Not Buy or Sell Levels,These opinions are for educational purposes only',
      { underlying: 'FORTIS', instrumentKind: 'EQ', side: 'BUY', entryType: 'ABOVE', entryLow: 731, sl: 720, targets: [740] }],
    ['Stock Gainers option range / support / view with no verb',
      'ZYDUSLIFE ZYDUSLIFE 1140 ce 15-16 support 9 view 21 HOLDING Disclaimer :- Above calls are Not Buy or Sell Levels,These opinions are for educational purposes only',
      { underlying: 'ZYDUSLIFE', instrumentKind: 'CE', strike: 1140, side: 'BUY', entryType: 'RANGE', entryLow: 15, entryHigh: 16, sl: 9, targets: [21] }],
  ])('%s', (_why, text, want) => {
    expect(prefilter(text, prodVocab).pass).toBe(true);
    const got = parseSignal(text, prodVocab);
    expect(got).not.toBeNull();
    expect(got).toMatchObject(want);
  });

  it.each([
    ['an ABOVE level at or past the strike is a level, not a premium', 'BANKNIFTY 54000 PE ABOVE 54100'],
    ['a bare option update with no entry word', 'ZYDUSLIFE 18🔥🚀🚀 modify support 16'],
    ['option range with no side whose SL is above the entry', 'ZYDUSLIFE 1140 ce 15-16 support 18 view 21'],
    ['a results brag "37 TO 77" is a move, not an entry range', 'OPTION BUYING VIEW ATHER ENERGY 1420CE 37 TO 77 🔥🔥 BLOCKBUSTER MOVE ENJOY'],
  ])('still refuses: %s', (_why, text) => {
    expect(parseSignal(text, prodVocab)).toBeNull();
  });
});

describe('rule parser — refuses ambiguous posts (LLM fallback)', () => {
  it.each([
    ['two contracts in one post', 'NIFTY 24000 CE and 24000 PE buy 100 SL 80 TGT 130'],
    ['SL on the wrong side of a buy', 'BUY NIFTY 24000 CE ABOVE 120 SL 130 TGT 140'],
    ['target below a buy entry', 'BUY NIFTY 24000 CE @ 120 SL 100 TGT 110'],
    ['two underlyings', 'NIFTY and BANKNIFTY buy on dips 24000 52000'],
    ['two loose entry numbers (Hinglish prose)', 'NIFTY 24000 CE 120 wala lelo, 100 ka stop, 150 tak jayega'],
    ['option with BELOW and no side', 'NIFTY 24000 PE below 90 sl 110 tgt 70'],
  ])('%s', (_why, text) => {
    expect(parseSignal(text, vocab)).toBeNull();
  });
});
