import { describe, it, expect } from 'vitest';
import { classifyFeed, STALE_TICK_THRESHOLD_MS } from './feed-health';

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
