import {
  INDEX_VOLUME_MIN_SAMPLES,
  INDEX_VOLUME_WINDOW,
  IndexVolumeTracker,
  chainUnderlyingFor,
  isIndexInstrument,
  totalChainVolume,
} from './index-volume';

describe('isIndexInstrument', () => {
  it('recognises index tokens', () => {
    expect(isIndexInstrument({ token: '99926000', symbol: 'NIFTY' })).toBe(true);
    expect(isIndexInstrument({ token: '99926009' })).toBe(true);
    expect(isIndexInstrument({ token: '99919000' })).toBe(true); // SENSEX
  });

  it('recognises index symbols without a token', () => {
    expect(isIndexInstrument({ symbol: 'banknifty' })).toBe(true);
    expect(isIndexInstrument({ symbol: 'MIDCPNIFTY' })).toBe(true);
  });

  it('does not mistake a stock for an index', () => {
    expect(isIndexInstrument({ token: '2885', symbol: 'RELIANCE' })).toBe(false);
    expect(isIndexInstrument({})).toBe(false);
  });
});

describe('chainUnderlyingFor', () => {
  it('maps F&O indices to their chain underlying', () => {
    expect(chainUnderlyingFor({ token: '99926000', symbol: 'NIFTY' })).toBe('NIFTY');
    expect(chainUnderlyingFor({ token: '99926009', symbol: 'NIFTY BANK' })).toBe('BANKNIFTY');
  });

  it('returns null for an index with no option chain', () => {
    // Sector indices are indices, but have no options — the honest answer
    // is "no reading", not a fabricated proxy.
    expect(chainUnderlyingFor({ token: '99926023', symbol: 'NIFTY METAL' })).toBeNull();
  });

  it('returns null for stocks', () => {
    expect(chainUnderlyingFor({ token: '2885', symbol: 'RELIANCE' })).toBeNull();
  });
});

describe('totalChainVolume', () => {
  const row = (ce: number | null, pe: number | null) => ({
    ceData: ce === null ? null : { volume: ce },
    peData: pe === null ? null : { volume: pe },
  });

  it('sums CE + PE traded volume across the chain', () => {
    expect(totalChainVolume([row(10, 20), row(5, 1)])).toBe(36);
  });

  it('tolerates missing legs and non-numeric volume', () => {
    expect(
      totalChainVolume([
        row(10, null),
        { ceData: { volume: null }, peData: { volume: 4 } },
        {},
      ]),
    ).toBe(14);
  });

  it('is 0 on an empty chain (caller treats 0 as no reading)', () => {
    expect(totalChainVolume([])).toBe(0);
  });
});

describe('IndexVolumeTracker', () => {
  const KEY = '99926000:15m';
  let tracker: IndexVolumeTracker;
  beforeEach(() => {
    tracker = new IndexVolumeTracker();
  });

  /** Feed `n` steady 1000-unit periods so a baseline exists. */
  const warmUp = (n: number, step = 1000): number => {
    let cumulative = 0;
    for (let i = 0; i < n; i++) {
      cumulative += step;
      tracker.record(KEY, cumulative);
    }
    return cumulative;
  };

  it('reports null on the first sample — nothing to difference against', () => {
    expect(tracker.record(KEY, 5000)).toBeNull();
  });

  it('reports null until MIN_SAMPLES period-deltas exist', () => {
    let cumulative = 0;
    // sample 1 = baseline, then MIN_SAMPLES deltas before a ratio is due
    for (let i = 0; i < INDEX_VOLUME_MIN_SAMPLES + 1; i++) {
      cumulative += 1000;
      expect(tracker.record(KEY, cumulative)).toBeNull();
    }
    cumulative += 1000;
    expect(tracker.record(KEY, cumulative)).toBeCloseTo(1, 6);
  });

  it('computes the ratio of this period against the median of prior periods', () => {
    let cumulative = warmUp(INDEX_VOLUME_MIN_SAMPLES + 1);
    cumulative += 2500; // 2.5× the 1000-unit median
    expect(tracker.record(KEY, cumulative)).toBeCloseTo(2.5, 6);
  });

  it('differences the cumulative total rather than comparing raw totals', () => {
    // Chain volume is cumulative for the session. A naive implementation
    // comparing raw totals would report an ever-growing ratio; deltas keep
    // a steady tape at ~1.0×.
    let cumulative = warmUp(INDEX_VOLUME_MIN_SAMPLES + 1);
    cumulative += 1000;
    expect(tracker.record(KEY, cumulative)).toBeCloseTo(1, 6);
    cumulative += 1000;
    expect(tracker.record(KEY, cumulative)).toBeCloseTo(1, 6);
  });

  it('never returns 0 for an unchanged chain — a stale snapshot is not zero flow', () => {
    const cumulative = warmUp(INDEX_VOLUME_MIN_SAMPLES + 1);
    expect(tracker.record(KEY, cumulative)).toBeNull();
  });

  it('resets and reports null when the cumulative total goes backwards (new session)', () => {
    warmUp(INDEX_VOLUME_MIN_SAMPLES + 1);
    expect(tracker.record(KEY, 500)).toBeNull(); // rollover
    expect(tracker.sampleCount(KEY)).toBe(0);
    expect(tracker.record(KEY, 1500)).toBeNull(); // rebuilding history
  });

  it('rejects non-positive / non-finite totals as no reading', () => {
    expect(tracker.record(KEY, 0)).toBeNull();
    expect(tracker.record(KEY, Number.NaN)).toBeNull();
    expect(tracker.record(KEY, -5)).toBeNull();
  });

  it('keeps at most INDEX_VOLUME_WINDOW deltas', () => {
    warmUp(INDEX_VOLUME_WINDOW + 10);
    expect(tracker.sampleCount(KEY)).toBe(INDEX_VOLUME_WINDOW);
  });

  it('keeps series separate per key', () => {
    warmUp(INDEX_VOLUME_MIN_SAMPLES + 1);
    expect(tracker.record('99926009:15m', 9_999_999)).toBeNull();
    expect(tracker.sampleCount(KEY)).toBe(INDEX_VOLUME_MIN_SAMPLES);
  });
});
