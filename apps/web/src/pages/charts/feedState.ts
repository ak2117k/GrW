import type { FeedState } from '@/hooks/useChartData';

/**
 * Visual weight for the connection badge. Consumers map these to colours:
 *   green — healthy live feed
 *   amber — degraded but recoverable (reconnecting / delayed data)
 *   red   — actionable failure (no broker credentials)
 *   muted — expected idle state (market closed)
 */
export type BadgeTone = 'green' | 'amber' | 'red' | 'muted';

export interface Badge {
  label: string;
  tone: BadgeTone;
}

export interface DeriveBadgeInput {
  feedState: FeedState;
  marketOpen: boolean;
  brokerConnected: boolean;
}

/**
 * Pure map from raw connection signals to a single honest badge.
 *
 * Priority (highest first) — a lower-priority state can never mask a
 * higher-priority one:
 *   1. No broker credentials → nothing can stream, say so plainly.
 *   2. Market closed → an idle feed is expected, not a fault.
 *   3. Otherwise reflect the live feed lifecycle.
 *
 * Kept pure (no hooks, no clock) so the whole decision table is unit-testable.
 */
export function deriveBadge(input: DeriveBadgeInput): Badge {
  const { feedState, marketOpen, brokerConnected } = input;

  if (!brokerConnected) {
    return { label: 'Broker not connected', tone: 'red' };
  }

  if (!marketOpen) {
    return { label: 'Market closed', tone: 'muted' };
  }

  switch (feedState) {
    case 'live':
      return { label: 'Live', tone: 'green' };
    case 'connecting':
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'amber' };
    case 'error':
      return { label: 'Delayed', tone: 'amber' };
    case 'closed':
      return { label: 'Market closed', tone: 'muted' };
    default: {
      // Exhaustiveness guard — a new FeedState must be handled explicitly.
      // `void` reads the binding so noUnusedLocals stays satisfied.
      const _exhaustive: never = feedState;
      void _exhaustive;
      return { label: 'Delayed', tone: 'amber' };
    }
  }
}
