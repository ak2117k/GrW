import { Injectable } from '@nestjs/common';
import type { CoreRiskLimit, CoreRiskLimitDefault, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID } from '../../../../common/tenant/tenant.constants';
import type { LimitSource } from '../risk-wall.types';

export interface NewLimitRow {
  key: string;
  scope: string;
  numValue: Prisma.Decimal | null;
  textValue: string | null;
  effectiveFrom: Date;
  source: LimitSource;
  setBy: string;
  reason: string;
}

/** The UserSettings fields that have a core-limit equivalent (plan decision 7). */
export interface SeedSettings {
  maxDailyLoss: number;
  maxCapitalPerTrade: number;
  maxConcurrentPositions: number;
}

export interface SettingsForSeed {
  settings: SeedSettings | null;
  from: 'OWN' | 'PLATFORM' | null;
}

/** Another change to the same row set landed between the caller's read and this write. */
export class ConcurrentRiskChangeError extends Error {
  constructor(what: string) {
    super(`${what} changed at the same time`);
    this.name = 'ConcurrentRiskChangeError';
  }
}

/** Strictly after the user's newest row, and never before now (plan decision 5). */
export function nextCreatedAt(newest: Date | null, now: Date): Date {
  return new Date(Math.max(now.getTime(), newest ? newest.getTime() + 1 : 0));
}

const SETTINGS_SELECT = { maxDailyLoss: true, maxCapitalPerTrade: true, maxConcurrentPositions: true } as const;
const OLDEST_FIRST = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * Per-user, append-only limit rows (spec §5.2). Every query names the caller's
 * userId; the tenant extension adds the same filter for non-admin requests. There
 * is no update or delete method (a trigger refuses UPDATE as well). Writes take a
 * per-user advisory lock so "newest row" and createdAt order are exact.
 */
@Injectable()
export class CoreRiskLimitRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string): Promise<CoreRiskLimit[]> {
    return this.prisma.coreRiskLimit.findMany({ where: { userId }, orderBy: OLDEST_FIRST });
  }

  listForPair(userId: string, key: string, scope: string): Promise<CoreRiskLimit[]> {
    return this.prisma.coreRiskLimit.findMany({ where: { userId, key, scope }, orderBy: OLDEST_FIRST });
  }

  async pairsForUser(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.coreRiskLimit.findMany({
      where: { userId },
      select: { key: true, scope: true },
      distinct: ['key', 'scope'],
    });
    return new Set(rows.map((r) => `${r.key}@${r.scope}`));
  }

  listDefaults(): Promise<CoreRiskLimitDefault[]> {
    return this.prisma.coreRiskLimitDefault.findMany();
  }

  /**
   * The user's own settings row; for an ADMIN without one, the platform row stamped
   * SYSTEM_USER_ID, which is the row the Settings page edits (settings.service.ts:38-48).
   */
  async settingsForSeed(userId: string): Promise<SettingsForSeed> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, settings: { select: SETTINGS_SELECT } },
    });
    if (user?.settings) return { settings: user.settings, from: 'OWN' };
    if (user?.role === 'ADMIN') {
      const platform = await this.prisma.userSettings.findUnique({ where: { userId: SYSTEM_USER_ID }, select: SETTINGS_SELECT });
      if (platform) return { settings: platform, from: 'PLATFORM' };
    }
    return { settings: null, from: null };
  }

  /** One change. `expectNewestId` must still be the newest row of the pair, else ConcurrentRiskChangeError. */
  append(userId: string, row: NewLimitRow, now: Date, expectNewestId: string | null): Promise<CoreRiskLimit> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_risk_limits:${userId}`}, 0))`;
      const newest = await tx.coreRiskLimit.findFirst({
        where: { userId, key: row.key, scope: row.scope },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if ((newest?.id ?? null) !== expectNewestId) throw new ConcurrentRiskChangeError(`${row.key} (${row.scope})`);
      const last = await tx.coreRiskLimit.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      return tx.coreRiskLimit.create({ data: { ...row, userId, createdAt: nextCreatedAt(last?.createdAt ?? null, now) } });
    });
  }

  /** The seed: inserts only the pairs the user has no row for yet, and returns what it inserted. */
  appendIfMissing(userId: string, rows: NewLimitRow[], now: Date): Promise<CoreRiskLimit[]> {
    if (rows.length === 0) return Promise.resolve([]);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_risk_limits:${userId}`}, 0))`;
      const present = new Set(
        (await tx.coreRiskLimit.findMany({ where: { userId }, select: { key: true, scope: true } })).map((r) => `${r.key}@${r.scope}`),
      );
      const last = await tx.coreRiskLimit.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      let at = nextCreatedAt(last?.createdAt ?? null, now);
      const out: CoreRiskLimit[] = [];
      for (const row of rows) {
        if (present.has(`${row.key}@${row.scope}`)) continue;
        out.push(await tx.coreRiskLimit.create({ data: { ...row, userId, createdAt: at } }));
        at = new Date(at.getTime() + 1);
      }
      return out;
    });
  }
}
