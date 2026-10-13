import type {
  CoreKillSwitchCascade,
  CoreKillSwitchView,
  CoreLimitChangeResult,
  CoreLimitKind,
  CoreRiskLimitView,
} from '@/services/coreRisk';

/** Pure logic for the Core Risk page (spec §8.4). The server decides; these functions only parse, preview and word. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const LIMIT_LABELS: Record<string, string> = {
  maxDailyLoss: 'Max daily loss (realised + open)',
  maxDailyLossPerStrategy: 'Max daily loss per strategy',
  maxTradesPerDay: 'Max entries per day',
  maxOpenPositions: 'Max open positions',
  maxRiskPerTrade: 'Max risk per trade',
  maxCapitalDeployed: 'Max capital deployed',
  mtfMaxLeverage: 'MTF max leverage',
  mtfMaxHoldDays: 'MTF max hold days',
  optionsMaxPremiumPerTrade: 'Max option premium per trade',
  lastEntryTime: 'Last entry time',
  squareOffTime: 'Square-off time',
  dailyLossAction: 'When the daily loss is hit',
};

const SCOPE_LABELS: Record<string, string> = {
  ALL: 'All vehicles',
  CASH_INTRADAY: 'Cash intraday',
  MTF: 'MTF',
  OPTIONS_BUY: 'Options buying',
};

const SILO_LABELS: Record<string, string> = {
  'auto-execution': 'Auto-execution',
  'watch-monitor': 'Watch monitor',
  'adaptive-stop-track': 'Adaptive-Stop silo',
  'ungated-track': 'Ungated silo',
  'sell-futures-track': 'Sell-futures silo',
  'anand-dual-track': 'Anand dual-track silo',
  'breakout-swing-track': 'Breakout-swing silo',
  'trade-engine': 'Trade engine',
};

/** Loosest first, as the API orders them. */
export const DAILY_LOSS_ACTION_OPTIONS = [
  { value: 'BLOCK_ENTRIES', label: 'Block new entries' },
  { value: 'BLOCK_AND_SQUARE_OFF', label: 'Block entries and square off' },
] as const;

export const KILL_CONFIRM_WORD = 'KILL';

export const limitLabel = (key: string): string => LIMIT_LABELS[key] ?? key;
export const scopeLabel = (scope: string): string => SCOPE_LABELS[scope] ?? scope;

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 13 Oct, 09:15 IST", whatever the browser's time zone. */
export function formatIst(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 5.5 * 60 * 60 * 1000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

export function formatLimitValue(kind: CoreLimitKind, value: number | string | null): string {
  if (value === null) return 'not set';
  switch (kind) {
    case 'rupees':
      return typeof value === 'number' ? `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : String(value);
    case 'count':
      return String(value);
    case 'ratio':
      return `${value}×`;
    case 'hhmm':
      return `${value} IST`;
    case 'enum':
      return DAILY_LOSS_ACTION_OPTIONS.find((o) => o.value === value)?.label ?? String(value);
  }
}

export type LimitBadge = 'missing' | 'pending' | 'review' | null;

export interface LimitRow {
  id: string;
  key: string;
  scope: string;
  label: string;
  scopeLabel: string;
  valueText: string;
  badge: LimitBadge;
  /** "→ ₹8,000 from Tue 13 Oct, 09:15 IST" for a pending loosening. */
  pendingText: string | null;
  note: string | null;
}

export function limitRows(views: readonly CoreRiskLimitView[]): LimitRow[] {
  return views.map((v) => ({
    id: `${v.key}@${v.scope}`,
    key: v.key,
    scope: v.scope,
    label: limitLabel(v.key),
    scopeLabel: scopeLabel(v.scope),
    valueText: formatLimitValue(v.kind, v.value),
    badge: v.value === null ? 'missing' : v.pending ? 'pending' : v.needsReview ? 'review' : null,
    pendingText: v.pending ? `→ ${formatLimitValue(v.kind, v.pending.value)} from ${formatIst(v.pending.effectiveFrom)}` : null,
    note:
      v.value === null
        ? 'Not set: entries that need it are rejected'
        : v.needsReview
          ? 'Default — please review'
          : v.source === 'USER_SETTINGS'
            ? 'Copied from settings'
            : v.reason,
  }));
}

/** The starting text of an edit box for a user's limit or a seed default row. */
export function editText(view: { value: number | string | null }): string {
  return view.value === null ? '' : String(view.value);
}

export function parseLimitInput(kind: CoreLimitKind, text: string): Parsed<number | string> {
  const t = text.trim();
  switch (kind) {
    case 'rupees': {
      const c = t.replace(/[₹,\s]/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(c)) return { ok: false, error: 'Enter a rupee amount like 5000 or 5,000.50' };
      if (c.split('.')[0].replace(/^0+(?=\d)/, '').length > 12) return { ok: false, error: 'The amount must be below ₹10,00,00,00,00,000' };
      return { ok: true, value: Number(c) };
    }
    case 'count':
      return /^\d{1,12}$/.test(t) ? { ok: true, value: Number(t) } : { ok: false, error: 'Enter a whole number' };
    case 'ratio':
      return /^\d+(\.\d{1,2})?$/.test(t) && Number(t) >= 1 ? { ok: true, value: Number(t) } : { ok: false, error: 'Enter a leverage of 1 or more, like 2 or 2.5' };
    case 'hhmm':
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? { ok: true, value: t } : { ok: false, error: 'Enter an IST time as HH:MM, like 15:00' };
    case 'enum':
      return DAILY_LOSS_ACTION_OPTIONS.some((o) => o.value === t) ? { ok: true, value: t } : { ok: false, error: 'Pick an action' };
  }
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const actionRank = (v: string) => DAILY_LOSS_ACTION_OPTIONS.findIndex((o) => o.value === v);

/** A preview of the API's compareLimit (D5). The server decides; this only words the hint. */
export function previewDirection(view: CoreRiskLimitView, value: number | string): 'TIGHTER' | 'SAME' | 'LOOSER' {
  if (view.value === null) return 'LOOSER';
  let diff: number;
  if (view.kind === 'hhmm') diff = minutes(String(value)) - minutes(String(view.value));
  else if (view.kind === 'enum') diff = actionRank(String(view.value)) - actionRank(String(value));
  else diff = Number(value) - Number(view.value);
  return diff < 0 ? 'TIGHTER' : diff === 0 ? 'SAME' : 'LOOSER';
}

export function changeHint(view: CoreRiskLimitView, value: number | string): string {
  switch (previewDirection(view, value)) {
    case 'TIGHTER':
      return 'Tighter: takes effect immediately.';
    case 'SAME':
      return 'Same as now: takes effect immediately and cancels any pending change.';
    default:
      return 'Looser: takes effect at the next session open.';
  }
}

/** Mirrors the API's isReason: 3+ characters after trimming, at most 500 as typed. */
export function validReason(reason: string): Parsed<string> {
  const r = reason.trim();
  return r.length >= 3 && reason.length <= 500 ? { ok: true, value: r } : { ok: false, error: 'Give a reason (3 to 500 characters)' };
}

/** The `{ value, reason }` body for any limit of `kind` (a user's limit or, later, an owner seed default). */
export function kindChangePayload(kind: CoreLimitKind, text: string, reason: string): Parsed<{ value: number | string; reason: string }> {
  const v = parseLimitInput(kind, text);
  if (!v.ok) return v;
  const r = validReason(reason);
  if (!r.ok) return r;
  return { ok: true, value: { value: v.value, reason: r.value } };
}

export function limitChangePayload(view: CoreRiskLimitView, text: string, reason: string): Parsed<{ value: number | string; reason: string }> {
  return kindChangePayload(view.kind, text, reason);
}

export function changeResultMessage(r: CoreLimitChangeResult): string {
  const name = `${limitLabel(r.limit.key)} (${scopeLabel(r.limit.scope)})`;
  if (r.direction === 'LOOSER' && r.limit.pending) {
    return `${name} becomes ${formatLimitValue(r.limit.kind, r.limit.pending.value)} at ${formatIst(r.effectiveFrom)}`;
  }
  return `${name} is now ${formatLimitValue(r.limit.kind, r.limit.value)}`;
}

export interface KillSwitchSummary {
  headline: string;
  tone: 'danger' | 'ok';
  detail: string | null;
  releaseText: string | null;
}

export function killSwitchSummary(k: CoreKillSwitchView): KillSwitchSummary {
  if (!k.active) return { headline: 'Kill switch off', tone: 'ok', detail: k.reason ? `last change: ${k.reason}` : null, releaseText: null };
  const detail = [k.since ? `since ${formatIst(k.since)}` : null, k.reason].filter((x): x is string => !!x).join(' · ');
  return {
    headline: 'Kill switch ON: every core entry is blocked',
    tone: 'danger',
    detail: detail || null,
    releaseText: k.pendingRelease ? `Release scheduled for ${formatIst(k.pendingRelease.effectiveFrom)} (${k.pendingRelease.reason})` : null,
  };
}

export function killSwitchPayload(turnOn: boolean, reason: string, confirmText: string): Parsed<{ active: boolean; reason: string }> {
  const r = validReason(reason);
  if (!r.ok) return r;
  if (turnOn && confirmText.trim().toUpperCase() !== KILL_CONFIRM_WORD) return { ok: false, error: `Type ${KILL_CONFIRM_WORD} to confirm` };
  return { ok: true, value: { active: turnOn, reason: r.value } };
}

export interface CascadeLine {
  text: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
}

const SILO_TONE = { OK: 'ok', FAILED: 'danger', UNAVAILABLE: 'warn', SKIPPED: 'muted' } as const;

export function cascadeLines(c: CoreKillSwitchCascade | null): CascadeLine[] {
  if (!c) return [];
  return [
    { text: `Core: ${c.core.detail}`, tone: c.core.status === 'OK' ? 'ok' : 'danger' },
    ...c.silos.map((s) => ({ text: `${SILO_LABELS[s.target] ?? s.target}: ${s.status} · ${s.detail}`, tone: SILO_TONE[s.status] })),
  ];
}
