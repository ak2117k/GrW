import { useCallback, useEffect, useState } from 'react';
import {
  getLeaderboard,
  listTelegramChannels,
  listTelegramSignals,
} from '../services/telegram';
import type {
  ChannelScorecard,
  TelegramChannel,
  TelegramSignalRow,
} from '../types';

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

  return { scorecards, channels, signals, isLoading, refresh };
}
