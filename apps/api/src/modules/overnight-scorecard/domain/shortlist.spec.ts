import { buildNewsIdeasUserMessage, extractJsonText, validateIdeas } from './news-ideas-ai';
import { assemble } from './scoring';
import { isMaterialAnnouncement, shortlist, type CandidateArticle } from './shortlist';

const art = (id: string, instruments: string[], score: number | null, over: Partial<CandidateArticle> = {}): CandidateArticle => ({
  id, title: `headline ${id}`, url: `https://n/${id}`, source: 'ET', sentiment: null, sentimentScore: score,
  publishedAt: new Date('2026-10-19T17:00:00Z'), instruments, ...over,
});
const FNO = new Set(['RELIANCE', 'INFY', 'TCS', 'SBIN', 'HDFCBANK', 'ITC', 'LT', 'KEI']);

describe('news-ideas shortlist', () => {
  it('keeps F&O-eligible symbols only', () => {
    const out = shortlist([art('a', ['SMALLCAP'], 0.9), art('b', ['INFY'], 0.9)], FNO, new Set());
    expect(out.map((c) => c.symbol)).toEqual(['INFY']);
  });
  it('drops symbols already held', () => {
    expect(shortlist([art('a', ['RELIANCE'], 0.9), art('b', ['INFY'], -0.8)], FNO, new Set(['RELIANCE'])).map((c) => c.symbol)).toEqual(['INFY']);
  });
  it('needs strong sentiment or a material NSE announcement', () => {
    const out = shortlist(
      [
        art('weak', ['TCS'], 0.2),
        art('ann', ['SBIN'], 0.1, { source: 'NSE Announcements', title: 'SBIN: Financial Results for Q2' }),
        art('routine', ['ITC'], 0.1, { source: 'NSE Announcements', title: 'ITC: Closure of Trading Window' }),
      ],
      FNO,
      new Set(),
    );
    expect(out.map((c) => c.symbol)).toEqual(['SBIN']);
    expect(isMaterialAnnouncement({ source: 'NSE Announcements', title: 'X: Trading Window closure' })).toBe(false);
  });
  it('caps at 5, strongest first, groups articles per symbol and skips articles already used', () => {
    const list = ['RELIANCE', 'INFY', 'TCS', 'SBIN', 'HDFCBANK', 'ITC', 'LT'].map((s, i) => art(`n${i}`, [s], 0.5 + i * 0.05));
    list.push(art('dup', ['LT'], -0.95));
    const out = shortlist(list, FNO, new Set(), new Set(['dup']));
    expect(out).toHaveLength(5);
    expect(out[0].symbol).toBe('LT');
    expect(out[0].newsIds).toEqual(['n6']);
    const grouped = shortlist([art('x', ['KEI'], 0.6), art('y', ['KEI'], -0.9)], FNO, new Set());
    expect(grouped[0]).toMatchObject({ symbol: 'KEI', newsIds: ['y', 'x'], headline: 'headline y', headlineUrl: 'https://n/y' });
    expect(grouped[0].strength).toBeCloseTo(-0.9);
  });
});

describe('Sonnet JSON validation', () => {
  const good = { symbol: 'INFY', idea: 'CE_IDEA', rationale: 'r', invalidation: 'below 1400', whatToDo: 'wait for 15m close' };
  it('accepts exactly one idea per candidate (fenced JSON tolerated)', () => {
    const raw = extractJsonText('```json\n' + JSON.stringify({ ideas: [good, { ...good, symbol: 'tcs', idea: 'NO_TRADE' }] }) + '\n```');
    expect(validateIdeas(raw, ['INFY', 'TCS']).map((i) => `${i.symbol}:${i.idea}`)).toEqual(['INFY:CE_IDEA', 'TCS:NO_TRADE']);
  });
  it.each([
    ['not an object', []],
    ['extra top-level key', { ideas: [good], note: 'x' }],
    ['unknown idea kind', { ideas: [{ ...good, idea: 'BUY' }] }],
    ['symbol not a candidate', { ideas: [{ ...good, symbol: 'SBIN' }] }],
    ['duplicate symbol', { ideas: [good, good] }],
    ['missing candidate', { ideas: [] }],
    ['empty text', { ideas: [{ ...good, rationale: ' ' }] }],
    ['over-long text', { ideas: [{ ...good, whatToDo: 'x'.repeat(601) }] }],
    ['extra item key', { ideas: [{ ...good, size: 5 }] }],
  ])('rejects: %s', (_label, raw) => {
    expect(() => validateIdeas(raw, ['INFY'])).toThrow();
  });
  it('rejects a reply with no JSON object', () => {
    expect(() => extractJsonText('I cannot help with that')).toThrow();
  });
  it('the user message carries each candidate with its compact scorecard', () => {
    const sc = assemble({ userId: null, symbol: 'INFY', exchange: 'NSE', underlying: 'INFY', side: 'BULLISH', window: 'NEWS_IDEA', computedAt: new Date(0), factors: [] });
    const c = shortlist([art('a', ['INFY'], 0.9)], FNO, new Set())[0];
    const msg = JSON.parse(buildNewsIdeasUserMessage([{ candidate: c, scorecard: sc }]));
    expect(msg.candidates[0]).toMatchObject({ symbol: 'INFY', scorecardSide: 'BULLISH' });
    expect(msg.candidates[0].scorecard).toMatch(/^total 0 NEUTRAL/);
  });
});
