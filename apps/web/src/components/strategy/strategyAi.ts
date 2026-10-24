/**
 * Strategy Builder ↔ /api/strategy-builder contract (pure; no React, no fetch).
 *
 * The server owns validation and the Claude guard rails; this file only builds
 * the payload, interprets the replies and applies an ACCEPTED edit. Edit field
 * names mirror apps/api/src/modules/strategy-builder-ai/domain/editable-fields.ts.
 */

export type StopKind = 'ATR' | 'PERCENT' | 'POINTS';
export type FillAt = 'next_open' | 'signal_close' | 'same_bar_open';

export interface StrategySettings {
  stopLossKind: StopKind | null;
  stopLossValue: number | null;
  targetKind: StopKind | null;
  targetValue: number | null;
  riskPerTradeRupees: number | null;
  capitalPerTradeRupees: number | null;
  maxOpenPositions: number | null;
  maxTradesPerDay: number | null;
  sessionStart: string | null;
  sessionEnd: string | null;
  fillAt: FillAt | null;
}

export const EMPTY_SETTINGS: StrategySettings = {
  stopLossKind: null,
  stopLossValue: null,
  targetKind: null,
  targetValue: null,
  riskPerTradeRupees: null,
  capitalPerTradeRupees: null,
  maxOpenPositions: null,
  maxTradesPerDay: null,
  sessionStart: null,
  sessionEnd: null,
  fillAt: null,
};

/** The slice of the builder store the server needs. */
export interface BuilderSnapshot {
  mode: 'script' | 'visual';
  name: string;
  description: string;
  timeframe: string;
  segment: string;
  instrument: string;
  code: string;
  indicators: unknown[];
  entryRules: unknown[];
  exitRules: unknown[];
  settings: StrategySettings;
}

export const EDITABLE_TOP_FIELDS = ['timeframe', 'segment', 'instrument'] as const;
export type EditField = (typeof EDITABLE_TOP_FIELDS)[number] | `settings.${keyof StrategySettings}`;

export interface AiEdit {
  field: string;
  value: string | number | null;
  reason: string;
}

export type CheckStatus = 'pass' | 'warn' | 'error';
export interface CheckItem {
  id: string;
  status: CheckStatus;
  label: string;
  details: string[];
}
export interface CheckReport {
  items: CheckItem[];
  errors: number;
  warnings: number;
}

export interface AiStatus {
  allowed: boolean;
  remaining: number;
  dailyCap: number;
}

export interface StrategyReview {
  summary: string;
  strengths: string[];
  risks: string[];
  regimes: { worksIn: string[]; failsIn: string[] };
  suggestions: AiEdit[];
  confidence: number;
  disclaimer: string;
  rejectedSuggestions: number;
}

export interface StrategySuggestions {
  edits: AiEdit[];
  note: string;
  rejectedEdits: number;
}

export type AiOutcome<T> =
  | { status: 'ok' | 'cached'; result: T; ai: AiStatus }
  | { status: 'blocked'; reason: string; message: string; retryAfterMs?: number; ai: AiStatus }
  | { status: 'busy' | 'error'; message: string; ai: AiStatus };

/** The request body's `state`. Visual-only / script-only parts are blanked so they never leak across modes. */
export function buildState(s: BuilderSnapshot, strategyKey?: string): Record<string, unknown> {
  return {
    ...(strategyKey ? { strategyKey } : {}),
    mode: s.mode,
    name: s.name,
    description: s.description,
    timeframe: s.timeframe,
    segment: s.segment,
    instrument: s.instrument,
    code: s.mode === 'script' ? s.code : '',
    indicators: s.mode === 'visual' ? s.indicators : [],
    entryRules: s.mode === 'visual' ? s.entryRules : [],
    exitRules: s.mode === 'visual' ? s.exitRules : [],
    settings: s.settings,
  };
}

export function isEditField(field: string): field is EditField {
  if ((EDITABLE_TOP_FIELDS as readonly string[]).includes(field)) return true;
  const m = field.match(/^settings\.(\w+)$/);
  return !!m && Object.prototype.hasOwnProperty.call(EMPTY_SETTINGS, m[1]);
}

export function readField(s: BuilderSnapshot, field: EditField): string | number | null {
  if (field === 'timeframe' || field === 'segment' || field === 'instrument') return s[field] || null;
  const key = field.slice('settings.'.length) as keyof StrategySettings;
  return s.settings[key];
}

export function isFieldEmpty(s: BuilderSnapshot, field: EditField): boolean {
  const v = readField(s, field);
  return v === null || v === '';
}

/**
 * The store update for ONE accepted edit, or null when it must not apply
 * (unknown field, or — for suggestions — the field was filled meanwhile).
 */
export function editPatch(
  s: BuilderSnapshot,
  edit: AiEdit,
  opts: { onlyIfEmpty?: boolean } = {},
): Partial<Pick<BuilderSnapshot, 'timeframe' | 'segment' | 'instrument' | 'settings'>> | null {
  if (!isEditField(edit.field)) return null;
  if (opts.onlyIfEmpty && !isFieldEmpty(s, edit.field)) return null;
  if (edit.field === 'timeframe' || edit.field === 'segment' || edit.field === 'instrument') {
    return typeof edit.value === 'string' ? { [edit.field]: edit.value } : null;
  }
  const key = edit.field.slice('settings.'.length) as keyof StrategySettings;
  return { settings: { ...s.settings, [key]: edit.value } as StrategySettings };
}

export const FIELD_LABELS: Record<string, string> = {
  timeframe: 'Timeframe',
  segment: 'Segment',
  instrument: 'Instrument',
  'settings.stopLossKind': 'Stop-loss unit',
  'settings.stopLossValue': 'Stop-loss',
  'settings.targetKind': 'Target unit',
  'settings.targetValue': 'Target',
  'settings.riskPerTradeRupees': 'Risk / trade (₹)',
  'settings.capitalPerTradeRupees': 'Capital / trade (₹)',
  'settings.maxOpenPositions': 'Max open positions',
  'settings.maxTradesPerDay': 'Max trades / day',
  'settings.sessionStart': 'Session start',
  'settings.sessionEnd': 'Session end',
  'settings.fillAt': 'Fill at',
};

export function editLabel(e: AiEdit): string {
  return `${FIELD_LABELS[e.field] ?? e.field} → ${e.value === null ? '—' : String(e.value)}`;
}

/** Aggregates only; null when the last backtest was not of this strategy. */
export function backtestAggregates(
  strategyName: string,
  last: { strategy: string } | null,
  results: { totalTrades: number; winRate: number; totalReturnPercent: number; maxDrawdown: number; sharpeRatio: number } | null,
): Record<string, number> | null {
  if (!last || !results || !strategyName.trim() || last.strategy.trim().toLowerCase() !== strategyName.trim().toLowerCase()) return null;
  return {
    totalTrades: results.totalTrades,
    winRate: results.winRate,
    totalReturnPercent: results.totalReturnPercent,
    maxDrawdown: results.maxDrawdown,
    sharpeRatio: results.sharpeRatio,
  };
}

/** Plain-language line for a non-answer outcome. */
export function outcomeMessage(o: AiOutcome<unknown>): string | null {
  return 'message' in o ? o.message : null;
}

/** Click gate for the AI buttons: one in flight, and no re-click within `minGapMs`. */
export function createClickGate(minGapMs: number, now: () => number = Date.now) {
  let inFlight = false;
  let lastAt = -Infinity;
  return {
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      const t = now();
      if (inFlight || t - lastAt < minGapMs) return undefined;
      inFlight = true;
      lastAt = t;
      try {
        return await fn();
      } finally {
        inFlight = false;
      }
    },
    get busy() {
      return inFlight;
    },
  };
}
