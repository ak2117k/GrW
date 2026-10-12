import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { CoreKillSwitch } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { SessionClock } from '../../../market-hub/session-clock';
import type { Actor } from '../../strategies/services/core-strategy-catalogue.service';
import { invalidateCoreKillSwitchCache } from '../kill-gate';
import { resolveAppendOnly } from '../limits/append-only';
import { CORE_SESSION_CLOCK, CORE_SQUARE_OFF, type CoreSquareOffPort } from '../ports';
import { CoreKillSwitchRepository } from '../repositories/core-kill-switch.repository';
import { ConcurrentRiskChangeError } from '../repositories/core-risk-limit.repository';
import { ALL_CORE_EXCHANGES, nextSessionOpen } from '../session-open';
import { SILO_TARGETS, SiloSquareOffAdapter, type SiloSquareOffResult } from './silo-square-off.adapter';

export interface KillSwitchView {
  active: boolean;
  since: string | null;
  reason: string | null;
  setBy: string | null;
  /** A release waiting for the next session open (D5). */
  pendingRelease: { effectiveFrom: string; reason: string; setAt: string } | null;
}

export interface CascadeStep {
  status: 'OK' | 'FAILED';
  detail: string;
}

export interface KillSwitchCascade {
  core: CascadeStep;
  silos: SiloSquareOffResult[];
}

export interface KillSwitchSetResult {
  state: KillSwitchView;
  effectiveFrom: string;
  cascade: KillSwitchCascade | null;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function viewOf(rows: readonly CoreKillSwitch[], now: Date): KillSwitchView {
  const { inForce, pending } = resolveAppendOnly(rows, now);
  return {
    active: inForce?.active ?? false,
    since: inForce ? inForce.effectiveFrom.toISOString() : null,
    reason: inForce?.reason ?? null,
    setBy: inForce?.setBy ?? null,
    pendingRelease:
      pending && !pending.active
        ? { effectiveFrom: pending.effectiveFrom.toISOString(), reason: pending.reason, setAt: pending.createdAt.toISOString() }
        : null,
  };
}

/**
 * The persistent per-user kill switch (spec §5.4). On: immediate, never refused, then
 * the cascade (core square-off port + every silo entry point). Off: a loosening, so it
 * takes effect at the next session open. GET never writes. Audited both ways.
 */
@Injectable()
export class CoreKillSwitchService {
  private readonly logger = new Logger(CoreKillSwitchService.name);

  constructor(
    private readonly repo: CoreKillSwitchRepository,
    private readonly audit: AuditService,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: SessionClock,
    @Inject(CORE_SQUARE_OFF) private readonly coreSquareOff: CoreSquareOffPort,
    private readonly silos: SiloSquareOffAdapter,
  ) {}

  async get(userId: string, now: Date = new Date()): Promise<KillSwitchView> {
    return viewOf(await this.repo.listForUser(userId), now);
  }

  async isActive(userId: string, now: Date = new Date()): Promise<boolean> {
    return (await this.get(userId, now)).active;
  }

  async set(actor: Actor, input: { active: boolean; reason: string }, now: Date = new Date()): Promise<KillSwitchSetResult> {
    const reason = input.reason.trim();
    const rows = await this.repo.listForUser(actor.userId);
    const { inForce, newest } = resolveAppendOnly(rows, now);
    const wasActive = inForce?.active ?? false;

    let effectiveFrom = now;
    if (!input.active && wasActive) {
      const open = nextSessionOpen(this.clock, ALL_CORE_EXCHANGES, now);
      if (!open) throw new ConflictException('no session open is known in the next 14 days, so the release cannot be scheduled; the kill switch stays on');
      effectiveFrom = open;
    }

    let row: CoreKillSwitch;
    try {
      row = await this.repo.append(
        actor.userId,
        { active: input.active, effectiveFrom, setBy: actor.userId, reason },
        now,
        input.active ? undefined : (newest?.id ?? null),
      );
    } catch (err) {
      if (err instanceof ConcurrentRiskChangeError) throw new ConflictException('the kill switch changed at the same time; reload and retry');
      throw err;
    }

    // The silo entry gate caches for ≤ 5 s; a change must be seen at once (decision 21).
    invalidateCoreKillSwitchCache();

    // Persist → cascade → audit: a failing audit can never stop the square-off (plan decision 17).
    const cascade = input.active ? await this.cascade(actor, reason) : null;
    const target = `core_kill_switch:${row.id}`;
    // Both audits are attempted independently (a SET failure never drops the CASCADE entry);
    // a failure is logged, never thrown, so an engaged (persisted) switch is never reported
    // as a failed request. CASCADE starts once SET has settled, keeping the chain order.
    const audits = [
      {
        action: AUDIT_ACTIONS.risk.CORE_KILL_SWITCH_SET,
        userId: actor.userId,
        target,
        meta: { active: input.active, wasActive, effectiveFrom: effectiveFrom.toISOString(), reason },
      },
      ...(cascade
        ? [{ action: AUDIT_ACTIONS.risk.CORE_KILL_SWITCH_CASCADE, userId: actor.userId, target, meta: { core: cascade.core, silos: cascade.silos } }]
        : []),
    ];
    let previous: Promise<unknown> = Promise.resolve();
    const settled = await Promise.allSettled(
      audits.map((entry) => {
        const next = previous.catch(() => undefined).then(() => this.audit.append(entry));
        previous = next;
        return next;
      }),
    );
    settled.forEach((s, i) => {
      if (s.status === 'rejected') {
        this.logger.error(`${audits[i].action} audit append failed for ${target} (the kill switch change itself is persisted): ${errorText(s.reason)}`);
      }
    });
    return { state: viewOf([...rows, row], now), effectiveFrom: effectiveFrom.toISOString(), cascade };
  }

  private async cascade(actor: Actor, reason: string): Promise<KillSwitchCascade> {
    let core: CascadeStep;
    try {
      const r = await this.coreSquareOff.squareOffAll(actor.userId, 'KILL_SWITCH', reason);
      core = { status: 'OK', detail: `${r.detail} (cancelled ${r.cancelledOrders} orders, requested ${r.exitsRequested} exits)` };
    } catch (err) {
      core = { status: 'FAILED', detail: errorText(err) };
    }
    let silos: SiloSquareOffResult[];
    try {
      silos = await this.silos.squareOffAll(actor, reason);
    } catch (err) {
      silos = SILO_TARGETS.map((target) => ({ target, status: 'FAILED' as const, detail: errorText(err) }));
    }
    return { core, silos };
  }
}
