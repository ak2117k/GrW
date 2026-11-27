import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { parseAuthorityMode } from '../../exit-authority/exit-authority.config';
import { AUTHORITY_STATE, OWNER_ESCALATION, SUPREME_CONFIRM, TRADE_ALARMS, TRADE_BRIEFS } from '../../exit-authority/exit-authority.tokens';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { parseFloorBrokerSlConfig } from '../domain/floor-broker-sl';

/** Optional env override (tests); production reads process.env. */
export const EXECUTOR_AUTHORITY_ENV = Symbol('EXECUTOR_AUTHORITY_ENV');

/**
 * Executor-side boot check for the trade agent exit authority (addendum, Task 7). With TRADE_AGENT_AUTHORITY=live
 * requested, logs ERROR when:
 * - a port the router / poller / trigger-watch / executor need is unbound in this injector — above all
 *   OWNER_ESCALATION, without which an OPEN_ORDER_EXISTS block under live ends with no owner alert;
 * - FLOOR_BROKER_SL=live is set: our own resting broker SL would block confirmed AI exits (live never cancels
 *   protective orders) and is a code seller outside the authority, so it is forced to shadow (parseFloorBrokerSlConfig).
 * Off ⇒ nothing is logged here.
 */
@Injectable()
export class ExecutorAuthorityBootCheck implements OnApplicationBootstrap {
  private readonly log = new Logger(ExecutorAuthorityBootCheck.name);

  constructor(
    @Optional() @Inject(AUTHORITY_STATE) private readonly state?: unknown,
    @Optional() @Inject(TRADE_ALARMS) private readonly alarms?: unknown,
    @Optional() @Inject(SUPREME_CONFIRM) private readonly supreme?: unknown,
    @Optional() @Inject(TRADE_BRIEFS) private readonly briefs?: unknown,
    @Optional() @Inject(OWNER_ESCALATION) private readonly escalation?: unknown,
    @Optional() @Inject(EXECUTOR_AUTHORITY_ENV) private readonly env?: Record<string, string | undefined>,
  ) {}

  /** The ERROR lines this process would log (empty when authority is off or all is well). */
  problems(): string[] {
    const env = this.env ?? process.env;
    if (parseAuthorityMode(env) !== 'live') return [];
    const out: string[] = [];
    for (const [name, port] of [
      ['AUTHORITY_STATE', this.state],
      ['TRADE_ALARMS', this.alarms],
      ['SUPREME_CONFIRM', this.supreme],
      ['TRADE_BRIEFS', this.briefs],
      ['OWNER_ESCALATION', this.escalation],
    ] as const) {
      if (port == null) out.push(`[exit-authority] ${name} is unbound in the exit executor while TRADE_AGENT_AUTHORITY=live${name === 'OWNER_ESCALATION' ? ': a blocked exit (OPEN_ORDER_EXISTS) would reach no owner alert' : ''}`);
    }
    if (String(env.FLOOR_BROKER_SL ?? '').trim() === 'live') {
      const cfg = parseFloorBrokerSlConfig(env, parseAutoExitConfig(env));
      out.push(`[exit-authority] FLOOR_BROKER_SL=live is not allowed while TRADE_AGENT_AUTHORITY=live — running ${cfg.mode} (set FLOOR_BROKER_SL=shadow|off)`);
    }
    return out;
  }

  onApplicationBootstrap(): void {
    for (const p of this.problems()) this.log.error(p);
  }
}
