import { describe, expect, it } from 'vitest';
import { shouldShowSubscribeCard } from './useSubscriptions';

describe('shouldShowSubscribeCard', () => {
  it('hides the card while subscription status is still loading', () => {
    expect(shouldShowSubscribeCard(false, true, false)).toBe(false);
  });

  it('shows the card for a resolved, unsubscribed non-admin', () => {
    expect(shouldShowSubscribeCard(false, false, false)).toBe(true);
  });

  it('hides the card for a subscribed non-admin', () => {
    expect(shouldShowSubscribeCard(false, false, true)).toBe(false);
  });

  it('never shows the card for an admin, regardless of subscription', () => {
    expect(shouldShowSubscribeCard(true, false, false)).toBe(false);
    expect(shouldShowSubscribeCard(true, true, false)).toBe(false);
    expect(shouldShowSubscribeCard(true, false, true)).toBe(false);
  });
});
