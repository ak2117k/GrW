import { Injectable, Logger, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WatchStatus } from '@prisma/client';
import { AdaptiveStopTickPoller } from '../../../adaptive-stop-track/services/adaptive-stop-tick-poller.service';
import { AUTO_EXEC_SEGMENTS, AutoExecSettingsService } from '../../../auto-execution/services/auto-exec-settings.service';
import { SellFuturesService } from '../../../sell-futures-track/services/sell-futures.service';
import { TradeRepository } from '../../../trade-engine/repositories/trade.repository';
import { TradeExecutionService } from '../../../trade-engine/services/trade-execution.service';
import { UngatedWatchRepository } from '../../../ungated-track/repositories/ungated-watch.repository';
import { UngatedTickPoller } from '../../../ungated-track/services/ungated-tick-poller.service';
import { WatchService } from '../../../watch-monitor/services/watch.service';
import type { Actor } from '../../strategies/services/core-strategy-catalogue.service';

/**
 * Spec §5.4: turning the core kill switch on "also calls the old silos' square-off
 * paths, so one button stops everything". Approach A: no silo is edited. This adapter
 * only CALLS entry points that already exist (plan decision 9 lists each, and the
 * gaps where none exists). Several are not exported by their modules, so each is
 * resolved with ModuleRef.get(token, { strict: false }); the silo classes are imported
 * as tokens only.
 *
 * The silo tables have no userId and their controllers are @AdminOnly: they are the
 * owner's platform-wide tracks. Only auto-execution is per user. trade-engine's
 * closeAllPositions also flips a process-global in-memory kill switch, so it is
 * owner-only and runs LAST (closing every open Trade first would make the silo
 * square-offs above fail on already-closed paper trades).
 */
export const SILO_TARGETS = [
  'auto-execution',
  'watch-monitor',
  'adaptive-stop-track',
  'ungated-track',
  'sell-futures-track',
  'trade-engine',
] as const;
export type SiloTarget = (typeof SILO_TARGETS)[number];
export type SiloStatus = 'OK' | 'FAILED' | 'SKIPPED' | 'UNAVAILABLE';

export interface SiloSquareOffResult {
  target: SiloTarget;
  status: SiloStatus;
  detail: string;
}

type Resolve = <T>(token: Type<T>) => T;

interface StepOutcome {
  ok: boolean;
  detail: string;
}

interface SiloStep {
  target: SiloTarget;
  ownerOnly: boolean;
  run(resolve: Resolve, actor: Actor, reason: string): Promise<StepOutcome>;
}

class SiloUnavailableError extends Error {}

const STEPS: readonly SiloStep[] = [
  {
    target: 'auto-execution',
    ownerOnly: false,
    async run(resolve, actor) {
      const svc = resolve(AutoExecSettingsService);
      for (const segment of AUTO_EXEC_SEGMENTS) await svc.update(actor.userId, segment, { killSwitch: true });
      return { ok: true, detail: `kill switch set for ${AUTO_EXEC_SEGMENTS.join(' and ')} auto-execution (blocks new auto entries, closes nothing)` };
    },
  },
  {
    target: 'watch-monitor',
    ownerOnly: true,
    async run(resolve) {
      const r = await resolve(WatchService).squareOffAll('manual');
      return { ok: r.errors === 0, detail: `closed ${r.tradedClosed} traded, dismissed ${r.watchingClosed} watching, ${r.errors} errors` };
    },
  },
  {
    target: 'adaptive-stop-track',
    ownerOnly: true,
    async run(resolve) {
      const r = await resolve(AdaptiveStopTickPoller).eodSquareOff();
      return { ok: r.errors === 0 && r.skipped === 0, detail: `closed ${r.closed} of ${r.attempted}, ${r.skipped} skipped (no exit price), ${r.errors} errors` };
    },
  },
  {
    target: 'ungated-track',
    ownerOnly: true,
    async run(resolve) {
      // eodSquareOff returns nothing; count TRADED before and after, as POST /api/ungated/square-off does.
      const repo = resolve(UngatedWatchRepository);
      const traded = async () => (await repo.findAllActive()).filter((e) => e.status === WatchStatus.TRADED).length;
      const before = await traded();
      await resolve(UngatedTickPoller).eodSquareOff();
      const after = await traded();
      return { ok: after === 0, detail: `closed ${before - after} of ${before}; ${after} still open` };
    },
  },
  {
    target: 'sell-futures-track',
    ownerOnly: true,
    async run(resolve) {
      const r = await resolve(SellFuturesService).squareOffOpenPositions();
      return { ok: r.errors === 0, detail: `closed ${r.closed}, ${r.errors} errors` };
    },
  },
  {
    target: 'trade-engine',
    ownerOnly: true,
    async run(resolve, _actor, reason) {
      const r = await resolve(TradeExecutionService).closeAllPositions(`core kill switch: ${reason}`);
      // closeAllPositions logs and swallows each trade's close failure and returns only
      // { closed }; count what is still OPEN/PARTIALLY_FILLED so a partial close is FAILED.
      const remaining = (await resolve(TradeRepository).getOpenTrades()).length;
      return {
        ok: remaining === 0,
        detail: `closed ${r.closed} open trades; ${remaining} still open; the trade-engine kill switch is now on in memory for every user until the API restarts, and auto-trade mode is OFF`,
      };
    },
  },
];

@Injectable()
export class SiloSquareOffAdapter {
  private readonly logger = new Logger(SiloSquareOffAdapter.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /** Never throws: each step reports OK, FAILED, SKIPPED or UNAVAILABLE. */
  async squareOffAll(actor: Actor, reason: string): Promise<SiloSquareOffResult[]> {
    const resolve: Resolve = <T>(token: Type<T>): T => {
      try {
        return this.moduleRef.get<T>(token, { strict: false });
      } catch {
        throw new SiloUnavailableError(`${token.name} is not loaded in this process`);
      }
    };
    const results: SiloSquareOffResult[] = [];
    for (const step of STEPS) {
      if (step.ownerOnly && actor.role !== 'ADMIN') {
        results.push({ target: step.target, status: 'SKIPPED', detail: 'owner only: this silo is platform-wide, not yours alone' });
        continue;
      }
      try {
        const out = await step.run(resolve, actor, reason);
        results.push({ target: step.target, status: out.ok ? 'OK' : 'FAILED', detail: out.detail });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        results.push({ target: step.target, status: err instanceof SiloUnavailableError ? 'UNAVAILABLE' : 'FAILED', detail });
      }
    }
    for (const r of results) {
      if (r.status === 'FAILED' || r.status === 'UNAVAILABLE') this.logger.error(`kill switch cascade ${r.target}: ${r.status}: ${r.detail}`);
    }
    return results;
  }
}
