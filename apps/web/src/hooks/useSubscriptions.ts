import { useEffect, useState } from 'react';
import api from '../services/api';

export interface SubscriptionState {
  intraday: boolean;
  swing: boolean;
  loading: boolean;
}

/**
 * Fetches the caller's segment subscriptions once. The shared `api` axios
 * instance attaches the JWT. On error (incl. 403/network) we default to
 * unsubscribed so the Subscribe placeholder shows rather than the table.
 */
export function useSubscriptions(): SubscriptionState {
  const [s, setS] = useState<SubscriptionState>({ intraday: false, swing: false, loading: true });

  useEffect(() => {
    let on = true;
    api
      .get<{ INTRADAY: boolean; SWING: boolean }>('/me/subscriptions')
      .then((r) => {
        if (on) setS({ intraday: r.data.INTRADAY, swing: r.data.SWING, loading: false });
      })
      .catch(() => {
        if (on) setS({ intraday: false, swing: false, loading: false });
      });
    return () => {
      on = false;
    };
  }, []);

  return s;
}

/**
 * Pure predicate (unit-tested): a non-admin with a resolved, unsubscribed
 * status sees the Subscribe placeholder instead of the signals table.
 */
export function shouldShowSubscribeCard(
  isAdmin: boolean,
  loading: boolean,
  subscribed: boolean,
): boolean {
  return !isAdmin && !loading && !subscribed;
}
