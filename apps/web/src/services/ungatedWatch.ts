import api from './api';
import type { UngatedWatchEntry, UngatedPaperAccount } from '../types/ungatedWatch.types';
import type { WatchEntryWithEvents, WatchStatus } from '../types/watch.types';

export async function listUngatedEntries(opts: { status?: WatchStatus; date?: string } = {}) {
  const r = await api.get<UngatedWatchEntry[]>('/ungated/watch', { params: opts });
  return r.data;
}

export async function getUngatedEntry(id: string): Promise<WatchEntryWithEvents> {
  const r = await api.get<WatchEntryWithEvents>(`/ungated/watch/${id}`);
  return r.data;
}

export async function getUngatedAccount() {
  const r = await api.get<UngatedPaperAccount>('/ungated/paper-account');
  return r.data;
}
