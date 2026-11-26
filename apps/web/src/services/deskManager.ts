import api from './api';

export interface DeskPnlPath {
  realised: number;
  open: number;
  total: number;
  peak: number;
  drawdownFromPeak: number;
  lossStreak: number;
}

export interface DeskGuard {
  blocked: boolean;
  reasons: string[];
  path: DeskPnlPath;
  pausedUntil: string | null;
  pauseScope: string | null;
}

export interface DeskState {
  mode: 'off' | 'shadow' | 'live';
  opensBlocked: boolean;
  lastCompletedAt: string | null;
  lastRun: { id: string; startedAt: string; finishedAt: string | null; summary: string | null; error: string | null; wakeReasons: unknown; packetMs: number | null; aiMs: number | null; mode: string } | null;
  guard: DeskGuard | { error: string };
  dataHoles: Array<{ code: string; count: number }>;
}

export interface DeskDecision {
  id: string;
  runId: string;
  action: string;
  underlying: string | null;
  trackerId: string | null;
  payload: { reason?: string; evidence?: string[] } & Record<string, unknown>;
  validation: { ok: boolean; problems: string[] };
  status: string;
  result: { status?: string; detail?: string } | null;
  grade: Record<string, unknown> | null;
  createdAt: string;
}

export async function getDeskState(): Promise<DeskState> {
  const { data } = await api.get<DeskState>('/desk-manager/state');
  return data;
}

export async function getDeskDecisions(date?: string): Promise<DeskDecision[]> {
  const { data } = await api.get<DeskDecision[]>('/desk-manager/decisions', { params: date ? { date } : undefined });
  return data;
}

export async function resetDeskGuard(): Promise<DeskGuard> {
  const { data } = await api.post<DeskGuard>('/desk-manager/guard/reset');
  return data;
}

export async function pauseDesk(scope: string, minutes: number): Promise<DeskGuard> {
  const { data } = await api.post<DeskGuard>('/desk-manager/pause', { scope, minutes });
  return data;
}

export async function resumeDesk(): Promise<DeskGuard> {
  const { data } = await api.post<DeskGuard>('/desk-manager/resume');
  return data;
}
