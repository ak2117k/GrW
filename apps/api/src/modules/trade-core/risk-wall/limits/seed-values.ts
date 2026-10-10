import { Prisma, type CoreRiskLimitDefault } from '@prisma/client';
import type { SeedSettings, SettingsForSeed } from '../repositories/core-risk-limit.repository';
import { fromStorage, LIMIT_KEYS, parseLimitValue, type LimitKey, type LimitPair, type LimitScope } from './limit-keys';

/**
 * UserSettings fields with the same meaning as a core limit (plan decision 7; each
 * is enforced today by trade-engine/services/risk-manager.service.ts).
 */
export const SETTINGS_EQUIVALENTS: ReadonlyArray<{ key: LimitKey; scope: LimitScope; field: keyof SeedSettings }> = [
  { key: 'maxDailyLoss', scope: 'ALL', field: 'maxDailyLoss' },
  { key: 'maxOpenPositions', scope: 'ALL', field: 'maxConcurrentPositions' },
  { key: 'optionsMaxPremiumPerTrade', scope: 'OPTIONS_BUY', field: 'maxCapitalPerTrade' },
];

export interface SeedValue {
  key: LimitKey;
  scope: LimitScope;
  value: string;
  source: 'USER_SETTINGS' | 'DEFAULT';
  reason: string;
}

/** A Float settings value as the limit's canonical string, or null when it does not fit. */
function fromSetting(key: LimitKey, raw: unknown): string | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = LIMIT_KEYS[key].kind === 'rupees' ? Number(new Prisma.Decimal(raw).toFixed(2)) : raw;
  const p = parseLimitValue(key, n);
  return p.ok ? p.value : null;
}

/** The seed for one pair: the settings equivalent when usable, else the default row, else null (left unset). */
export function seedValueFor(pair: LimitPair, seed: SettingsForSeed, defaults: readonly CoreRiskLimitDefault[]): SeedValue | null {
  const eq = SETTINGS_EQUIVALENTS.find((e) => e.key === pair.key && e.scope === pair.scope);
  if (eq && seed.settings) {
    const value = fromSetting(pair.key, seed.settings[eq.field]);
    if (value !== null) {
      const reason = seed.from === 'PLATFORM'
        ? `copied from the platform settings row (user_settings.${eq.field})`
        : `copied from your settings (user_settings.${eq.field})`;
      return { key: pair.key, scope: pair.scope, value, source: 'USER_SETTINGS', reason };
    }
  }
  const d = defaults.find((x) => x.key === pair.key && x.scope === pair.scope);
  const value = d ? fromStorage(pair.key, d.numValue, d.textValue) : null;
  if (!d || value === null) return null;
  return { key: pair.key, scope: pair.scope, value, source: 'DEFAULT', reason: `default — please review (${d.note})` };
}
