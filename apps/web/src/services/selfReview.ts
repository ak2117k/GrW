import api from './api';
import type {
  AgentLesson,
  ProposalStatus,
  SelfReviewLatest,
  SelfReviewRun,
  TuningProposal,
  VerificationResult,
} from '@/types/selfReview.types';

/** Some list endpoints wrap rows (`{ items }` / `{ rows }`); accept either shape. */
function rows<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const k of ['items', 'rows', 'data', 'proposals', 'lessons', 'runs', 'results']) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}

export async function getLatestSelfReview(): Promise<SelfReviewLatest> {
  const { data } = await api.get<SelfReviewLatest>('/self-review/latest');
  return data;
}

export async function getSelfReviewRuns(limit = 30): Promise<SelfReviewRun[]> {
  const { data } = await api.get('/self-review/runs', { params: { limit } });
  return rows<SelfReviewRun>(data);
}

export async function getSelfReviewResults(session: string, kind?: string): Promise<VerificationResult[]> {
  const { data } = await api.get('/self-review/results', { params: { session, ...(kind ? { kind } : {}) } });
  return rows<VerificationResult>(data);
}

export async function getLessons(): Promise<AgentLesson[]> {
  const { data } = await api.get('/self-review/lessons');
  return rows<AgentLesson>(data);
}

export async function retireLesson(id: string): Promise<AgentLesson | void> {
  const { data } = await api.post(`/self-review/lessons/${encodeURIComponent(id)}/retire`);
  return data as AgentLesson | void;
}

export async function getProposals(status?: ProposalStatus): Promise<TuningProposal[]> {
  const { data } = await api.get('/self-review/proposals', { params: status ? { status } : {} });
  return rows<TuningProposal>(data);
}

export async function approveProposal(id: string): Promise<TuningProposal | void> {
  const { data } = await api.post(`/self-review/proposals/${encodeURIComponent(id)}/approve`);
  return data as TuningProposal | void;
}

export async function rejectProposal(id: string): Promise<TuningProposal | void> {
  const { data } = await api.post(`/self-review/proposals/${encodeURIComponent(id)}/reject`);
  return data as TuningProposal | void;
}

/** Owner-only: re-run the review for the last closed session (background). */
export async function rerunSelfReview(): Promise<{ started: boolean; reason?: string }> {
  const { data } = await api.post<{ started: boolean; reason?: string }>('/self-review/run');
  return data;
}
