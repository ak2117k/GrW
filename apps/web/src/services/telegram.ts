import api from './api';
import type { TelegramChannel, ChannelScorecard, TelegramSignalRow } from '../types';

export async function listTelegramChannels(): Promise<TelegramChannel[]> {
  const r = await api.get<TelegramChannel[]>('/telegram/channels');
  return r.data;
}

export async function getLeaderboard(): Promise<ChannelScorecard[]> {
  const r = await api.get<ChannelScorecard[]>('/telegram/leaderboard');
  return r.data;
}

export async function listTelegramSignals(
  params: { channelId?: string; status?: string; limit?: number } = {},
): Promise<TelegramSignalRow[]> {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined),
  );
  const r = await api.get<TelegramSignalRow[]>('/telegram/signals', { params: clean });
  return r.data;
}
