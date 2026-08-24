import { describe, it, expect } from 'vitest';
import { classifyFeed, feedBadge, STALE_TICK_THRESHOLD_MS } from './feed-health';

describe('classifyFeed', () => {
  it('is offline when the tick socket is down, regardless of other namespaces', () => {
    expect(
      classifyFeed({ tickSocketUp: false, msSinceLastTick: 100, otherNamespacesUp: 3 }),
    ).toBe('offline');
  });

  it('is stale when the socket is up but ticks have stopped', () => {
    expect(
      classifyFeed({
        tickSocketUp: true,
        msSinceLastTick: STALE_TICK_THRESHOLD_MS + 1,
        otherNamespacesUp: 0,
      }),
    ).toBe('stale');
  });

  it('is live when a tick arrived inside the threshold', () => {
    expect(
      classifyFeed({ tickSocketUp: true, msSinceLastTick: 1_000, otherNamespacesUp: 0 }),
    ).toBe('live');
  });

  it('is stale, not live, when no tick has EVER arrived', () => {
    expect(
      classifyFeed({ tickSocketUp: true, msSinceLastTick: null, otherNamespacesUp: 3 }),
    ).toBe('stale');
  });
});

describe('feedBadge', () => {
  it('shows Live only for a live feed', () => {
    expect(feedBadge('live')).toEqual({ label: 'Live', wifi: true, tone: 'positive' });
  });

  it('shows Stale as its own state — not Live, and not Disconnected', () => {
    // This is the bug F1 exists to kill. The badge read connectedCount > 0
    // across four namespaces, so /ws/telegram being up rendered "Live" over a
    // dead tick feed. A stalled feed is neither working nor disconnected, and
    // collapsing it into either one is what made the UI assert something false.
    const badge = feedBadge('stale');

    expect(badge.label).toBe('Stale');
    expect(badge.label).not.toBe('Live');
    expect(badge.tone).toBe('warning');
    // The socket IS up — showing a struck-through wifi icon would be a second
    // lie in the other direction.
    expect(badge.wifi).toBe(true);
  });

  it('shows Offline when the tick socket is down', () => {
    expect(feedBadge('offline')).toEqual({ label: 'Offline', wifi: false, tone: 'negative' });
  });

  it('gives every health a distinct label', () => {
    const labels = (['live', 'stale', 'offline'] as const).map((h) => feedBadge(h).label);
    expect(new Set(labels).size).toBe(3);
  });
});
