import { RELEVANT_AT, relevanceOf } from './relevance';

const ctx = { fno: new Set(['RELIANCE', 'TATAMOTORS', 'DIXON', 'ABCAPITAL']), held: new Set(['DIXON', 'NIFTY']) };
const r = (o: Partial<Parameters<typeof relevanceOf>[0]>) => relevanceOf({ instruments: [], indices: [], text: '', sourceCount: 1, ...o }, ctx);

describe('relevance', () => {
  it('held symbol is fully relevant', () => {
    expect(r({ instruments: ['DIXON'] })).toMatchObject({ score: 1 });
    expect(r({ instruments: ['DIXON'] }).reasons[0]).toBe('held:DIXON');
  });

  it('F&O stock alone is relevant; a non-F&O small cap is not', () => {
    expect(r({ instruments: ['ABCAPITAL'] }).score).toBeGreaterThanOrEqual(RELEVANT_AT);
    expect(r({ instruments: ['VIJIFIN'] }).score).toBe(0);
  });

  it('heavyweights, index tags and macro add up (capped at 1)', () => {
    expect(r({ instruments: ['RELIANCE'] }).score).toBe(1);
    expect(r({ text: 'Rupee falls to record low as crude surges' })).toMatchObject({ score: 0.5 });
    expect(r({ text: 'RBI keeps repo rate unchanged' }).reasons).toContain('macro:rbi');
    expect(r({ indices: ['NIFTY'] }).score).toBe(1); // index + held NIFTY
    expect(r({ indices: ['BANKNIFTY'] }).score).toBe(0.5);
  });

  it('coverage adds a little', () => {
    expect(r({ instruments: ['ABCAPITAL'], sourceCount: 3 }).score).toBe(0.5);
  });
});
