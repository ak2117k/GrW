// apps/api/src/modules/sentinel-executor/domain/claim-timing.spec.ts
import { BROKER_CALL_TIMEOUT_MS, ORDER_CALL_TIMEOUT_MS } from '../../auto-execution/services/per-user-broker-session.factory';
import {
  CANCEL_CONFIRM_STEPS_MS,
  CLAIM_STALE_MS,
  MAX_BROKER_CALLS_WHILE_CLAIMED,
  MAX_PROTECTIVE_CANCELS,
  ORDER_CALLS_WHILE_CLAIMED,
  READ_RETRY_BACKOFF_MS,
  READ_RETRY_WINDOW_MS,
  READ_RETRY_WORST_MS,
  SECOND_SWEEP_MS,
  TAG_LOOKUP_DELAY_MS,
} from './claim-timing';

describe('claim staleness bound (a running attempt must never be swept as INTERRUPTED)', () => {
  it('counts every broker call an attempt can make while its row is CLAIMED, cancels included', () => {
    // login + 2 pre-check reads + cancels + cancel-confirm book reads + 2 re-check reads
    // + MARKET + settle read + 2 fallback reads + LIMIT + settle read + logout
    expect(MAX_BROKER_CALLS_WHILE_CLAIMED).toBe(1 + 2 + MAX_PROTECTIVE_CANCELS + CANCEL_CONFIRM_STEPS_MS.length + 2 + 1 + 1 + 2 + 1 + 1 + 1);
  });

  it('exceeds the worst-case CLAIMED duration (reads at the 15 s cap, order calls at the 25 s cap, every sleep) and is at least 180 s', () => {
    const sleeps = CANCEL_CONFIRM_STEPS_MS.reduce((a, b) => a + b, 0) + 2 * TAG_LOOKUP_DELAY_MS;
    expect(ORDER_CALLS_WHILE_CLAIMED).toBe(MAX_PROTECTIVE_CANCELS + 2); // cancels + MARKET + LIMIT
    const orders = ORDER_CALLS_WHILE_CLAIMED * ORDER_CALL_TIMEOUT_MS;
    const others = (MAX_BROKER_CALLS_WHILE_CLAIMED - ORDER_CALLS_WHILE_CLAIMED) * BROKER_CALL_TIMEOUT_MS;
    expect(CLAIM_STALE_MS).toBeGreaterThan(orders + others + sleeps + READ_RETRY_WORST_MS);
    expect(CLAIM_STALE_MS).toBeGreaterThanOrEqual(180_000);
  });

  it('read retries add at most the retry window plus one capped read (2 retries: 500 ms, then 1500 ms)', () => {
    expect(READ_RETRY_BACKOFF_MS).toEqual([500, 1_500]);
    expect(READ_RETRY_WORST_MS).toBe(READ_RETRY_WINDOW_MS + BROKER_CALL_TIMEOUT_MS);
    expect(Math.max(...READ_RETRY_BACKOFF_MS)).toBeLessThan(READ_RETRY_WINDOW_MS);
    expect(CLAIM_STALE_MS).toBe(405_000);
  });

  it('the boot-time second sweep runs after a row claimed at boot could have gone stale', () => {
    expect(SECOND_SWEEP_MS).toBeGreaterThan(CLAIM_STALE_MS);
  });
});
