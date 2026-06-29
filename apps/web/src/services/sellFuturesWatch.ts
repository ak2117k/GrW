import api from './api';
import type { SellFuturesWatchEntry, SellFuturesPaperAccount } from '../types/sellFuturesWatch.types';
import type { WatchEntryWithEvents, WatchStatus } from '../types/watch.types';

export async function listSellFuturesEntries(opts: { status?: WatchStatus; date?: string } = {}) {
  const r = await api.get<SellFuturesWatchEntry[]>('/sell-futures/watch', { params: opts });
  return r.data;
}

export async function getSellFuturesEntry(id: string): Promise<WatchEntryWithEvents> {
  const r = await api.get<WatchEntryWithEvents>(`/sell-futures/watch/${id}`);
  return r.data;
}

export async function getSellFuturesAccount() {
  const r = await api.get<SellFuturesPaperAccount>('/sell-futures/paper-account');
  return r.data;
}
