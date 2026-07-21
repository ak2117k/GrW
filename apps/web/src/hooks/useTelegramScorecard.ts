import { useCallback, useEffect, useState } from 'react';
import {
  getLeaderboard,
  listTelegramChannels,
  listTelegramSignals,
} from '../services/telegram';
import { wsService } from '../services/websocket';
import type {
  ChannelScorecard,
  TelegramChannel,
  TelegramSignalRow,
} from '../types';

/** Payload broadcast by TelegramGateway when the tracker resolves a signal. */
interface SignalUpdate {
  id?: string;
  status?: string;
  resultPct?: number | null;
}

export function useTelegramScorecard() {
  const [scorecards, setScorecards] = useState<ChannelScorecard[]>([]);
  const [channels, setChannels] = useState<TelegramChannel[]>([]);
  const [signals, setSignals] = useState<TelegramSignalRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [sc, ch, sig] = await Promise.all([
        getLeaderboard(),
        listTelegramChannels(),
        listTelegramSignals({ limit: 100 }),
      ]);
      setScorecards(sc);
      setChannels(ch);
      setSignals(sig);
    } catch {
      // soft-fail; the axios interceptor surfaces toasts
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live updates: when the tracker resolves a signal it broadcasts
  // `telegram:signal-update`. Patch the matching feed row in place (no refetch),
  // and re-pull the leaderboard since a terminal transition shifts win/loss counts.
  useEffect(() => {
    const unsubscribe = wsService.subscribe('telegram:signal-update', (data) => {
      const update = data as SignalUpdate;
      if (!update?.id) return;
      setSignals((prev) =>
        prev.map((s) =>
          s.id === update.id
            ? {
                ...s,
                status: update.status ?? s.status,
                resultPct: update.resultPct ?? s.resultPct,
              }
            : s,
        ),
      );
      getLeaderboard().then(setScorecards).catch(() => {
        // soft-fail; the manual Refresh and next mount still reconcile
      });
    });
    return unsubscribe;
  }, []);

  return { scorecards, channels, signals, isLoading, refresh };
}
