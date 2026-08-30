import { describe, it, expect } from 'vitest';
import {
  marketAwareInterval,
  marketPhase,
  pollIntervalMs,
  retryDelayMs,
  shouldRefreshOnReturn,
} from './refresh-policy';

/** A fixed instant expressed in IST, built from a UTC offset of +05:30. */
function ist(dateIso: string): Date {
  return new Date(`${dateIso}+05:30`);
}

describe('marketPhase', () => {
  it('is closed on a Saturday, whatever the hour', () => {
    expect(marketPhase(ist('2026-08-22T10:00:00'))).toBe('closed');
  });

  it('is closed on a Sunday', () => {
    expect(marketPhase(ist('2026-08-23T10:00:00'))).toBe('closed');
  });

  it('is closed at 03:00 on a weekday', () => {
    // The case the spec names: nothing may poll a shut market at 03:00.
    expect(marketPhase(ist('2026-08-24T03:00:00'))).toBe('closed');
  });

  it("reports 'open' at 09:05, because MCX is already trading", () => {
    // NOT 'pre-market'. The pre-market window (09:00-09:15) sits entirely
    // inside MCX hours (09:00-23:30), and the venue check runs first — so the
    // 'pre-market' branch of the existing rule is unreachable in practice.
    // Asserted as-is: this extraction must not change behaviour. Whether the
    // equity pre-open deserves its own state is a product question, and
    // changing it here would silently move the market-status bar too.
    expect(marketPhase(ist('2026-08-24T09:05:00'))).toBe('open');
  });

  it('is open during the NSE session', () => {
    expect(marketPhase(ist('2026-08-24T10:00:00'))).toBe('open');
  });

  it('stays open after 15:30 because MCX runs to 23:30', () => {
    // Commodities keep trading after the equity close; gating on the NSE close
    // alone would freeze the commodity screens for eight hours.
    expect(marketPhase(ist('2026-08-24T16:00:00'))).toBe('open');
  });

  it('is closed once MCX has shut', () => {
    expect(marketPhase(ist('2026-08-24T23:45:00'))).toBe('closed');
  });
});

describe('pollIntervalMs', () => {
  it('disables polling entirely when every venue is shut', () => {
    // `false` is TanStack's "do not poll". Returning a long interval instead
    // would keep waking Neon all night, which is what this gate exists to stop.
    expect(pollIntervalMs(5_000, 'closed')).toBe(false);
  });

  it('polls at the requested interval while open', () => {
    expect(pollIntervalMs(5_000, 'open')).toBe(5_000);
  });

  it('polls through pre-market, where prices already move', () => {
    expect(pollIntervalMs(5_000, 'pre-market')).toBe(5_000);
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially from one second', () => {
    expect(retryDelayMs(0)).toBe(1_000);
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(2)).toBe(4_000);
  });

  it('caps the delay so a long outage does not stretch to minutes', () => {
    expect(retryDelayMs(20)).toBe(30_000);
  });
});

describe('marketAwareInterval', () => {
  it('re-reads the clock on every call, so a query stops itself at the close', () => {
    let clock = new Date('2026-08-24T10:00:00+05:30'); // open
    const interval = marketAwareInterval(5_000, () => clock);

    expect(interval()).toBe(5_000);

    clock = new Date('2026-08-24T23:45:00+05:30'); // shut
    expect(interval()).toBe(false);
  });
});

describe('shouldRefreshOnReturn', () => {
  // The catch-up that does not exist anywhere in the app today. A hidden tab's
  // timers are throttled by the browser (Chrome drops them to ~1/min and can
  // freeze them), and useChartData additionally skips its fetch outright while
  // hidden — so on return the chart shows the bar it had when you left until an
  // interval happens to fire. That is the reported "graph doesn't update".

  it('refreshes when the tab returns during an open market', () => {
    expect(shouldRefreshOnReturn({ msSinceLastRefresh: 30_000, phase: 'open' })).toBe(true);
  });

  it('refreshes on the first return, when nothing has been fetched yet', () => {
    expect(
      shouldRefreshOnReturn({ msSinceLastRefresh: Number.POSITIVE_INFINITY, phase: 'open' }),
    ).toBe(true);
  });

  it('does not wake a closed market', () => {
    // Returning to a tab at 03:00 must not fire a request. The whole point of
    // the market gate is that a shut market is not worth a round trip -- and on
    // serverless Postgres it is not free either.
    expect(shouldRefreshOnReturn({ msSinceLastRefresh: 60_000, phase: 'closed' })).toBe(false);
  });

  it('refreshes during pre-market, where prices already move', () => {
    expect(shouldRefreshOnReturn({ msSinceLastRefresh: 60_000, phase: 'pre-market' })).toBe(true);
  });

  it('ignores a burst of returns inside the cooldown', () => {
    // visibilitychange fires on every tab flick. Without a floor, flicking
    // between two tabs would hammer the API for data it just fetched.
    expect(shouldRefreshOnReturn({ msSinceLastRefresh: 200, phase: 'open' })).toBe(false);
  });
});
