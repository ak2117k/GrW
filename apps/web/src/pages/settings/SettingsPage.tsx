import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Settings,
  Shield,
  Bot,
  Bell,
  Trash2,
  RotateCcw,
  Eye,
  EyeOff,
  Zap,
  Layers,
  CheckCircle,
  AlertTriangle,
  CreditCard,
  Plug,
  FileText,
  Mail,
  LogOut,
} from 'lucide-react';
import { Toggle, Modal, Badge, LoadingSkeleton } from '@/components/common';
import { cn } from '@/utils/cn';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSubscriptions } from '@/hooks/useSubscriptions';
import { AutoTradeMode, Segment } from '@/types';
import type { TradingSettings } from '@/types';
import api from '@/services/api';
import toast from 'react-hot-toast';
import { formatINR } from '@td/shared';

// ---- Types ----

interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  segments: string[];
  timeframes: string[];
}

interface NotificationSettings {
  enabled: boolean;
  signalAlerts: boolean;
  tradeExecution: boolean;
  pnlThreshold: boolean;
  newsAlerts: boolean;
}

// ---- Helpers ----

function SectionCard({
  icon,
  title,
  description,
  children,
  className,
  danger,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  danger?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-[var(--color-bg-secondary)] p-5',
        danger
          ? 'border-red-500/40'
          : 'border-[var(--color-border-subtle)]',
        className,
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={danger ? 'text-red-400' : 'text-gray-400'}>{icon}</span>
        <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
      </div>
      {description && (
        <p className="text-xs text-gray-500 mb-4">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </div>
  );
}

function FieldRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-700/40 last:border-0">
      <div className="flex-1 mr-4">
        <span className="text-sm text-gray-200">{label}</span>
        {description && (
          <p className="text-xs text-gray-500 mt-0.5">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const autoTradeModes: {
  value: AutoTradeMode;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  {
    value: AutoTradeMode.OFF,
    label: 'OFF',
    desc: 'Manual trading only',
    icon: <span className="text-gray-500">--</span>,
  },
  {
    value: AutoTradeMode.PAPER_TRADING,
    label: 'PAPER',
    desc: 'Simulated trades, no real money',
    icon: <Layers size={16} className="text-amber-400" />,
  },
  {
    value: AutoTradeMode.APPROVAL_REQUIRED,
    label: 'APPROVAL',
    desc: 'Signals require manual approval',
    icon: <CheckCircle size={16} className="text-blue-400" />,
  },
  {
    value: AutoTradeMode.FULLY_AUTOMATIC,
    label: 'AUTOMATIC',
    desc: 'Fully automated execution',
    icon: <Zap size={16} className="text-emerald-400" />,
  },
];

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
function ConnectAngelOne() {
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

// ---- USER account hub ----

/**
 * Account hub shown to a non-ADMIN USER. Real where possible
 * (subscription status from `useSubscriptions`, email + working logout from
 * the auth store); honest placeholders elsewhere. Each placeholder states the
 * capability it will deliver and the sprint that lands it, so nothing looks
 * fake-functional.
 */
function UserAccountHub() {
  const { intraday, swing, loading } = useSubscriptions();
  const email = useAuthStore((s) => s.user?.email);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Settings size={24} className="text-[var(--color-text-secondary)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Account</h1>
      </div>

      {/* Section 1: Subscriptions */}
      <SectionCard
        icon={<CreditCard size={18} />}
        title="Subscriptions"
        description="Your access to each signals segment"
      >
        {loading ? (
          <LoadingSkeleton variant="card" count={2} className="h-12" />
        ) : (
          <div className="space-y-2">
            {([
              { label: 'Intraday', active: intraday },
              { label: 'Swing', active: swing },
            ] as const).map((seg) => (
              <div
                key={seg.label}
                className="flex items-center justify-between rounded-lg border border-gray-700/60 bg-gray-800/30 p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-200">{seg.label}</span>
                  {seg.active ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                      <CheckCircle size={11} />
                      Active
                    </span>
                  ) : (
                    <span className="rounded-full bg-gray-700/40 px-2 py-0.5 text-[10px] font-medium text-gray-400">
                      Not subscribed
                    </span>
                  )}
                </div>
                <button
                  onClick={() => toast('Checkout coming soon')}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
                >
                  {seg.active ? 'Manage' : 'Subscribe'}
                </button>
              </div>
            ))}
            <p className="text-[10px] text-gray-600 pt-1">
              Billing and checkout arrive in TDA-015.
            </p>
          </div>
        )}
      </SectionCard>

      {/* Section 2: Connect Angel One */}
      <SectionCard
        icon={<Plug size={18} />}
        title="Connect Angel One"
        description="Connect your broker account to enable auto-execution"
      >
        <ConnectAngelOne />
      </SectionCard>

      {/* Section 3: Consent & disclaimer */}
      <SectionCard
        icon={<FileText size={18} />}
        title="Consent & Disclaimer"
        description="Review and accept the risk disclosure"
      >
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">
            Coming soon &mdash; the consent gate lands in TDA-009.
          </p>
          <button
            onClick={() => toast('Risk disclosure coming soon')}
            className="rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-700 transition-colors"
          >
            Review
          </button>
        </div>
      </SectionCard>

      {/* Section 4: Auto-execution */}
      <SectionCard
        icon={<Zap size={18} />}
        title="Auto-Execution"
        description="Let approved signals execute automatically"
      >
        <FieldRow
          label="Enable auto-execution"
          description="Available after you connect a broker and accept the disclosure (TDA-011)"
        >
          <Toggle checked={false} onChange={() => {}} disabled />
        </FieldRow>
      </SectionCard>

      {/* Section 5: Account */}
      <SectionCard
        icon={<Mail size={18} />}
        title="Account"
        description="Your sign-in details"
      >
        <FieldRow label="Email">
          <span className="text-sm text-gray-300">{email ?? '—'}</span>
        </FieldRow>
        <FieldRow
          label="Password"
          description="Change password becomes available in a later sprint"
        >
          <button
            onClick={() => toast('Change password coming soon')}
            className="rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-700 transition-colors"
          >
            Change
          </button>
        </FieldRow>
        <div className="flex items-center justify-between pt-3">
          <span className="text-xs text-gray-500">Sign out of this device</span>
          <button
            onClick={() => logout()}
            className="flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
          >
            <LogOut size={12} />
            Logout
          </button>
        </div>
      </SectionCard>
    </div>
  );
}

// ---- Main Component ----

/**
 * Settings entry point. ADMINs keep the full trading-configuration page;
 * non-ADMIN USERs get the account hub. Branching here (before either
 * component's hooks run) keeps the hooks rule intact — each child calls its
 * own hooks unconditionally.
 */
export default function SettingsPage() {
  const isAdmin = useAuthStore((s) => s.user?.role) === 'ADMIN';
  return isAdmin ? <AdminSettings /> : <UserAccountHub />;
}

function AdminSettings() {
  const settings = useSettingsStore((s) => s.settings);
  const isLoading = useSettingsStore((s) => s.isLoading);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  // Local state for non-store settings
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [strategiesLoading, setStrategiesLoading] = useState(true);
  const [notifications, setNotifications] = useState<NotificationSettings>({
    enabled: true,
    signalAlerts: true,
    tradeExecution: true,
    pnlThreshold: false,
    newsAlerts: true,
  });
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [clearHistoryModal, setClearHistoryModal] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState('');

  // Debounced save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedSave = useCallback(
    (newSettings: Partial<TradingSettings>) => {
      updateSettings(newSettings);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        try {
          await api.put('/settings', {
            ...settings,
            ...newSettings,
          });
          toast.success('Settings saved', { id: 'settings-saved', duration: 1500 });
        } catch {
          toast.error('Failed to save settings');
        }
      }, 500);
    },
    [settings, updateSettings],
  );

  // Load on mount
  useEffect(() => {
    loadSettings();
    // Fetch strategies
    (async () => {
      setStrategiesLoading(true);
      try {
        const { data } = await api.get('/signals/strategies');
        // Backend returns the StrategyRegistry shape:
        //   { name, description, supportedSegments, preferredTimeframes, parameters }
        // Frontend (this page) expects:
        //   { id, name, description, segments, timeframes }
        // Adapt at the fetch site so the rest of the page stays simple. The
        // backend's `name` doubles as the unique id.
        const raw: any[] = Array.isArray(data) ? data : (data?.strategies ?? data ?? []);
        setStrategies(
          raw.map((s) => ({
            id: s.id ?? s.name,
            name: s.name,
            description: s.description ?? '',
            segments: s.segments ?? s.supportedSegments ?? [],
            timeframes: s.timeframes ?? s.preferredTimeframes ?? [],
          })),
        );
      } catch {
        // Use defaults
        setStrategies([
          {
            id: 'rsi-reversal',
            name: 'RSI Reversal',
            description: 'Reversal signals based on RSI oversold/overbought zones',
            segments: ['EQUITY', 'OPTIONS'],
            timeframes: ['5m', '15m', '1h'],
          },
          {
            id: 'ema-crossover',
            name: 'EMA Crossover',
            description: 'Trend signals from EMA crossover patterns',
            segments: ['EQUITY', 'FUTURES'],
            timeframes: ['15m', '1h', '4h'],
          },
          {
            id: 'vwap-deviation',
            name: 'VWAP Deviation',
            description: 'Mean reversion signals using VWAP bands',
            segments: ['EQUITY', 'OPTIONS', 'FUTURES'],
            timeframes: ['5m', '15m'],
          },
        ]);
      } finally {
        setStrategiesLoading(false);
      }
    })();
  }, [loadSettings]);

  const handleStrategyToggle = useCallback(
    (strategyId: string) => {
      const current = settings.activeStrategies;
      const updated = current.includes(strategyId)
        ? current.filter((s) => s !== strategyId)
        : [...current, strategyId];
      debouncedSave({ activeStrategies: updated });
    },
    [settings.activeStrategies, debouncedSave],
  );

  const handleSegmentToggle = useCallback(
    (segment: Segment) => {
      const current = settings.preferredSegments;
      const updated = current.includes(segment)
        ? current.filter((s) => s !== segment)
        : [...current, segment];
      debouncedSave({ preferredSegments: updated });
    },
    [settings.preferredSegments, debouncedSave],
  );

  const handleResetSettings = useCallback(async () => {
    try {
      await api.post('/settings/reset');
      await loadSettings();
      toast.success('Settings reset to defaults');
    } catch {
      toast.error('Failed to reset settings');
    } finally {
      setResetModalOpen(false);
    }
  }, [loadSettings]);

  const handleClearHistory = useCallback(async () => {
    if (clearConfirmText !== 'DELETE') return;
    try {
      await api.delete('/portfolio/journal');
      toast.success('Trade history cleared');
    } catch {
      toast.error('Failed to clear history');
    } finally {
      setClearHistoryModal(false);
      setClearConfirmText('');
    }
  }, [clearConfirmText]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Settings size={24} className="text-[var(--color-text-secondary)]" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Settings</h1>
        </div>
        <LoadingSkeleton variant="card" count={4} className="mt-4" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Settings size={24} className="text-[var(--color-text-secondary)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Settings</h1>
      </div>

      {/* Section 1: Trading Configuration */}
      <SectionCard
        icon={<Bot size={18} />}
        title="Trading Configuration"
        description="Control how the auto-trade engine operates"
      >
        {/* Auto-trade Mode */}
        <div className="mb-4">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
            Auto-Trade Mode
          </span>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
            {autoTradeModes.map((mode) => {
              const isActive = settings.autoTradeMode === mode.value;
              return (
                <button
                  key={mode.value}
                  onClick={() => debouncedSave({ autoTradeMode: mode.value })}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-all',
                    isActive
                      ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40'
                      : 'border-gray-700 bg-gray-800/50 hover:border-gray-600',
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {mode.icon}
                    <span
                      className={cn(
                        'text-xs font-semibold',
                        isActive ? 'text-blue-400' : 'text-gray-300',
                      )}
                    >
                      {mode.label}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-500">{mode.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        <FieldRow
          label="Paper Trading"
          description="Simulate trades without using real capital"
        >
          <Toggle
            checked={settings.paperTrading}
            onChange={(v) => debouncedSave({ paperTrading: v })}
          />
        </FieldRow>

        <FieldRow
          label="Default Risk/Reward Ratio"
          description={`Current: 1:${settings.defaultRiskRewardRatio}`}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={settings.defaultRiskRewardRatio}
              onChange={(e) =>
                debouncedSave({ defaultRiskRewardRatio: Number(e.target.value) })
              }
              className="w-28 accent-blue-500"
            />
            <span className="text-xs text-gray-300 w-8 text-right">
              {settings.defaultRiskRewardRatio}
            </span>
          </div>
        </FieldRow>

        <FieldRow
          label="Trading Hours Only"
          description="Only execute trades during market hours (9:15 AM - 3:30 PM IST)"
        >
          <Toggle
            checked={settings.tradingHoursOnly}
            onChange={(v) => debouncedSave({ tradingHoursOnly: v })}
          />
        </FieldRow>
      </SectionCard>

      {/* Section 2: Risk Management */}
      <SectionCard
        icon={<Shield size={18} />}
        title="Risk Management"
        description="Set limits to protect your capital"
      >
        <FieldRow
          label="Max Daily Loss"
          description={`Current: ${formatINR(settings.maxDailyLoss)}`}
        >
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">&#8377;</span>
            <input
              type="number"
              min={100}
              step={100}
              value={settings.maxDailyLoss}
              onChange={(e) => {
                const val = Number(e.target.value);
                if (val >= 100) debouncedSave({ maxDailyLoss: val });
              }}
              className="w-24 rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 text-right focus:border-blue-500 focus:outline-none"
            />
          </div>
        </FieldRow>

        <FieldRow
          label="Max Capital Per Trade"
          description={`Current: ${formatINR(settings.maxCapitalPerTrade)}`}
        >
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">&#8377;</span>
            <input
              type="number"
              min={100}
              step={100}
              value={settings.maxCapitalPerTrade}
              onChange={(e) =>
                debouncedSave({ maxCapitalPerTrade: Number(e.target.value) })
              }
              className="w-24 rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 text-right focus:border-blue-500 focus:outline-none"
            />
          </div>
        </FieldRow>

        <FieldRow
          label="Max Concurrent Positions"
          description={`Current: ${settings.maxConcurrentPositions}`}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={settings.maxConcurrentPositions}
              onChange={(e) =>
                debouncedSave({ maxConcurrentPositions: Number(e.target.value) })
              }
              className="w-28 accent-blue-500"
            />
            <span className="text-xs text-gray-300 w-6 text-right">
              {settings.maxConcurrentPositions}
            </span>
          </div>
        </FieldRow>
      </SectionCard>

      {/* Section 3: Strategy Management */}
      <SectionCard
        icon={<Zap size={18} />}
        title="Strategy Management"
        description="Enable or disable trading strategies"
      >
        {strategiesLoading ? (
          <LoadingSkeleton variant="card" count={3} className="h-16" />
        ) : (
          <div className="space-y-2">
            {strategies.map((strat) => {
              const isEnabled = settings.activeStrategies.includes(strat.id);
              return (
                <div
                  key={strat.id}
                  className={cn(
                    'flex items-center justify-between rounded-lg border p-3 transition-all',
                    isEnabled
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : 'border-gray-700/60 bg-gray-800/30',
                  )}
                >
                  <div className="flex-1 mr-3">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-gray-200">
                        {strat.name}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">{strat.description}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      {strat.segments.map((seg) => (
                        <Badge
                          key={seg}
                          label={seg}
                          variant="neutral"
                          size="sm"
                        />
                      ))}
                      <span className="text-[10px] text-gray-600 ml-1">
                        {strat.timeframes.join(', ')}
                      </span>
                    </div>
                  </div>
                  <Toggle
                    checked={isEnabled}
                    onChange={() => handleStrategyToggle(strat.id)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      {/* Section 4: Preferred Segments */}
      <SectionCard
        icon={<Layers size={18} />}
        title="Preferred Segments"
        description="Select which market segments to scan for signals"
      >
        <div className="flex flex-wrap gap-3">
          {[Segment.OPTIONS, Segment.EQUITY, Segment.FUTURES, Segment.COMMODITY].map(
            (seg) => {
              const isChecked = settings.preferredSegments.includes(seg);
              return (
                <label
                  key={seg}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-4 py-2.5 cursor-pointer transition-all',
                    isChecked
                      ? 'border-blue-500/40 bg-blue-500/10'
                      : 'border-gray-700 bg-gray-800/50 hover:border-gray-600',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleSegmentToggle(seg)}
                    className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500/40 focus:ring-offset-0"
                  />
                  <span
                    className={cn(
                      'text-sm font-medium',
                      isChecked ? 'text-blue-300' : 'text-gray-400',
                    )}
                  >
                    {seg}
                  </span>
                </label>
              );
            },
          )}
        </div>
      </SectionCard>

      {/* Section 5: Notifications */}
      <SectionCard
        icon={<Bell size={18} />}
        title="Notifications"
        description="Configure alert preferences"
      >
        <FieldRow label="Enable Notifications">
          <Toggle
            checked={notifications.enabled}
            onChange={(v) =>
              setNotifications((prev) => ({ ...prev, enabled: v }))
            }
          />
        </FieldRow>
        <FieldRow
          label="Signal Alerts"
          description="Get notified when new signals are generated"
        >
          <Toggle
            checked={notifications.signalAlerts}
            onChange={(v) =>
              setNotifications((prev) => ({ ...prev, signalAlerts: v }))
            }
            disabled={!notifications.enabled}
          />
        </FieldRow>
        <FieldRow
          label="Trade Execution Alerts"
          description="Notifications when trades are executed"
        >
          <Toggle
            checked={notifications.tradeExecution}
            onChange={(v) =>
              setNotifications((prev) => ({ ...prev, tradeExecution: v }))
            }
            disabled={!notifications.enabled}
          />
        </FieldRow>
        <FieldRow
          label="P&L Threshold Alerts"
          description="Alert when P&L crosses predefined thresholds"
        >
          <Toggle
            checked={notifications.pnlThreshold}
            onChange={(v) =>
              setNotifications((prev) => ({ ...prev, pnlThreshold: v }))
            }
            disabled={!notifications.enabled}
          />
        </FieldRow>
        <FieldRow
          label="News Alerts"
          description="Breaking market news notifications"
        >
          <Toggle
            checked={notifications.newsAlerts}
            onChange={(v) =>
              setNotifications((prev) => ({ ...prev, newsAlerts: v }))
            }
            disabled={!notifications.enabled}
          />
        </FieldRow>
      </SectionCard>

      {/* Section 6: Danger Zone */}
      <SectionCard
        icon={<AlertTriangle size={18} />}
        title="Danger Zone"
        description="Irreversible actions"
        danger
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-200">Reset All Settings</p>
              <p className="text-xs text-gray-500">
                Restore all settings to their default values
              </p>
            </div>
            <button
              onClick={() => setResetModalOpen(true)}
              className="flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <RotateCcw size={12} />
              Reset
            </button>
          </div>

          <div className="border-t border-gray-700/40" />

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-200">Clear Trade History</p>
              <p className="text-xs text-gray-500">
                Permanently delete all trade records
              </p>
            </div>
            <button
              onClick={() => setClearHistoryModal(true)}
              className="flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={12} />
              Clear All
            </button>
          </div>
        </div>
      </SectionCard>

      {/* Reset Confirmation Modal */}
      <Modal
        isOpen={resetModalOpen}
        onClose={() => setResetModalOpen(false)}
        title="Reset Settings"
        size="sm"
      >
        <p className="text-sm text-gray-300 mb-4">
          Are you sure you want to reset all settings to their default values?
          This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setResetModalOpen(false)}
            className="rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleResetSettings}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 transition-colors"
          >
            Reset All Settings
          </button>
        </div>
      </Modal>

      {/* Clear History Confirmation Modal */}
      <Modal
        isOpen={clearHistoryModal}
        onClose={() => {
          setClearHistoryModal(false);
          setClearConfirmText('');
        }}
        title="Clear Trade History"
        size="sm"
      >
        <p className="text-sm text-gray-300 mb-3">
          This will permanently delete all trade records. This action is
          irreversible.
        </p>
        <p className="text-xs text-gray-400 mb-2">
          Type <span className="font-mono text-red-400">DELETE</span> to confirm:
        </p>
        <input
          type="text"
          value={clearConfirmText}
          onChange={(e) => setClearConfirmText(e.target.value)}
          placeholder="Type DELETE"
          className="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-red-500 focus:outline-none mb-4"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={() => {
              setClearHistoryModal(false);
              setClearConfirmText('');
            }}
            className="rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleClearHistory}
            disabled={clearConfirmText !== 'DELETE'}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Delete All History
          </button>
        </div>
      </Modal>
    </div>
  );
}
