import { Inject, Injectable, Logger } from '@nestjs/common';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from '../desk-manager.config';
import { evaluateGuard } from '../domain/desk-guard';
import { dayPnlPath } from '../domain/pnl-path';
import type { GuardState } from '../domain/desk.types';
import { DeskDayRepository } from '../repositories/desk-day.repository';

/** The guard as the signal executor sees it (injected optionally; absent = today's behaviour). */
export const DESK_GUARD = Symbol('DESK_GUARD');
export type GuardSource = 'signal' | 'reentry' | 'manager';
export interface DeskGuardPort {
  check(userId: string, source: GuardSource, underlying: string | null, now: Date): Promise<GuardState>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_PAUSE_MIN = 390;

/**
 * The desk guard (plan Task 1, spec §5.5): code only, the AI cannot override it. Blocks every automatic LIVE
 * entry (signal, reentry, manager) when the owner's day P&L path breaches a limit or a pause is in force.
 * Never consulted for the owner's own orders or for paper. `check` FAILS CLOSED: if the day cannot be read,
 * the entry is blocked with DESK_GUARD_UNAVAILABLE. A pause never loosens an existing one; only resume / reset
 * lift it.
 */
@Injectable()
export class DeskGuardService implements DeskGuardPort {
  private readonly logger = new Logger(DeskGuardService.name);

  constructor(
    private readonly repo: DeskDayRepository,
    @Inject(DESK_MANAGER_CONFIG) private readonly cfg: DeskManagerConfig,
  ) {}

  async state(userId: string, now: Date, underlying: string | null = null): Promise<GuardState> {
    const [closed, open, day] = await Promise.all([
      this.repo.closedToday(userId, now),
      this.repo.openPnl(userId, now),
      this.repo.guardDay(userId, now),
    ]);
    return evaluateGuard(dayPnlPath(closed, open), this.cfg.guard, { until: day.pausedUntil, scope: day.pauseScope }, underlying, now);
  }

  async check(userId: string, source: GuardSource, underlying: string | null, now: Date): Promise<GuardState> {
    let g: GuardState;
    try {
      g = await this.state(userId, now, underlying);
    } catch (err) {
      const why = `DESK_GUARD_UNAVAILABLE: ${errText(err)}`;
      this.logger.error(`[desk-guard] ${source} entry on ${underlying ?? '?'} blocked — ${why}`);
      g = { blocked: true, reasons: [why], path: dayPnlPath([], 0), pausedUntil: null, pauseScope: null };
    }
    if (g.blocked) {
      try {
        await this.repo.recordEvent({ userId, at: now, source, blocked: true, reasons: g.reasons, path: g.path });
      } catch (err) {
        this.logger.warn(`[desk-guard] could not record the block event: ${errText(err)}`);
      }
    }
    return g;
  }

  /**
   * Pause automatic entries for `scope` ('all' or an underlying) for `minutes` (1–390). Never loosens: an
   * in-force pause keeps the later end, and two different scopes widen to 'all'.
   */
  async pause(userId: string, scope: string, minutes: number, now: Date): Promise<GuardState> {
    const mins = Math.min(MAX_PAUSE_MIN, Math.max(1, Math.round(Number(minutes) || 0)));
    const wanted = String(scope ?? '').trim();
    const norm = wanted === '' || wanted.toLowerCase() === 'all' ? 'all' : wanted.toUpperCase();
    let until = new Date(now.getTime() + mins * 60_000);
    let finalScope = norm;
    const cur = await this.repo.guardDay(userId, now);
    if (cur.pausedUntil && cur.pausedUntil.getTime() > now.getTime() && cur.pauseScope) {
      const curScope = cur.pauseScope.toLowerCase() === 'all' ? 'all' : cur.pauseScope.toUpperCase();
      if (cur.pausedUntil.getTime() > until.getTime()) until = cur.pausedUntil;
      if (curScope !== finalScope) finalScope = 'all';
    }
    await this.repo.savePause(userId, now, until, finalScope);
    return this.state(userId, now);
  }

  /** Lift today's pause (limits still apply). */
  async resume(userId: string, now: Date): Promise<GuardState> {
    await this.repo.savePause(userId, now, null, null);
    return this.state(userId, now);
  }

  /** The owner's reset: trades closed before now stop counting today; any pause is cleared. */
  async reset(userId: string, now: Date): Promise<GuardState> {
    await this.repo.saveReset(userId, now);
    return this.state(userId, now);
  }
}
