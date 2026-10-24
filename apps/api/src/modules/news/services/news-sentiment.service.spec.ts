import { throwError, of } from 'rxjs';
import { ENGINE_BACKOFF_MS, NewsSentimentService } from './news-sentiment.service';

function make(ai: 'down' | { relatedSymbols?: unknown }, url: string | null = 'http://ai-engine:5000') {
  const http = {
    post: jest.fn(() => (ai === 'down' ? throwError(() => new Error('ECONNREFUSED')) : of({ data: { sentiment: 'neutral', score: 0, ...ai } }))),
  };
  const index = { symbols: jest.fn(async () => new Set(['RELIANCE', 'ONGC'])) };
  const svc = new NewsSentimentService(http as never, index as never);
  svc.engineUrl = url;
  return { svc, http };
}

describe('NewsSentimentService — relatedSymbols carry commodity / index underlyings', () => {
  it('keyword fallback: a crude headline is tagged CRUDEOIL alongside the listed symbols', async () => {
    const r = await make('down').svc.analyzeSentiment('ONGC gains as crude rises 2%', '');
    expect(r.relatedSymbols).toEqual(['ONGC', 'CRUDEOIL']);
  });

  it('AI engine path: its own symbols are kept and the underlying aliases are added, de-duplicated', async () => {
    const r = await make({ relatedSymbols: ['RELIANCE', 'GOLD'] }).svc.analyzeSentiment('Gold rises; Bank Nifty slips', '');
    expect(r.relatedSymbols).toEqual(['RELIANCE', 'GOLD', 'BANKNIFTY']);
  });

  it('a headline with no listed company and no alias stays untagged', async () => {
    const r = await make('down').svc.analyzeSentiment('Fed minutes due tonight', '');
    expect(r.relatedSymbols).toEqual([]);
  });
});

describe('NewsSentimentService — no repeated ECONNREFUSED', () => {
  it('AI_ENGINE_URL unset: never calls the engine, keyword analysis only', async () => {
    const { svc, http } = make({}, null);
    const r = await svc.analyzeSentiment('Reliance shares surge on record profit', '');
    expect(http.post).not.toHaveBeenCalled();
    expect(r.sentiment).toBe('bullish');
  });

  it('a failed call backs the engine off: the next articles do not call it until the back-off ends', async () => {
    const { svc, http } = make('down');
    let t = 1_000_000;
    svc.now = () => t;
    await svc.analyzeSentiment('a', '');
    await svc.analyzeSentiment('b', '');
    expect(http.post).toHaveBeenCalledTimes(1);
    t += ENGINE_BACKOFF_MS;
    await svc.analyzeSentiment('c', '');
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(http.post.mock.calls[0]).toBeDefined();
  });

  it('calls <AI_ENGINE_URL>/api/sentiment', async () => {
    const { svc, http } = make({});
    await svc.analyzeSentiment('x', '');
    expect((http.post.mock.calls[0] as unknown[])[0]).toBe('http://ai-engine:5000/api/sentiment');
  });
});
