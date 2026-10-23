import api from './api';

/** Owner-only Telegram reader API (/api/telegram-reader). Nothing secret ever comes back. */

export type ConnectStage = 'code' | 'password' | 'connected';
export type ListenerState = 'off' | 'idle' | 'connecting' | 'listening' | 'backoff' | 'revoked';

export interface TelegramEnabledChannel {
  id: string;
  tgChannelId: string;
  title: string;
  username: string | null;
  memberCount: number | null;
}

export interface TelegramReaderStatus {
  readerFlag: 'on' | 'off';
  connected: boolean;
  session: { phoneMasked: string; status: string; lastError: string | null; connectedAt: string } | null;
  pending: 'code' | 'password' | null;
  listener: { state: ListenerState; lastError: string | null; lastMessageAt: string | null; channels: number };
  channels: TelegramEnabledChannel[];
}

export interface TelegramDialog {
  tgChannelId: string;
  title: string;
  username: string | null;
  memberCount: number | null;
  kind: 'channel' | 'group';
  enabled: boolean;
}

export async function getTelegramReaderStatus(): Promise<TelegramReaderStatus> {
  return (await api.get<TelegramReaderStatus>('/telegram-reader/status')).data;
}

export async function startTelegramLogin(body: { apiId: number; apiHash: string; phone: string }) {
  return (await api.post<{ stage: ConnectStage }>('/telegram-reader/connect/start', body, { timeout: 60_000 })).data;
}

export async function confirmTelegramLogin(body: { code?: string; password?: string }) {
  return (await api.post<{ stage: ConnectStage }>('/telegram-reader/connect/confirm', body, { timeout: 60_000 })).data;
}

export async function cancelTelegramLogin(): Promise<void> {
  await api.post('/telegram-reader/connect/cancel');
}

export async function disconnectTelegram(): Promise<void> {
  await api.delete('/telegram-reader/session');
}

export async function listTelegramDialogs(): Promise<TelegramDialog[]> {
  return (await api.get<TelegramDialog[]>('/telegram-reader/dialogs', { timeout: 60_000 })).data;
}

export async function setTelegramChannels(tgChannelIds: string[]): Promise<TelegramEnabledChannel[]> {
  return (await api.put<TelegramEnabledChannel[]>('/telegram-reader/channels', { tgChannelIds })).data;
}
