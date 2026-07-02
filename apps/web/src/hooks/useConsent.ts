import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';

/** Mirrors the API `ConsentStatus` (TDA-009 spec §4). */
export interface ConsentStatus {
  currentVersion: string | null;
  accepted: boolean;
  acceptedVersion: string | null;
  requiresReconsent: boolean;
}

/** The active disclosure a USER is asked to accept (`GET /api/consent/current`). */
export interface CurrentConsent {
  documentId: string;
  kind: string;
  version: string;
  body: string;
  contentHash: string;
  createdAt: string;
}

/**
 * Pure selector (unit-tested): a user must accept when there is no resolved
 * status, when they have not accepted, or when a version bump requires
 * re-consent. Fail-closed — a null status counts as "needs consent".
 */
export function needsConsent(
  status: Pick<ConsentStatus, 'accepted' | 'requiresReconsent'> | null | undefined,
): boolean {
  if (!status) return true;
  return !(status.accepted && !status.requiresReconsent);
}

export interface UseConsent {
  status: ConsentStatus | null;
  current: CurrentConsent | null;
  loading: boolean;
  submitting: boolean;
  accept: () => Promise<void>;
  needsConsent: boolean;
}

/**
 * Fetches the caller's consent status; when acceptance is due it also fetches
 * the current disclosure to display. `accept()` POSTs the shown
 * `{ version, contentHash }` and refreshes status. Mirrors TDA-007's
 * `useSubscriptions`. On error we default to "needs consent" (fail-closed).
 */
export function useConsent(): UseConsent {
  const [status, setStatus] = useState<ConsentStatus | null>(null);
  const [current, setCurrent] = useState<CurrentConsent | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<ConsentStatus>('/consent/status');
      setStatus(data);
      if (needsConsent(data)) {
        const cur = await api.get<CurrentConsent>('/consent/current');
        setCurrent(cur.data);
      } else {
        setCurrent(null);
      }
    } catch {
      setStatus(null);
      setCurrent(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let on = true;
    void (async () => {
      if (on) await refresh();
    })();
    return () => {
      on = false;
    };
  }, [refresh]);

  const accept = useCallback(async () => {
    if (!current) return;
    setSubmitting(true);
    try {
      await api.post('/consent/accept', {
        version: current.version,
        contentHash: current.contentHash,
      });
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }, [current, refresh]);

  return {
    status,
    current,
    loading,
    submitting,
    accept,
    needsConsent: needsConsent(status),
  };
}
