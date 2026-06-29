import api from './api';
import type { DailyComparison } from '../types/adaptiveStopWatch.types';

export async function getAdaptiveStopComparison(date: string) {
  const r = await api.get<DailyComparison>('/adaptive-stop/comparison', { params: { date } });
  return r.data;
}
