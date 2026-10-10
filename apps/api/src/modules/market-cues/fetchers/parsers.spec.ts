import { readFileSync } from 'fs';
import { join } from 'path';
import { parseYahooCue, parseCnbcQuotes } from './us-cues.fetcher';
import { parseNseFiiDii, parseNsdlLatest } from './fii-dii.fetcher';
import { parseParticipantOi, participantOiChange, participantOiUrl } from './fii-oi.fetcher';
import {
  computeGiftGap,
  parseMarketStatusGift,
  parseNseIxGift,
  parseNseNiftyFutures,
} from './gift-nifty.fetcher';
import { parseNsePreOpen } from './pre-open.fetcher';
import { istDateTimeToIso, nseDateToYmd } from './ist-dates';

/**
 * Every parser against a TRIMMED REAL payload, fetched once on 2026-10-10
 * (Saturday) — so the sessions in them are Friday 2026-10-09's.
 */
const FX = join(__dirname, '..', '__fixtures__');
const json = (name: string) => JSON.parse(readFileSync(join(FX, name), 'utf8'));
const text = (name: string) => readFileSync(join(FX, name), 'utf8');

describe('IST date helpers', () => {
  it('reads NSE dates and IST wall-clock stamps', () => {
    expect(nseDateToYmd('09-Oct-2026')).toBe('2026-10-09');
    expect(nseDateToYmd('Oct 09, 2026')).toBe('2026-10-09');
    expect(nseDateToYmd('nonsense')).toBeNull();
    expect(istDateTimeToIso('10-Oct-2026 02:30:09')).toBe('2026-10-09T21:00:09.000Z');
    expect(istDateTimeToIso('09-Oct-2026 15:40')).toBe('2026-10-09T10:10:00.000Z');
  });
});

describe('US cues', () => {
  it('Yahoo index: last two daily closes, dated by its own regularMarketTime', () => {
    const r = parseYahooCue(json('yahoo-ixic.json'), '^IXIC');
    expect(r.values).toEqual({ symbol: '^IXIC', last: 27366.17, previousClose: 27193.34, change: 172.83, changePercent: 0.64 });
    expect(r.sourceTime).toBe(new Date(1791580559 * 1000).toISOString());
  });

  it('Yahoo future (NQ=F): current price vs the previous daily close, quote time', () => {
    const r = parseYahooCue(json('yahoo-nqf.json'), 'NQ=F');
    expect(r.values).toMatchObject({ last: 31108.75, previousClose: 30969.5, change: 139.25 });
    expect(r.sourceTime).toBe(new Date(1791579599 * 1000).toISOString());
  });

  it('S&P 500, Dow and ES=F parse too', () => {
    for (const [f, s] of [['yahoo-gspc.json', '^GSPC'], ['yahoo-dji.json', '^DJI'], ['yahoo-esf.json', 'ES=F']]) {
      const r = parseYahooCue(json(f), s);
      expect(r.values.last).toBeGreaterThan(0);
      expect(r.values.previousClose).toBeGreaterThan(0);
    }
  });

  it('Yahoo: throws rather than inventing a zero when a close is missing', () => {
    expect(() => parseYahooCue({ chart: { result: [{ meta: {}, indicators: { quote: [{ close: [null] }] } }] } }, '^IXIC')).toThrow(
      /no last two daily closes/,
    );
  });

  it('CNBC: indices dated by session date, futures by their quote time; commas and signs read', () => {
    const q = parseCnbcQuotes(json('cnbc-quotes.json'));
    expect(q['.IXIC']).toEqual({
      values: { symbol: '.IXIC', last: 27366.17, previousClose: 27193.34, change: 172.83, changePercent: 0.64 },
      sourceTime: '2026-10-09',
    });
    expect(q['@ND.1'].values.last).toBe(31123.25);
    expect(q['@ND.1'].sourceTime).toBe('2026-10-10T21:38:52.000Z');
    expect(Object.keys(q).sort()).toEqual(['.DJI', '.IXIC', '.SPX', '@DJ.1', '@ND.1', '@SP.1']);
  });
});

describe('FII/DII cash', () => {
  it('NSE fiidiiTradeReact: both categories on one date, ₹ crore', () => {
    const r = parseNseFiiDii(json('nse-fiidii.json'));
    expect(r.sourceTime).toBe('2026-10-09');
    expect(r.values).toEqual({
      date: '2026-10-09',
      fii: { buy: 10373.99, sell: 13942.89, net: -3568.9 },
      dii: { buy: 15626.53, sell: 10883.27, net: 4743.26 },
      unit: '₹ crore',
    });
  });

  it('NSE: refuses a payload with no FII row rather than reporting a zero', () => {
    expect(() => parseNseFiiDii([{ category: 'DII', date: '09-Oct-2026', buyValue: '1', sellValue: '1', netValue: '0' }])).toThrow(/FII/);
  });

  it('NSDL fallback: FPI equity via the stock exchange, parenthesised negatives, no DII', () => {
    const r = parseNsdlLatest(text('nsdl-latest.html'));
    expect(r).toEqual({ reportDate: '2026-10-09', fii: { buy: 16044.83, sell: 28988, net: -12943.17 } });
  });
});

describe('FII index F&O positioning (participant OI CSV)', () => {
  it('reads the FII row and the as-on date', () => {
    const r = parseParticipantOi(text('fao_participant_oi_09102026.csv'));
    expect(r).toEqual({
      date: '2026-10-09',
      indexFutures: { long: 34943, short: 328931 },
      indexCalls: { long: 600034, short: 946852 },
      indexPuts: { long: 1245164, short: 704672 },
    });
  });

  it('change vs the previous file', () => {
    const now = parseParticipantOi(text('fao_participant_oi_09102026.csv'));
    const prev = parseParticipantOi(text('fao_participant_oi_08102026.csv'));
    const ch = participantOiChange(now, prev);
    expect(ch.previousDate).toBe('2026-10-08');
    expect(ch.indexFutures.long).toBe(now.indexFutures.long - prev.indexFutures.long);
    expect(ch.indexPuts.short).toBe(now.indexPuts.short - prev.indexPuts.short);
  });

  it('builds the archive URL with DDMMYYYY', () => {
    expect(participantOiUrl('https://x/fao_participant_oi_{DDMMYYYY}.csv', '2026-10-09')).toBe('https://x/fao_participant_oi_09102026.csv');
  });
});

describe('GIFT Nifty', () => {
  it('NSE IX: nearest-expiry NIFTY FUTIDX, timestamp read as IST', () => {
    const r = parseNseIxGift(json('nseix-market-rate.json'));
    expect(r).toEqual({ price: 22575.5, expiry: '2026-10-27', at: '2026-10-09T21:00:09.000Z', dayChange: -27 });
  });

  it('marketStatus giftnifty fallback', () => {
    expect(parseMarketStatusGift(json('nse-market-status.json'))).toEqual({
      price: 22575.5,
      expiry: '2026-10-27',
      at: '2026-10-09T21:00:00.000Z',
      dayChange: -27,
    });
  });

  it('NSE NIFTY current-month future close (not spot)', () => {
    expect(parseNseNiftyFutures(json('nse-nifty-futures.json'))).toEqual({
      close: 22612.6,
      expiry: '2026-10-27',
      sessionDate: '2026-10-09',
      closedAt: '2026-10-09T10:10:00.000Z',
    });
  });

  it('the gap is futures-vs-futures, and says so', () => {
    const gift = parseNseIxGift(json('nseix-market-rate.json'));
    const fut = parseNseNiftyFutures(json('nse-nifty-futures.json'));
    const gap = computeGiftGap(gift, fut);
    expect(gap.gap).toBe(-37.1);
    expect(gap.gapPercent).toBe(-0.16);
    expect(gap.comparison).toMatch(/futures-vs-futures/);
    expect(gap.expiryMatches).toBe(true);
  });

  it('the gap is null — never 0 — without a future close', () => {
    const gift = parseNseIxGift(json('nseix-market-rate.json'));
    const gap = computeGiftGap(gift, null);
    expect(gap.gap).toBeNull();
    expect(gap.gapPercent).toBeNull();
  });
});

describe('NSE pre-open', () => {
  it('IEP per symbol with its previous close; cash rows labelled CASH', () => {
    const r = parseNsePreOpen(json('nse-preopen-fo.json'));
    expect(r.date).toBe('2026-10-09');
    expect(r.entries.APOLLOHOSP).toEqual({
      symbol: 'APOLLOHOSP',
      instrument: 'CASH',
      iep: 7950,
      previousClose: 7666,
      change: 284,
      changePercent: 3.7,
      at: '2026-10-09T03:39:49.000Z',
    });
    expect(Object.keys(r.entries).length).toBeGreaterThanOrEqual(3);
  });

  it('an empty session ("No Data Found") is a parse failure, not an empty book', () => {
    expect(() => parseNsePreOpen({ data: [], msg: 'No Data Found' })).toThrow(/no pre-open rows/);
  });
});
