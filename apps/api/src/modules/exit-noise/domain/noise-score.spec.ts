import { noiseReadStats, scoreNoiseRead, type ScorableRead } from './noise-score';

const read = (over: Partial<ScorableRead> = {}): ScorableRead => ({
  verdict: 'NOISE',
  want: 'BULLISH',
  underlyingAtExit: 74_458.33,
  n: 25.83,
  after15m: null,
  after30m: null,
  maxFavour30m: null,
  maxAgainst30m: null,
  ...over,
});

describe('scoreNoiseRead', () => {
  it('prod 2026-10-30 SENSEX: NOISE at 74458.33, SENSEX ran to 74634 within 30 min (6.8 N) → RIGHT', () => {
    const s = scoreNoiseRead(read({ maxFavour30m: 74_634 - 74_458.33, maxAgainst30m: 13.4, after15m: 74_560, after30m: 74_610 }));
    expect(s).toEqual({ score: 'RIGHT', favourN: 6.8, againstN: 0.52 });
  });

  it('NOISE is WRONG when the underlying never recovered 1 N in the position\'s favour', () => {
    expect(scoreNoiseRead(read({ maxFavour30m: 20, maxAgainst30m: 80 })).score).toBe('WRONG');
  });

  it('REAL is RIGHT when the move kept going ≥ 1 N against, WRONG otherwise; mirrored for a bearish position', () => {
    expect(scoreNoiseRead(read({ verdict: 'REAL', maxFavour30m: 5, maxAgainst30m: 30 })).score).toBe('RIGHT');
    expect(scoreNoiseRead(read({ verdict: 'REAL', maxFavour30m: 60, maxAgainst30m: 10 })).score).toBe('WRONG');
    // Bearish, from the closes only: the underlying ROSE 40 pts (against a bearish position).
    expect(scoreNoiseRead(read({ verdict: 'REAL', want: 'BEARISH', after15m: 74_480, after30m: 74_498.33 })).score).toBe('RIGHT');
  });

  it('falls back to the 15 / 30-min closes without the excursions', () => {
    expect(scoreNoiseRead(read({ after15m: 74_470, after30m: 74_490 })).score).toBe('RIGHT');
    expect(scoreNoiseRead(read({ after15m: 74_440, after30m: 74_470 })).score).toBe('WRONG');
  });

  it('MIXED / NO_DATA, no N or no follow-up are not scored', () => {
    expect(scoreNoiseRead(read({ verdict: 'MIXED', maxFavour30m: 100, maxAgainst30m: 0 })).score).toBeNull();
    expect(scoreNoiseRead(read({ verdict: 'NO_DATA', maxFavour30m: 100, maxAgainst30m: 0 })).score).toBeNull();
    expect(scoreNoiseRead(read({ n: null, maxFavour30m: 100, maxAgainst30m: 0 })).score).toBeNull();
    expect(scoreNoiseRead(read())).toEqual({ score: null, favourN: null, againstN: null });
  });
});

describe('noiseReadStats', () => {
  it('counts by verdict, right / scored per NOISE and REAL, pending = NOISE / REAL not scored yet', () => {
    const s = noiseReadStats([
      { verdict: 'NOISE', score: 'RIGHT' },
      { verdict: 'NOISE', score: 'WRONG' },
      { verdict: 'NOISE', score: null },
      { verdict: 'REAL', score: 'RIGHT' },
      { verdict: 'MIXED', score: null },
      { verdict: 'NO_DATA', score: null },
    ]);
    expect(s).toEqual({
      reads: 6,
      byVerdict: { NOISE: 3, REAL: 1, MIXED: 1, NO_DATA: 1 },
      scored: 3,
      pending: 1,
      noise: { scored: 2, right: 1 },
      real: { scored: 1, right: 1 },
    });
  });
});
