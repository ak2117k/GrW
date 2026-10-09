import api from './api';

/**
 * SP2 trade-core strategy catalogue and the caller's selections. Mirrors the API's
 * wire shapes in apps/api/src/modules/trade-core/strategies/dto/core-strategy.dto.ts
 * (the API does not import @td/shared; see the M1 plan, decision 13).
 */
export type CoreVersionStatus = 'DRAFT' | 'PAPER' | 'LIVE' | 'RETIRED';

export interface CoreStrategyVersionView {
  id: string;
  strategyId: string;
  version: number;
  status: CoreVersionStatus;
  blocks: unknown;
  createdBy: 'OWNER' | 'AI';
  approvedBy: string | null;
  approvedAt: string | null;
  sourceDocId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CoreStrategyView {
  id: string;
  key: string;
  name: string;
  description: string;
  allowedVehicles: string[];
  createdAt: string;
  versions: CoreStrategyVersionView[];
}

export interface CoreSelectionView {
  id: string;
  strategyId: string;
  strategyVersionId: string;
  enabled: boolean;
  capitalAllocation: number;
  updatedAt: string;
}

export interface SetCoreSelectionBody {
  strategyVersionId: string;
  enabled: boolean;
  capitalAllocation: number;
}

export async function listCoreStrategies(): Promise<CoreStrategyView[]> {
  const r = await api.get<{ strategies: CoreStrategyView[] }>('/trade-core/strategies');
  return r.data.strategies;
}

export async function listCoreSelections(): Promise<CoreSelectionView[]> {
  const r = await api.get<{ selections: CoreSelectionView[] }>('/trade-core/strategy-selections');
  return r.data.selections;
}

export async function setCoreSelection(strategyId: string, body: SetCoreSelectionBody): Promise<CoreSelectionView> {
  const r = await api.put<CoreSelectionView>(`/trade-core/strategy-selections/${encodeURIComponent(strategyId)}`, body);
  return r.data;
}

/** Owner only (the API answers 403 to anyone else). */
export async function approveCoreVersion(versionId: string): Promise<CoreStrategyVersionView> {
  const r = await api.post<CoreStrategyVersionView>(`/trade-core/strategy-versions/${encodeURIComponent(versionId)}/approve`);
  return r.data;
}
