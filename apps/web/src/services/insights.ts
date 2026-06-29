import api from './api';

export interface AIInsight {
  id: string;
  sectionKey: string;
  contextKey: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  contextData: Record<string, unknown>;
  insight: string | null;
  confidence: number | null;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export async function requestInsight(
  sectionKey: string,
  contextKey: string,
  contextData: Record<string, unknown>,
): Promise<AIInsight> {
  const res = await api.post('/insights/request', { sectionKey, contextKey, contextData });
  return res.data;
}

export async function getLatestInsight(
  sectionKey: string,
  contextKey: string,
): Promise<AIInsight | null> {
  try {
    const res = await api.get(`/insights/${sectionKey}/${encodeURIComponent(contextKey)}`);
    return res.data;
  } catch (err: unknown) {
    // 404 = no insight yet
    if (
      typeof err === 'object' &&
      err !== null &&
      'response' in err &&
      typeof (err as { response?: { status?: number } }).response?.status === 'number' &&
      (err as { response: { status: number } }).response.status === 404
    ) {
      return null;
    }
    throw err;
  }
}
