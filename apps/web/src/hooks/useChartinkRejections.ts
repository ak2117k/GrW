import { useCallback, useEffect, useState } from 'react';
import {
  getRejections,
  type RejectionsResponse,
  type RejectionRow,
  type RejectionSummary,
} from '@/services/chartink';

/** Today's date as a YYYY-MM-DD string in local time (for the date input). */
export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Build an ISO {from,to} range spanning the full local calendar day for a
 * YYYY-MM-DD input. `from` is 00:00:00.000, `to` is 23:59:59.999 local time.
 */
export function dayRangeFor(date: string): { from: string; to: string } {
  const [y, m, d] = date.split('-').map(Number);
  const from = new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
  const to = new Date(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

const EMPTY_SUMMARY: RejectionSummary = {
  totalProcessed: 0,
  accepted: 0,
  rejected: 0,
  byKind: [],
};

export function useChartinkRejections(initialDate: string = todayStr()) {
  const [date, setDate] = useState<string>(initialDate);
  const [summary, setSummary] = useState<RejectionSummary>(EMPTY_SUMMARY);
  const [rejections, setRejections] = useState<RejectionRow[]>([]);
  const [range, setRange] = useState<RejectionsResponse['range'] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchRejections = useCallback(async () => {
    setIsLoading(true);
    try {
      const { from, to } = dayRangeFor(date);
      const res = await getRejections({ from, to });
      setSummary(res?.summary ?? EMPTY_SUMMARY);
      setRejections(res?.rejections ?? []);
      setRange(res?.range ?? null);
    } catch {
      // soft-fail; the axios interceptor surfaces toasts
    } finally {
      setIsLoading(false);
    }
  }, [date]);

  useEffect(() => {
    fetchRejections();
  }, [fetchRejections]);

  return {
    date,
    setDate,
    summary,
    rejections,
    range,
    isLoading,
    refresh: fetchRejections,
  };
}
