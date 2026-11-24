import { describe, it, expect } from 'vitest';
import { classifyFeed, feedBadge, isAnyMarketOpen, STALE_TICK_THRESHOLD_MS } from './feed-health';

/** UTC ms for an IST wall-clock time (IST = UTC+5:30). */
const ist = (iso: string) => Date.parse(`${iso}+05:30`);

describe('classifyFeed', () => {
  it('is offline when the tick socket is down, regardless of other namespaces', () => {
    expect(
      classifyFeed({ tickSocketUp: false, msSinceLastTick: 100, otherNamespacesUp: 3, marketOpen: true }),
    ).toBe('offline');
  });

  it('is stale when the socket is up but ticks have stopped', () => {
    expect(
      classifyFeed({
        tickSocketUp: true,
        msSinceLastTick: STALE_TICK_THRESHOLD_MS + 1,
        otherNamespacesUp: 0,
        marketOpen: true,
      }),
    ).toBe('stale');
  });

  it('is live when a tick arrived inside the threshold', () => {
    expect(
      classifyFeed({ tickSocketUp: true, msSinceLastTick: 1_000, otherNamespacesUp: 0, marketOpen: true }),
    ).toBe('live');
  });

  it('is stale, not live, when no tick has EVER arrived', () => {
    expect(
      classifyFeed({ tickSocketUp: true, msSinceLastTick: null, otherNamespacesUp: 3, marketOpen: true }),
    ).toBe('stale');
  });
});

describe('classifyFeed against the market clock', () => {
  const at = (nowMs: number, msSinceLastTick: number | null, tickSocketUp = true) =>
    classifyFeed({ tickSocketUp, msSinceLastTick, otherNamespacesUp: 0, marketOpen: isAnyMarketOpen(nowMs) });

  it('00:45 IST Wednesday, no ticks -> closed, not stale', () => {
    expect(at(ist('2026-11-25T00:45:00'), null)).toBe('closed');
    expect(at(ist('2026-11-25T00:45:00'), 60_000)).toBe('closed');
  });

  it('10:00 IST Wednesday (NSE open), no ticks -> stale', () => {
    expect(at(ist('2026-11-25T10:00:00'), 60_000)).toBe('stale');
    expect(at(ist('2026-11-25T10:00:00'), null)).toBe('stale');
  });

  it('Saturday 11:00 IST, no ticks -> closed', () => {
    expect(at(ist('2026-11-28T11:00:00'), 60_000)).toBe('closed');
  });

  it('23:50 IST Wednesday (MCX open), no ticks -> stale', () => {
    expect(at(ist('2026-11-25T23:50:00'), 60_000)).toBe('stale');
  });

  it('socket down -> offline, open or closed', () => {
    expect(at(ist('2026-11-25T00:45:00'), 100, false)).toBe('offline');
    expect(at(ist('2026-11-25T10:00:00'), 100, false)).toBe('offline');
  });

  it('a fresh tick at 00:45 IST is still live', () => {
    expect(at(ist('2026-11-25T00:45:00'), 1_000)).toBe('live');
  });
});

describe('isAnyMarketOpen', () => {
  it('opens with MCX at 09:00 IST and closes after MCX 23:55 IST on a weekday', () => {
    expect(isAnyMarketOpen(ist('2026-11-25T08:59:00'))).toBe(false);
    expect(isAnyMarketOpen(ist('2026-11-25T09:00:00'))).toBe(true);
    expect(isAnyMarketOpen(ist('2026-11-25T15:31:00'))).toBe(true); // NSE shut, MCX open
    expect(isAnyMarketOpen(ist('2026-11-25T23:55:00'))).toBe(true);
    expect(isAnyMarketOpen(ist('2026-11-25T23:56:00'))).toBe(false);
  });

  it('uses the IST weekday, not the UTC one', () => {
    expect(isAnyMarketOpen(ist('2026-11-23T09:30:00'))).toBe(true); // Monday
    expect(isAnyMarketOpen(ist('2026-11-27T23:00:00'))).toBe(true); // Friday
    expect(isAnyMarketOpen(ist('2026-11-28T10:00:00'))).toBe(false); // Saturday
    expect(isAnyMarketOpen(ist('2026-11-29T10:00:00'))).toBe(false); // Sunday
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

  it('shows Market closed in a neutral tone, socket up', () => {
    expect(feedBadge('closed')).toEqual({ label: 'Market closed', wifi: true, tone: 'neutral' });
  });

  it('gives every health a distinct label', () => {
    const labels = (['live', 'stale', 'offline', 'closed'] as const).map((h) => feedBadge(h).label);
    expect(new Set(labels).size).toBe(4);
  });
});
