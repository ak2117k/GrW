import { exitNoiseStats, noiseReadDigest, type ExitNoiseReadRow } from './exit-noise';

const row = (over: Partial<ExitNoiseReadRow> = {}): ExitNoiseReadRow => ({
  source: 'signal_paper',
  symbol: 'SENSEX26N0574500CE',
  exitRule: 'AI_TRIGGER',
  want: 'BULLISH',
  verdict: 'NOISE',
  exitAt: new Date('2026-10-30T05:55:20Z'), // 11:25 IST, session 2026-10-30
  underlyingAtExit: 74_458.33,
  n: 25.83,
  after15m: 74_560,
  after30m: 74_610,
  maxFavour30m: 175.67,
  maxAgainst30m: 13.4,
  followed: true,
  summary: 'NOISE 2–0 (want bullish) move noise: move 1.45 N …',
  ...over,
});

describe('exitNoiseStats', () => {
  it('scores each followed NOISE / REAL read; S and the rolling window; unfollowed reads are pending', () => {
    const rows = [
      row(),
      row({ verdict: 'REAL', maxFavour30m: 60, maxAgainst30m: 5 }), // REAL, recovered: WRONG
      row({ followed: false }), // pending
      row({ verdict: 'MIXED' }),
      row({ exitAt: new Date('2026-10-29T05:00:00Z'), maxFavour30m: 10, maxAgainst30m: 40 }), // S−1: NOISE WRONG
      row({ exitAt: new Date('2026-09-01T05:00:00Z') }), // outside the window
    ];
    const s = exitNoiseStats(rows, ['2026-10-30', '2026-10-29']);
    expect(s.session).toMatchObject({ reads: 4, scored: 2, pending: 1, noise: { scored: 1, right: 1 }, real: { scored: 1, right: 0 }, byVerdict: { NOISE: 2, REAL: 1, MIXED: 1, NO_DATA: 0 } });
    expect(s.rolling20).toMatchObject({ reads: 5, scored: 3, noise: { scored: 2, right: 1 } });
    expect(s.session.items[0]).toMatchObject({ symbol: 'SENSEX26N0574500CE', verdict: 'NOISE', score: 'RIGHT', favourN: 6.8 });
    expect(s.session.items[2]).toMatchObject({ score: null });
  });
});

describe('noiseReadDigest', () => {
  it('compact counts for the diagnosis; null without reads', () => {
    const d = noiseReadDigest(exitNoiseStats([row()], ['2026-10-30']))!;
    expect(d.rolling20).toEqual({ reads: 1, byVerdict: { NOISE: 1, REAL: 0, MIXED: 0, NO_DATA: 0 }, scored: 1, pending: 0, noiseRight: '1/1', realRight: '0/0' });
    expect(d.basis).toMatch(/recovered ≥ 1 N/);
    expect(d.sessionReads).toHaveLength(1);
    expect(noiseReadDigest(exitNoiseStats([], ['2026-10-30']))).toBeNull();
    expect(noiseReadDigest(undefined)).toBeNull();
  });
});
