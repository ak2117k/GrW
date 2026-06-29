import api from './api';
import type { WatchEntry, WatchEntryWithEvents, WatchStatus } from '../types/watch.types';

// Uses the shared authenticated axios client (`api`): attaches the Bearer
// token, refreshes on 401, and routes through the Vite /api proxy. Previously
// these were raw fetch() calls to API_BASE, which carried no auth token and so
// 401'd under the global JwtAuthGuard.
export const watchApi = {
  async list(status?: WatchStatus, date?: string): Promise<WatchEntry[]> {
    const res = await api.get<WatchEntry[]>('/watch', { params: { status, date } });
    return res.data;
  },

  async get(id: string): Promise<WatchEntryWithEvents> {
    const res = await api.get<WatchEntryWithEvents>(`/watch/${id}`);
    return res.data;
  },

  async execute(id: string, mode: 'paper' | 'live', quantity?: number) {
    const res = await api.post(`/watch/${id}/execute`, { mode, quantity });
    return res.data;
  },

  async dismiss(id: string) {
    const res = await api.post(`/watch/${id}/dismiss`);
    return res.data;
  },

  async close(id: string, reason: string) {
    const res = await api.post(`/watch/${id}/close`, { reason });
    return res.data;
  },
};
