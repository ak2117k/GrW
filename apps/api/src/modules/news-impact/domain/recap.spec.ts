import { applyRecapGuard, recapKind } from './recap';
import type { ImpactItem } from './impact';

// Headlines from prod news_clusters, 26 Oct – 2 Nov 2026.
describe('recapKind — wraps, previews, lists, live blogs, realised moves', () => {
  it.each([
    ['Why is the stock market down today? Sensex drops over 600 points, Nifty drops below 22,400 - Top 3 reasons', 'WRAP'],
    ['Crude shock, geopolitics drag Nifty below 22,500; Shriram Finance tumbles 5%', 'WRAP'],
    ['Sensex rises 200 pts, Nifty above 22,600 as market snaps 4-day losing streak. Is the relief rally sustainable?', 'REALISED_MOVE'],
    ['Markets claw back from morning lows; Dr. Reddy’s surges 7%, crude eases', 'WRAP'],
    ['Bank Nifty tumbles nearly 3%, slips below 55k: More selling pressure ahead for banking stocks?', 'WRAP'],
    ['US Markets Today: S&amp;P, Nasdaq end higher as Anthropic IPO filing revives AI optimism', 'WRAP'],
    ['Market fall explained: Sensex dives 995 points intraday, Nifty at 22,500', 'WRAP'],
    ['Stock Market LIVE: GIFT Nifty marginally down; Asia markets trade negative; Brent crude at $115', 'LIVE_BLOG'],
    ['TCS Share Price Live Updates: TCS Stock Faces Downward Pressure', 'LIVE_BLOG'],
    ['Stocks in news: Infosys, Kotak Mahindra Bank, YES Bank, Raymond, BPCL, Coforge and Senco Gold', 'LIST'],
    ['Kotak, Trent among top gainers and losers on Nifty today', 'LIST'],
    ['Diwali 2026: 77 stocks knock down D-St bears to deliver multibagger returns of up to 4,700% in a year', 'LIST'],
    ['Ahead of Market: 10 things that will decide stock market action on Monday', 'PREVIEW'],
    ['Stock market outlook today, 27 Oct: Sensex, Nifty prediction - DJIA, S&P, NASDAQ, GIFT Nifty', 'PREVIEW'],
    ['D-St set for a negative opening as GIFT Nifty signals weak start', 'PREVIEW'],
    ['Indian shares set for lower open as oil rise weighs; Jio market debut in focus', 'PREVIEW'],
    ['HDFC Bank, ITC, HDFC Life, Nestle, Britannia, TaMo PV hit 52-week lows', 'REALISED_MOVE'],
    ['Nifty FMCG down 22% in 2026; Diwali shopping opportunity for investors?', 'REALISED_MOVE'],
    ['Worst Samvat under Modi era; Nifty down 13% as investors enter new year amid growing caution', 'REALISED_MOVE'],
  ])('%s → %s', (headline, kind) => {
    expect(recapKind(headline)).toBe(kind);
  });

  it.each([
    'Oil prices fall over 1% as Iran-Qatar talks raise hopes of diplomatic progress',
    'Infosys shares drop 4% on Q2, guidance miss; here is what analysts recommend',
    'L&T secures ₹5,000 crore-plus orders for Dhaka Metro Line 1 systems',
    'Yemen’s Houthis say they hit Saudi Ras Tanura oil refinery with missile',
    'Reliance posts 40% rise in quarterly profit',
    'Markets regulator Sebi extends deadline for F&O margin rules',
    'G-Sec yields at three-year peak, could climb to 7.75% by December',
    'Trump on Iran war: It’s going to get wrapped up soon',
    '',
  ])('a fresh catalyst is not a recap: %s', (headline) => {
    expect(recapKind(headline)).toBeNull();
  });
});

describe('applyRecapGuard', () => {
  const item: ImpactItem = {
    clusterId: 'c1', direction: 'BEAR', magnitude: 'MED', horizon: 'DAYS',
    affected: { symbols: ['HDFCBANK'], sectors: ['Banks'], index: 'NIFTY' }, pricedIn: false, confidence: 0.6, oneLine: 'Selling pressure ahead.',
  };

  it('a recap carries no direction: NEUTRAL, LOW, priced in, confidence ≤ 0.3; targets kept', () => {
    expect(applyRecapGuard(item, 'WRAP')).toEqual({
      ...item, direction: 'NEUTRAL', magnitude: 'LOW', pricedIn: true, confidence: 0.3, oneLine: '[recap] Selling pressure ahead.',
    });
  });

  it('not a recap → unchanged; idempotent tag', () => {
    expect(applyRecapGuard(item, null)).toBe(item);
    const once = applyRecapGuard(item, 'LIST');
    expect(applyRecapGuard(once, 'LIST').oneLine).toBe(once.oneLine);
  });
});
