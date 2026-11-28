import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { AI_HEALTH } from '../../ai-gateway/audit/failover-transport';
import { parseAuthorityMode } from '../exit-authority.config';
import { EXIT_EXECUTION_READER, SUPREME_CONFIRM, TRACKER_WAKE } from '../exit-authority.tokens';
import { lateBindingOf } from '../late-ports';
import { AUTHORITY_ENV } from './authority-state.service';
import { HARD_LOSS_PROBE, OWNER_EXIT } from './escalation-runner.service';

/**
 * Boot check of the late-bound ports (late-ports.ts): each forwarder must find its real binding in THIS process.
 * Requested TRADE_AGENT_AUTHORITY=live with a port unbound ⇒ ERROR per port (never silent: an unbound OWNER_EXIT
 * means no backstop can sell, an unbound TRACKER_WAKE means alarms wait for the next pass). Off ⇒ one LOG line.
 */
@Injectable()
export class ExitAuthorityWiringCheck implements OnApplicationBootstrap {
  private readonly log = new Logger(ExitAuthorityWiringCheck.name);

  constructor(
    @Inject(TRACKER_WAKE) private readonly wake: unknown,
    @Inject(SUPREME_CONFIRM) private readonly supreme: unknown,
    @Inject(HARD_LOSS_PROBE) private readonly probe: unknown,
    @Inject(OWNER_EXIT) private readonly ownerExit: unknown,
    @Inject(AI_HEALTH) private readonly aiHealth: unknown,
    @Inject(EXIT_EXECUTION_READER) private readonly executions: unknown,
    @Optional() @Inject(AUTHORITY_ENV) private readonly env?: Record<string, string | undefined>,
  ) {}

  /** Port name → bound? (a real instance, not a forwarder, is always bound). */
  check(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [name, port] of [
      ['TRACKER_WAKE', this.wake],
      ['SUPREME_CONFIRM', this.supreme],
      ['HARD_LOSS_PROBE', this.probe],
      ['OWNER_EXIT', this.ownerExit],
      ['AI_HEALTH', this.aiHealth],
      ['EXIT_EXECUTION_READER', this.executions],
    ] as const) {
      const b = lateBindingOf(port);
      out[name] = b ? b.resolve() != null : port != null;
    }
    return out;
  }

  onApplicationBootstrap(): void {
    const bound = this.check();
    const missing = Object.entries(bound).filter(([, ok]) => !ok).map(([n]) => n);
    const live = parseAuthorityMode(this.env ?? process.env) === 'live';
    if (missing.length === 0) {
      this.log.log(`[exit-authority] ports bound: ${Object.keys(bound).join(', ')}`);
      return;
    }
    for (const name of missing) {
      const line = `[exit-authority] ${name} is not bound in this process`;
      if (live) this.log.error(`${line}: TRADE_AGENT_AUTHORITY=live will fail closed on it (owner told, nothing silent)`);
      else this.log.log(`${line} (authority off: unused)`);
    }
  }
}
