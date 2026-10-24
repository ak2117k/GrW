import api from '@/services/api';
import type { AiOutcome, AiStatus, CheckReport, StrategyReview, StrategySuggestions } from '@/components/strategy/strategyAi';

/** Unwrap the API's `{ data }` envelope when present. */
function unwrap<T>(res: { data: unknown }): T {
  const body = res.data as { data?: T } | T;
  return (body && typeof body === 'object' && 'data' in (body as object) ? (body as { data: T }).data : body) as T;
}

// The AI calls can wait up to ~20 s for a free model slot plus the model's own time.
const AI_TIMEOUT_MS = 200_000;

export async function checkStrategy(state: Record<string, unknown>, signal?: AbortSignal): Promise<{ checks: CheckReport; ai: AiStatus }> {
  return unwrap(await api.post('/strategy-builder/check', { state }, { signal }));
}

export async function getStrategyAiStatus(): Promise<AiStatus> {
  return unwrap(await api.get('/strategy-builder/ai/status'));
}

export async function reviewStrategy(state: Record<string, unknown>, backtest: Record<string, number> | null): Promise<AiOutcome<StrategyReview>> {
  return unwrap(await api.post('/strategy-builder/ai/review', { state, ...(backtest ? { backtest } : {}) }, { timeout: AI_TIMEOUT_MS }));
}

export async function suggestStrategy(state: Record<string, unknown>): Promise<AiOutcome<StrategySuggestions>> {
  return unwrap(await api.post('/strategy-builder/ai/suggest', { state }, { timeout: AI_TIMEOUT_MS }));
}
