import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Segment } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ConsentService } from '../../consent/consent.service';

/** The two auto-executable segments (TDA-007 gating surface). */
export const AUTO_EXEC_SEGMENTS: readonly Segment[] = ['INTRADAY', 'SWING'];

/** One per-segment auto-execution control row as the USER sees it (TDA-017). */
export interface AutoExecState {
  segment: Segment;
  enabled: boolean;
  killSwitch: boolean;
  riskPerTrade: number | null;
  maxCapital: number | null;
  enabledAt: Date | null;
}

/** The mutable knobs a `PATCH` may carry (all optional). */
export interface AutoExecPatch {
  enabled?: boolean;
  killSwitch?: boolean;
  riskPerTrade?: number;
  maxCapital?: number;
}

/**
 * TDA-017 — reads/writes a USER's per-segment auto-execution controls, backed by
 * the `AutoTradeConsent` row (userId, segment) that `AutoExecutionService` reads
 * authoritatively at execution time.
 *
 * `AutoTradeConsent` IS a tenant model (TDA-003): under an authenticated request
 * the tenant-scoped {@link PrismaService} auto-filters every op to the caller's
 * `userId` and stamps it on create — so this service does NOT use
 * `runWithoutTenant`. It still passes `userId` explicitly into the compound
 * unique so the query is unambiguous (the scoper adds the same userId).
 *
 * SAFETY (spec): turning auto-execution ON requires the caller to have accepted
 * the CURRENT risk disclosure ({@link ConsentService.hasAcceptedCurrent}). The
 * kill switch is a safety control and is settable regardless of consent — never
 * blocked. This service places NO orders and touches NO broker credentials.
 */
@Injectable()
export class AutoExecSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
  ) {}

  /**
   * The caller's control state for BOTH segments. Segments with no stored row
   * yet return a default, disabled state (never a missing entry) so the UI can
   * render every segment without a separate "does a row exist?" probe.
   */
  async getForUser(userId: string): Promise<AutoExecState[]> {
    const rows = await this.prisma.autoTradeConsent.findMany({
      where: { userId },
      select: {
        segment: true,
        enabled: true,
        killSwitch: true,
        riskPerTrade: true,
        maxCapital: true,
        enabledAt: true,
      },
    });
    const bySeg = new Map(rows.map((r) => [r.segment, r]));
    return AUTO_EXEC_SEGMENTS.map((segment) => {
      const r = bySeg.get(segment);
      return {
        segment,
        enabled: r?.enabled ?? false,
        killSwitch: r?.killSwitch ?? false,
        riskPerTrade: r?.riskPerTrade ?? null,
        maxCapital: r?.maxCapital ?? null,
        enabledAt: r?.enabledAt ?? null,
      };
    });
  }

  /**
   * Upsert the `(userId, segment)` control row from a partial patch.
   *
   * SAFETY GATE: a patch that sets `enabled: true` is rejected with 409 UNLESS
   * the caller has accepted the current disclosure. Setting `enabled: false` (or
   * omitting it) needs no consent; the kill switch is never gated. `enabledAt`
   * is stamped whenever the row is being turned ON.
   */
  async update(userId: string, segment: Segment, patch: AutoExecPatch): Promise<AutoExecState> {
    if (!AUTO_EXEC_SEGMENTS.includes(segment)) {
      throw new BadRequestException(`Unknown segment '${segment}' — expected INTRADAY or SWING`);
    }

    const enabling = patch.enabled === true;
    if (enabling && !(await this.consent.hasAcceptedCurrent(userId))) {
      throw new ConflictException(
        'Accept the current risk disclosure before enabling auto-execution',
      );
    }

    // Build the update branch from ONLY the keys the patch carries, so a PATCH
    // never clobbers a knob it didn't mention. Stamp enabledAt only on turn-on.
    const update: Record<string, unknown> = {};
    if (patch.enabled !== undefined) update.enabled = patch.enabled;
    if (patch.killSwitch !== undefined) update.killSwitch = patch.killSwitch;
    if (patch.riskPerTrade !== undefined) update.riskPerTrade = patch.riskPerTrade;
    if (patch.maxCapital !== undefined) update.maxCapital = patch.maxCapital;
    if (enabling) update.enabledAt = new Date();

    const row = await this.prisma.autoTradeConsent.upsert({
      where: { userId_segment: { userId, segment } },
      create: {
        userId,
        segment,
        enabled: patch.enabled ?? false,
        killSwitch: patch.killSwitch ?? false,
        riskPerTrade: patch.riskPerTrade ?? null,
        maxCapital: patch.maxCapital ?? null,
        enabledAt: enabling ? new Date() : null,
      },
      update,
      select: {
        segment: true,
        enabled: true,
        killSwitch: true,
        riskPerTrade: true,
        maxCapital: true,
        enabledAt: true,
      },
    });

    return {
      segment: row.segment,
      enabled: row.enabled,
      killSwitch: row.killSwitch,
      riskPerTrade: row.riskPerTrade,
      maxCapital: row.maxCapital,
      enabledAt: row.enabledAt,
    };
  }
}
