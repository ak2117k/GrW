import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { setCoreKillSwitchReader, type KillSwitchReadPort } from '../kill-gate';
import { resolveAppendOnly } from '../limits/append-only';

interface SwitchRow {
  id: string;
  userId: string;
  active: boolean;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Cached, read-only view of core kill switches for the silo entry gate (decision 21).
 * Each answer lives at most CACHE_MS; errors are never cached (the gate then refuses).
 */
@Injectable()
export class CoreKillSwitchReader implements KillSwitchReadPort, OnModuleInit, OnModuleDestroy {
  /** Staleness bound for hot paths (owner: ≤ 5 s). Not a risk value. */
  static readonly CACHE_MS = 5_000;

  private readonly cache = new Map<string, { on: boolean; at: number }>();
  /** Bumped by invalidate(): a read that began before it must not refill the cache. */
  private generation = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly cls: ClsService,
  ) {
    // Register at once: TradeCoreModule initialises after the Bull, fan-out and silo
    // modules, and a boot-time auto-execution refusal is terminal. onModuleInit
    // registers again; production still has no default reader before this one exists.
    setCoreKillSwitchReader(this);
  }

  onModuleInit(): void {
    setCoreKillSwitchReader(this);
  }

  onModuleDestroy(): void {
    setCoreKillSwitchReader(null);
  }

  invalidate(): void {
    this.generation++;
    this.cache.clear();
  }

  isOn(userId: string): Promise<boolean> {
    return this.cached(`user:${userId}`, async (now) => {
      // Unscoped: a CLS store carrying another tenant must not hide this user's rows
      // (that would fail open); `where: { userId }` pins the rows to this user.
      const rows = await this.unscoped(() =>
        this.prisma.coreKillSwitch.findMany({
          where: { userId },
          select: { id: true, userId: true, active: true, effectiveFrom: true, createdAt: true },
        }),
      );
      return resolveAppendOnly(rows, now).inForce?.active ?? false;
    });
  }

  isOnForPlatform(): Promise<boolean> {
    return this.cached('platform', async (now) => {
      const rows: SwitchRow[] = await this.unscoped(() =>
        this.prisma.coreKillSwitch.findMany({
          where: { user: { role: 'ADMIN' } },
          select: { id: true, userId: true, active: true, effectiveFrom: true, createdAt: true },
        }),
      );
      const byUser = new Map<string, SwitchRow[]>();
      for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
      return [...byUser.values()].some((list) => resolveAppendOnly(list, now).inForce?.active === true);
    });
  }

  /**
   * Bypass tenant scoping. Silo entries run from crons, pollers and Bull workers with
   * no CLS context, where runWithoutTenant would throw (ClsService.set) and Prisma is
   * already unscoped; so only bypass when a CLS store is active (the
   * AutoExecutionService.readConsent pattern).
   */
  private unscoped<T>(run: () => T): T {
    return this.cls.isActive() ? this.tenant.runWithoutTenant(run) : run();
  }

  private async cached(key: string, load: (now: Date) => Promise<boolean>): Promise<boolean> {
    const nowMs = Date.now();
    const hit = this.cache.get(key);
    if (hit && nowMs - hit.at < CoreKillSwitchReader.CACHE_MS) return hit.on;
    const startedIn = this.generation;
    const on = await load(new Date(nowMs));
    // A switch change landed mid-read: this answer may predate it, so return it once
    // but never cache it (caching it would hide an "on" for up to CACHE_MS).
    if (this.generation === startedIn) this.cache.set(key, { on, at: nowMs });
    return on;
  }
}
