import api from './api';
import type { DailyComparison } from '../types/ungatedWatch.types';

export async function getDailyComparison(date: string) {
  const r = await api.get<DailyComparison>('/ungated/comparison', { params: { date } });
  return r.data;
}
