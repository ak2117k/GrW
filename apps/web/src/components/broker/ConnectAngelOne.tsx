import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, Eye, EyeOff, Plug } from 'lucide-react';
import { LoadingSkeleton } from '@/components/common';
import api from '@/services/api';
import toast from 'react-hot-toast';

// ---- Connect Angel One (TDA-005) ----

interface BrokerStatusResponse {
  connected: boolean;
  clientIdMasked?: string | null;
  lastValidated?: string | null;
}

/** Compact relative-time (e.g. "2m ago"); falls back to a locale date. */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString('en-IN');
}

const EMPTY_BROKER_FORM = {
  apiKey: '',
  apiSecret: '',
  clientId: '',
  password: '',
  totpSecret: '',
};

/**
 * Real "Connect Angel One" flow (TDA-005): a 5-field form whose secrets are
 * masked and NEVER pre-filled from the server (status returns only a masked
 * client-id). Posts to POST /api/broker/connect (validate + envelope-encrypt +
 * store); renders GET /api/broker/status and a Disconnect button
 * (DELETE /api/broker). On 422 shows a generic rejection (no raw broker message).
 */
export function ConnectAngelOne() {
  const [status, setStatus] = useState<BrokerStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...EMPTY_BROKER_FORM });
  const [showSecrets, setShowSecrets] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<BrokerStatusResponse>('/broker/status');
      setStatus(data);
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const canSubmit =
    form.apiKey.trim() &&
    form.apiSecret.trim() &&
    form.clientId.trim() &&
    form.password.trim() &&
    form.totpSecret.trim();

  const handleConnect = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.post('/broker/connect', form);
      toast.success('Broker connected');
      setForm({ ...EMPTY_BROKER_FORM }); // never retain secrets in memory
      await loadStatus();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      toast.error(
        status === 422
          ? 'Angel One rejected these credentials'
          : 'Could not connect to Angel One',
      );
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, form, loadStatus]);

  const handleDisconnect = useCallback(async () => {
    try {
      await api.delete('/broker');
      toast.success('Broker disconnected');
      await loadStatus();
    } catch {
      toast.error('Failed to disconnect');
    }
  }, [loadStatus]);

  if (loading) {
    return <LoadingSkeleton variant="card" count={1} className="h-24" />;
  }

  if (status?.connected) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
            <CheckCircle size={12} />
            Connected
          </span>
          <span className="text-sm text-gray-300">
            as {status.clientIdMasked ?? 'Angel One'}
          </span>
          {status.lastValidated && (
            <span className="text-[11px] text-gray-500">
              · validated {relativeTime(status.lastValidated)}
            </span>
          )}
        </div>
        <button
          onClick={handleDisconnect}
          className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  const fields: { key: keyof typeof form; label: string; secret: boolean }[] = [
    { key: 'apiKey', label: 'API Key', secret: false },
    { key: 'apiSecret', label: 'API Secret', secret: true },
    { key: 'clientId', label: 'Client ID', secret: false },
    { key: 'password', label: 'Password / PIN', secret: true },
    { key: 'totpSecret', label: 'TOTP Secret', secret: true },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-gray-400">{f.label}</label>
            <input
              type={f.secret && !showSecrets ? 'password' : 'text'}
              value={form[f.key]}
              autoComplete="off"
              onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
              placeholder={`Enter ${f.label.toLowerCase()}`}
              className="rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between pt-1">
        <button
          onClick={() => setShowSecrets((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showSecrets ? <EyeOff size={13} /> : <Eye size={13} />}
          {showSecrets ? 'Hide secrets' : 'Show secrets'}
        </button>
        <button
          onClick={handleConnect}
          disabled={!canSubmit || submitting}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plug size={12} />
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      <p className="text-[10px] text-gray-600">
        Credentials are validated with a live Angel One login, then encrypted at rest.
        Nothing is stored if the login fails.
      </p>
    </div>
  );
}
