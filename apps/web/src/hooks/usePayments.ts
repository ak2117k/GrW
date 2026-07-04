import { useEffect, useState } from 'react';
import api from '@/services/api';

export interface PaymentRow {
  id: string;
  segment: string | null;
  amount: number;       // paise
  currency: string;
  status: 'CAPTURED' | 'FAILED' | 'REFUNDED' | string;
  providerPaymentId: string;
  invoiceUrl: string | null;
  description: string | null;
  createdAt: string;
}

/** Group payments by "YYYY-MM", newest month first (rows within a month keep
 *  server order — already newest-first from the endpoint). */
export function groupByMonth(rows: PaymentRow[]): { month: string; rows: PaymentRow[] }[] {
  const map = new Map<string, PaymentRow[]>();
  for (const r of rows) {
    const d = new Date(r.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    (map.get(key) ?? map.set(key, []).get(key)!).push(r);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([month, rs]) => ({ month, rows: rs }));
}

export function usePayments(): { payments: PaymentRow[]; loading: boolean; error: string | null } {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await api.get<PaymentRow[]>('/me/billing/payments');
        if (active) setPayments(data);
      } catch {
        if (active) setError('Could not load payments');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return { payments, loading, error };
}
