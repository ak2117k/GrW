import api from './api';
import type { CoreLimitKind, CoreLimitScope } from './coreRisk';

/** SP2 M2 owner-only seed defaults. Mirrors core-risk-defaults.service.ts in the API. */
export interface CoreRiskDefaultView {
  key: string;
  scope: CoreLimitScope;
  kind: CoreLimitKind;
  tighter: 'lower' | 'earlier' | 'stricter';
  value: number | string | null;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function listCoreRiskDefaults(): Promise<CoreRiskDefaultView[]> {
  const r = await api.get<{ defaults: CoreRiskDefaultView[] }>('/trade-core/risk/defaults');
  return r.data.defaults;
}

export async function changeCoreRiskDefault(key: string, scope: string, body: { value: number | string; reason: string }): Promise<CoreRiskDefaultView> {
  const r = await api.put<CoreRiskDefaultView>(`/trade-core/risk/defaults/${encodeURIComponent(key)}/${encodeURIComponent(scope)}`, body);
  return r.data;
}
