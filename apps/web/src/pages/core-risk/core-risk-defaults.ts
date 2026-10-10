import type { CoreLimitKind } from '@/services/coreRisk';
import type { CoreRiskDefaultView } from '@/services/coreRiskDefaults';
import { formatIst, formatLimitValue, kindChangePayload, limitLabel, scopeLabel, type Parsed } from './core-risk';

export interface DefaultRow {
  id: string;
  key: string;
  scope: string;
  kind: CoreLimitKind;
  label: string;
  scopeLabel: string;
  valueText: string;
  note: string;
  updatedText: string;
}

export function defaultRows(views: readonly CoreRiskDefaultView[]): DefaultRow[] {
  return views.map((v) => ({
    id: `${v.key}@${v.scope}`,
    key: v.key,
    scope: v.scope,
    kind: v.kind,
    label: limitLabel(v.key),
    scopeLabel: scopeLabel(v.scope),
    valueText: formatLimitValue(v.kind, v.value),
    note: v.note ?? 'no default: new users start without this limit',
    updatedText: v.updatedBy && v.updatedAt ? `edited ${formatIst(v.updatedAt)} by ${v.updatedBy}` : 'seeded by the M2 migration',
  }));
}

/** The `{ value, reason }` body for a seed default; the reason becomes the default's note. */
export function defaultChangePayload(kind: CoreLimitKind, text: string, reason: string): Parsed<{ value: number | string; reason: string }> {
  return kindChangePayload(kind, text, reason);
}

export function defaultSavedMessage(v: CoreRiskDefaultView): string {
  return `Default for ${limitLabel(v.key)} (${scopeLabel(v.scope)}) is now ${formatLimitValue(v.kind, v.value)}. It applies to limits seeded from now on; nobody’s current limits change.`;
}
