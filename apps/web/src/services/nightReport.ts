import api from './api';
import type { NightReport } from '@/types/nightReport.types';

/** The caller's night report: everything that happened between the last close and now. */
export async function getNightReport(): Promise<NightReport> {
  const { data } = await api.get<NightReport>('/night-report');
  return data;
}
