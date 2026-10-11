import api from './api';

/**
 * SP2 M2: the caller's Risk Wall limits and kill switch. Mirrors the API's wire shapes in
 * apps/api/src/modules/trade-core/risk-wall/services/{core-risk-limit,core-kill-switch}.service.ts
 * (the API does not import @td/shared; M1 plan decision 13).
 */
export type CoreLimitScope = 'ALL' | 'CASH_INTRADAY' | 'MTF' | 'OPTIONS_BUY';
export type CoreLimitKind = 'rupees' | 'count' | 'ratio' | 'hhmm' | 'enum';
export type CoreLimitSource = 'USER' | 'USER_SETTINGS' | 'DEFAULT';

export interface CorePendingLimitView {
  value: number | string;
  effectiveFrom: string;
  setAt: string;
  reason: string;
}

export interface CoreRiskLimitView {
  key: string;
  scope: CoreLimitScope;
  kind: CoreLimitKind;
  tighter: 'lower' | 'earlier' | 'stricter';
  value: number | string | null;
  source: CoreLimitSource | null;
  needsReview: boolean;
  effectiveFrom: string | null;
  setAt: string | null;
  setBy: string | null;
  reason: string | null;
  pending: CorePendingLimitView | null;
}

export interface CoreLimitChangeResult {
  limit: CoreRiskLimitView;
  direction: 'TIGHTER' | 'SAME' | 'LOOSER';
  effectiveFrom: string;
}

export interface CoreKillSwitchView {
  active: boolean;
  since: string | null;
  reason: string | null;
  setBy: string | null;
  pendingRelease: { effectiveFrom: string; reason: string; setAt: string } | null;
}

export interface CoreSiloResult {
  target: string;
  status: 'OK' | 'FAILED' | 'SKIPPED' | 'UNAVAILABLE';
  detail: string;
}

export interface CoreKillSwitchCascade {
  core: { status: 'OK' | 'FAILED'; detail: string };
  silos: CoreSiloResult[];
}

export interface CoreKillSwitchSetResult {
  state: CoreKillSwitchView;
  effectiveFrom: string;
  cascade: CoreKillSwitchCascade | null;
}

/** The silo square-offs can take longer than the client's default 30 s. */
const KILL_SWITCH_TIMEOUT_MS = 120_000;

export async function listCoreRiskLimits(): Promise<CoreRiskLimitView[]> {
  const r = await api.get<{ limits: CoreRiskLimitView[] }>('/trade-core/risk/limits');
  return r.data.limits;
}

export async function changeCoreRiskLimit(key: string, scope: string, body: { value: number | string; reason: string }): Promise<CoreLimitChangeResult> {
  const r = await api.put<CoreLimitChangeResult>(`/trade-core/risk/limits/${encodeURIComponent(key)}/${encodeURIComponent(scope)}`, body);
  return r.data;
}

export async function getCoreKillSwitch(): Promise<CoreKillSwitchView> {
  const r = await api.get<CoreKillSwitchView>('/trade-core/risk/kill-switch');
  return r.data;
}

export async function setCoreKillSwitch(body: { active: boolean; reason: string }): Promise<CoreKillSwitchSetResult> {
  const r = await api.post<CoreKillSwitchSetResult>('/trade-core/risk/kill-switch', body, { timeout: KILL_SWITCH_TIMEOUT_MS });
  return r.data;
}
