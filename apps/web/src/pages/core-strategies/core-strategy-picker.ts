import type {
  CoreSelectionView,
  CoreStrategyVersionView,
  CoreStrategyView,
  CoreVersionStatus,
  SetCoreSelectionBody,
} from '@/services/coreStrategies';

/** Versions a user may select. Mirrors SELECTABLE_STATUSES in the API; LIVE joins at SP7. */
export const SELECTABLE_STATUSES: ReadonlySet<CoreVersionStatus> = new Set<CoreVersionStatus>(['PAPER']);

const STATUS_LABEL: Record<CoreVersionStatus, string> = { DRAFT: 'draft', PAPER: 'paper', LIVE: 'live', RETIRED: 'retired' };

export function versionLabel(v: CoreStrategyVersionView): string {
  return `v${v.version} · ${STATUS_LABEL[v.status] ?? v.status}${v.createdBy === 'AI' ? ' · AI-drafted' : ''}`;
}

export function selectableVersions(s: CoreStrategyView): CoreStrategyVersionView[] {
  return s.versions.filter((v) => SELECTABLE_STATUSES.has(v.status)).sort((a, b) => b.version - a.version);
}

export interface PickerRow {
  strategyId: string;
  options: { value: string; label: string }[];
  /** The version the form starts on: the saved one if still selectable, else the newest approved. */
  versionId: string | null;
  enabled: boolean;
  capitalText: string;
  /** A saved selection points at a version that can no longer trade (retired or hidden). */
  staleSelection: boolean;
}

export function pickerRow(s: CoreStrategyView, selection: CoreSelectionView | undefined): PickerRow {
  const selectable = selectableVersions(s);
  const chosen = selection ? selectable.find((v) => v.id === selection.strategyVersionId) : undefined;
  return {
    strategyId: s.id,
    options: selectable.map((v) => ({ value: v.id, label: versionLabel(v) })),
    versionId: chosen?.id ?? selectable[0]?.id ?? null,
    enabled: selection?.enabled ?? false,
    capitalText: selection ? String(selection.capitalAllocation) : '',
    staleSelection: selection !== undefined && chosen === undefined,
  };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Rupees: digits with optional Indian/Western grouping, ₹ and spaces, up to 2 decimals. */
export function parseCapital(text: string): Parsed<number> {
  const cleaned = text.replace(/[₹,\s]/g, '');
  if (cleaned === '') return { ok: false, error: 'Enter a capital allocation in ₹' };
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false, error: 'Capital must be a rupee amount like 200000 or 2,00,000' };
  return { ok: true, value: Number(cleaned) };
}

export function selectionPayload(form: { versionId: string | null; enabled: boolean; capitalText: string }): Parsed<SetCoreSelectionBody> {
  if (!form.versionId) return { ok: false, error: 'No approved version to select yet' };
  const capital = parseCapital(form.capitalText);
  if (!capital.ok) return capital;
  if (form.enabled && capital.value <= 0) return { ok: false, error: 'An enabled strategy needs capital above ₹0' };
  return { ok: true, value: { strategyVersionId: form.versionId, enabled: form.enabled, capitalAllocation: capital.value } };
}

export interface BlockLine {
  label: string;
  value: string;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const pct = (n: unknown): string => (typeof n === 'number' ? `${n}%` : '?');
const rupees = (n: unknown): string => (typeof n === 'number' ? `₹${n.toLocaleString('en-IN')}` : '?');

const BLOCK_ORDER: ReadonlyArray<readonly [string, string]> = [
  ['entry', 'Entry'], ['filters', 'Filters'], ['stop', 'Stop'], ['target', 'Target'], ['trail', 'Trail'],
  ['timeExit', 'Time exit'], ['partial', 'Partial'], ['sizing', 'Sizing'], ['vehicle', 'Vehicle'],
];

/** " · score ≥ 47 (≥ 75 11:45–14:00 IST)", or "" when there is no score gate. */
function scoreText(m: unknown): string {
  const o = asObj(m);
  if (!o) return '';
  const windows = (Array.isArray(o.windows) ? o.windows : [])
    .map(asObj)
    .filter((w): w is Obj => w !== null)
    .map((w) => `≥ ${String(w.score)} ${String(w.fromHhmm)}–${String(w.toHhmm)} IST`);
  return ` · score ≥ ${String(o.base)}${windows.length > 0 ? ` (${windows.join(', ')})` : ''}`;
}

function describeFilters(o: Obj): string {
  const parts: string[] = [];
  const stale = asObj(o.staleEntry);
  if (stale) parts.push(`skip if price ran > ${pct(stale.maxMovePct)} from the alert`);
  const cooldown = asObj(o.cooldown);
  if (cooldown) parts.push(`${String(cooldown.minutes)}-min cooldown per symbol`);
  if (asObj(o.lastLoss)) parts.push('skip after a same-day loss on the symbol');
  for (const g of Array.isArray(o.gates) ? o.gates : []) {
    const go = asObj(g);
    if (go) parts.push(`gate ${String(go.evaluatorKey)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'None';
}

function describeOne(key: string, o: Obj | null): string {
  if (!o) return '—';
  if (key === 'filters') return describeFilters(o);
  switch (`${key}:${String(o.kind)}`) {
    case 'entry:chartink': {
      const scan = o.match === 'ANY' ? 'any scan' : o.match === 'CONTAINS' ? `scan contains "${String(o.scanName)}"` : `scan "${String(o.scanName)}"`;
      return `Chartink · ${scan} · ${String(o.side)}${scoreText(o.minScore)}`;
    }
    case 'entry:evaluator':
      return `Evaluator ${String(o.evaluatorKey)} · ${String(o.side)}`;
    case 'stop:fixedPct':
      return `Fixed ${pct(o.pct)} from entry`;
    case 'stop:atr':
      return `ATR(${String(o.period)}, ${String(o.timeframe)}) × ${String(o.multiple)}, clamped ${pct(o.minPct)}–${pct(o.maxPct)}`;
    case 'target:fixedPct':
      return `+${pct(o.pct)} from entry`;
    case 'target:rr':
      return `${String(o.ratio)} × the initial risk`;
    case 'trail:none':
    case 'partial:none':
      return 'None';
    case 'trail:breakeven':
      return `Stop to entry at +${pct(o.atPct)}`;
    case 'trail:atr':
      return `ATR at entry × ${String(o.multiple)}, clamped ${pct(o.minPct)}–${pct(o.maxPct)}, ${o.startsAfter === 'PARTIAL' ? 'after the partial exit' : 'from entry'}`;
    case 'timeExit:clock':
      return `Exit at ${String(o.hhmm)} IST`;
    case 'timeExit:holdDays':
      return `Exit after ${String(o.n)} day(s)`;
    case 'partial:atTarget1':
      return `Sell ${typeof o.fraction === 'number' ? Math.round(o.fraction * 100) : '?'}% at +${pct(o.atPct)}`;
    case 'sizing:riskRupees':
      return `Risk ${rupees(o.amount)} per trade`;
    case 'sizing:notionalRupees':
      return `${rupees(o.amount)} notional per trade`;
    case 'vehicle:CASH_INTRADAY':
      return 'Cash intraday';
    case 'vehicle:MTF':
      return 'MTF';
    case 'vehicle:OPTIONS_BUY': {
      const theta = asObj(o.thetaStop);
      return `Options buy · ${String(o.strike)} · expiry ≥ ${String(o.minDaysToExpiry)} days · premium stop ${pct(o.premiumStopPct)}` +
        ` · theta stop ${theta ? `${pct(theta.minMovePct)} in ${String(theta.withinMinutes)} min` : '?'}` +
        ` · expiry-day exit ${String(o.expiryDayExitHhmm)}`;
    }
    default:
      return JSON.stringify(o);
  }
}

/** Read-only, human wording of a version's blocks. Never throws on odd data. */
export function describeBlocks(blocks: unknown): BlockLine[] {
  const b = asObj(blocks);
  if (!b) return [{ label: 'Blocks', value: 'not readable' }];
  return BLOCK_ORDER.map(([key, label]) => ({ label, value: describeOne(key, asObj(b[key])) }));
}

/** The text to toast for a failed call (the axios interceptor toasts only 401/429/5xx). */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const m = (err as { response?: { data?: { message?: unknown } } } | undefined)?.response?.data?.message;
  if (typeof m === 'string' && m.trim() !== '') return m;
  if (Array.isArray(m) && m.length > 0) return m.join('; ');
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
