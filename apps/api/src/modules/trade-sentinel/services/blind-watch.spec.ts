import { BlindWatch, SENTINEL_BLIND_ALERT_MS } from './blind-watch';

describe('BlindWatch', () => {
  it('alerts once a key has failed for the whole window, and a success resets it', () => {
    const w = new BlindWatch();
    expect(w.record('t1', true, 0)).toBeNull();
    expect(w.record('t1', false, 60_000)).toBeNull();
    expect(w.record('t1', false, SENTINEL_BLIND_ALERT_MS - 1)).toBeNull();
    expect(w.record('t1', false, SENTINEL_BLIND_ALERT_MS)).toBe(5);
    expect(w.record('t1', true, SENTINEL_BLIND_ALERT_MS + 1)).toBeNull();
    expect(w.record('t1', false, SENTINEL_BLIND_ALERT_MS + 2)).toBeNull();
  });

  it('a key that never once worked starts its clock at the first sighting', () => {
    const w = new BlindWatch();
    expect(w.record('t2', false, 1_000)).toBeNull();
    expect(w.record('t2', false, 1_000 + SENTINEL_BLIND_ALERT_MS)).toBe(5);
  });

  it('keepOnly forgets closed keys', () => {
    const w = new BlindWatch();
    w.record('gone', true, 0);
    w.keepOnly(new Set());
    expect(w.record('gone', false, SENTINEL_BLIND_ALERT_MS * 2)).toBeNull(); // fresh clock
  });
});
