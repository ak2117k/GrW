import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api';

// GET /api/me/auto-exec + PATCH /api/me/auto-exec/:segment (TDA-017).
export type AutoExecSegment = 'INTRADAY' | 'SWING';

export interface AutoExecState {
  segment: AutoExecSegment;
  enabled: boolean;
  killSwitch: boolean;
  riskPerTrade: number | null;
  maxCapital: number | null;
  enabledAt: string | null;
}

export interface AutoExecPatch {
  enabled?: boolean;
  killSwitch?: boolean;
  riskPerTrade?: number | null;
  maxCapital?: number | null;
}

/**
 * Result of an `update()`. When enabling is refused because the user has not
 * accepted the current risk disclosure, the backend answers 409 — we surface
 * that as `{ ok: false, consentRequired: true }` so the UI can show the consent
 * message AND revert the toggle rather than leave it visually on.
 */
export type AutoExecUpdateResult =
  | { ok: true }
  | { ok: false; consentRequired: boolean; message: string };

const CONSENT_MESSAGE =
  'Accept the risk disclosure in Settings before enabling auto-execution';

export interface UseAutoExec {
  segments: AutoExecState[];
  loading: boolean;
  error: string | null;
  update: (segment: AutoExecSegment, patch: AutoExecPatch) => Promise<AutoExecUpdateResult>;
}

/**
 * Loads both segments' auto-execution controls on mount (a plain DB read — no
 * broker login) and exposes `update()` which PATCHes one segment then refreshes
 * from the server so the rendered state always mirrors persisted truth.
 */
export function useAutoExec(): UseAutoExec {
  const [segments, setSegments] = useState<AutoExecState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<AutoExecState[]>('/me/auto-exec');
      setSegments(Array.isArray(data) ? data : []);
    } catch {
      setError('Could not load auto-execution settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = useCallback(
    async (segment: AutoExecSegment, patch: AutoExecPatch): Promise<AutoExecUpdateResult> => {
      try {
        await api.patch(`/me/auto-exec/${segment.toUpperCase()}`, patch);
        await load();
        return { ok: true };
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        // 409 = enabling refused because the risk disclosure isn't accepted.
        if (status === 409 && patch.enabled === true) {
          return { ok: false, consentRequired: true, message: CONSENT_MESSAGE };
        }
        return {
          ok: false,
          consentRequired: false,
          message: 'Could not save auto-execution settings.',
        };
      }
    },
    [load],
  );

  return { segments, loading, error, update };
}
