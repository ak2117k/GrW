import { throwError, of } from 'rxjs';
import { NewsSentimentService } from './news-sentiment.service';

function make(ai: 'down' | { relatedSymbols?: unknown }) {
  const http = {
    post: jest.fn(() => (ai === 'down' ? throwError(() => new Error('ECONNREFUSED')) : of({ data: { sentiment: 'neutral', score: 0, ...ai } }))),
  };
  const index = { symbols: jest.fn(async () => new Set(['RELIANCE', 'ONGC'])) };
  return new NewsSentimentService(http as never, index as never);
}

describe('NewsSentimentService — relatedSymbols carry commodity / index underlyings', () => {
  it('keyword fallback: a crude headline is tagged CRUDEOIL alongside the listed symbols', async () => {
    const r = await make('down').analyzeSentiment('ONGC gains as crude rises 2%', '');
    expect(r.relatedSymbols).toEqual(['ONGC', 'CRUDEOIL']);
  });

  it('AI engine path: its own symbols are kept and the underlying aliases are added, de-duplicated', async () => {
    const r = await make({ relatedSymbols: ['RELIANCE', 'GOLD'] }).analyzeSentiment('Gold rises; Bank Nifty slips', '');
    expect(r.relatedSymbols).toEqual(['RELIANCE', 'GOLD', 'BANKNIFTY']);
  });

  it('a headline with no listed company and no alias stays untagged', async () => {
    const r = await make('down').analyzeSentiment('Fed minutes due tonight', '');
    expect(r.relatedSymbols).toEqual([]);
  });
});
