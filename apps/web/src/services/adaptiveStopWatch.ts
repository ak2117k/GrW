import api from './api';
import type { AdaptiveStopWatchEntry, AdaptiveStopPaperAccount } from '../types/adaptiveStopWatch.types';
import type { WatchEntryWithEvents, WatchStatus } from '../types/watch.types';

export async function listAdaptiveStopEntries(opts: { status?: WatchStatus; date?: string } = {}) {
  const r = await api.get<AdaptiveStopWatchEntry[]>('/adaptive-stop/watch', { params: opts });
  return r.data;
}

export async function getAdaptiveStopEntry(id: string): Promise<WatchEntryWithEvents> {
  const r = await api.get<WatchEntryWithEvents>(`/adaptive-stop/watch/${id}`);
  return r.data;
}

export async function getAdaptiveStopAccount() {
  const r = await api.get<AdaptiveStopPaperAccount>('/adaptive-stop/paper-account');
  return r.data;
}
