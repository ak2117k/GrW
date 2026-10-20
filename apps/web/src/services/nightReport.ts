import api from './api';
import type { NightReport } from '@/types/nightReport.types';

/** The caller's night report: everything that happened between the last close and now. */
export async function getNightReport(): Promise<NightReport> {
  const { data } = await api.get<NightReport>('/night-report');
  return data;
}

/** Owner-only: re-run the last session's night analysis with the current pipeline (runs in the background). */
export async function rerunNightAnalysis(): Promise<{ started: boolean; reason?: string }> {
  const { data } = await api.post<{ started: boolean; reason?: string }>('/trade-sentinel/night-analysis/rerun');
  return data;
}
