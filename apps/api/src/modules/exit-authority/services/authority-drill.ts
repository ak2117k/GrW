import type { AlarmRow, AlarmRule, RaiseAlarm } from '../exit-authority.tokens';
import { DRILL_RULES, DRILL_TTL_MS, drillAlarm, drillPath, drillSold, type DrillObservation, type DrillStep } from '../domain/drill';

/**
 * The authority drill's orchestration (apps/api/scripts/authority-drill.ts is the thin process wrapper). Every read
 * and write is a port, so this is unit-tested without a database. It RAISES one drill alarm and then only READS:
 * it never calls the executor, the router, the owner exit or the broker. The path is driven by the running API
 * (the sentinel's next pass sees the open alarm and forces the look; the escalation runner answers / closes it).
 */

export interface DrillTracker {
  id: string;
  userId: string;
  symbol: string;
  status: string;
}

export interface DrillDeps {
  env: Record<string, string | undefined>;
  tracker(id: string): Promise<DrillTracker | null>;
  /** TradeAlarmsService.raise (dedupe + the drill guards). null = not raised. */
  raise(a: RaiseAlarm, now: Date): Promise<AlarmRow | null>;
  alarm(id: string): Promise<AlarmRow | null>;
  /** The trade agent's verdicts on the tracker after `since`, oldest first (advisory ones included). */
  verdictsSince(trackerId: string, since: Date): Promise<DrillObservation['verdicts']>;
  /** The exit execution rows of these verdicts (the script reads them). */
  executions(verdictIds: string[]): Promise<DrillObservation['executions']>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  print(line: string): void;
}

export interface DrillOptions {
  trackerId: string;
  rule: AlarmRule;
  /** How long to follow the path (default: the drill alarm's own TTL + 1 min). */
  waitMs?: number;
  pollMs?: number;
}

/** Exit codes: 0 the path completed and nothing was sold; 1 SAFETY FAILURE (a drill verdict was executed); 2 refused; 3 timed out. */
export type DrillExit = 0 | 1 | 2 | 3;

const holdList = (env: Record<string, string | undefined>): string[] =>
  String(env.AI_AUTO_EXIT_HOLD ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

export function parseDrillArgs(argv: string[]): DrillOptions | { error: string } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const trackerId = get('--tracker');
  if (!trackerId || trackerId.startsWith('--')) return { error: 'usage: npm run authority:drill -- --tracker <id> [--rule FLOOR] [--wait-sec 660]' };
  const rule = (get('--rule') ?? 'FLOOR').toUpperCase() as AlarmRule;
  if (!DRILL_RULES.includes(rule)) return { error: `--rule must be one of ${DRILL_RULES.join(', ')}` };
  const waitSec = Number(get('--wait-sec') ?? NaN);
  return { trackerId, rule, ...(Number.isFinite(waitSec) && waitSec > 0 ? { waitMs: waitSec * 1000 } : {}) };
}

export async function runAuthorityDrill(deps: DrillDeps, opts: DrillOptions): Promise<DrillExit> {
  const p = deps.print;
  if (String(deps.env.TRADE_AGENT_AUTHORITY ?? '').trim().toLowerCase() !== 'live') {
    p(`REFUSED: TRADE_AGENT_AUTHORITY is not live here (${deps.env.TRADE_AGENT_AUTHORITY ?? 'unset'}); alarms are inert. Run inside grw-api.`);
    return 2;
  }
  if (opts.trackerId.startsWith('paper:')) {
    p('REFUSED: a paper tracker never raises an alarm.');
    return 2;
  }
  const t = await deps.tracker(opts.trackerId);
  if (!t) {
    p(`REFUSED: no tracker ${opts.trackerId}.`);
    return 2;
  }
  if (t.status !== 'OPEN') {
    p(`REFUSED: tracker ${t.id} (${t.symbol}) is ${t.status}, not OPEN.`);
    return 2;
  }
  const hold = holdList(deps.env);
  if (hold.includes(t.symbol.toUpperCase()) || hold.includes(t.id.toUpperCase())) {
    p(`REFUSED: ${t.symbol} is on AI_AUTO_EXIT_HOLD — the agent is never forced to look at a held position, the drill would only time out.`);
    return 2;
  }

  const raisedAt = deps.now();
  const row = await deps.raise(drillAlarm({ userId: t.userId, trackerId: t.id, symbol: t.symbol }, opts.rule, raisedAt), raisedAt);
  if (!row) {
    p(`NOT RAISED: a ${opts.rule} alarm is already live on ${t.symbol} (a real one is never touched by a drill; or a drill is already running).`);
    return 2;
  }
  p(`DRILL ${opts.rule} on ${t.symbol} (tracker ${t.id}): alarm ${row.id} raised ${raisedAt.toISOString()}. Observe only — nothing is sold.`);
  p('Waiting for the sentinel\'s next pass (forced look), the verdict and the escalation runner...');

  const waitMs = opts.waitMs ?? DRILL_TTL_MS + 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  const shown = new Set<string>();
  const show = (steps: DrillStep[]) => {
    for (const s of steps) {
      const key = `${s.step}|${s.detail}`;
      if (shown.has(key)) continue;
      shown.add(key);
      p(`  ${s.at ? s.at.toISOString() : '                        '}  ${s.step.padEnd(9)} ${s.detail}`);
    }
  };

  const deadline = raisedAt.getTime() + waitMs;
  for (;;) {
    const alarm = await deps.alarm(row.id);
    if (!alarm) {
      p(`alarm ${row.id} disappeared.`);
      return 3;
    }
    const verdicts = await deps.verdictsSince(t.id, alarm.raisedAt);
    const executions = verdicts.length > 0 ? await deps.executions(verdicts.map((v) => v.id)) : [];
    const obs: DrillObservation = { alarm, verdicts, executions };
    show(drillPath(obs));
    if (drillSold(obs)) {
      p('SAFETY FAILURE: a drill verdict reached the executor as a sale. Check the position and the exit execution rows NOW.');
      return 1;
    }
    if (alarm.status === 'CLOSED' || alarm.status === 'BACKSTOPPED') {
      if (alarm.status === 'BACKSTOPPED') {
        p('SAFETY FAILURE: the drill alarm was BACKSTOPPED. Check the position NOW.');
        return 1;
      }
      p(`PASS: path complete — ${drillPath(obs).map((s) => s.step).join(' → ')}. Nothing was sold.`);
      return 0;
    }
    if (deps.now().getTime() >= deadline) {
      p(`TIMED OUT after ${Math.round(waitMs / 1000)} s with the alarm ${alarm.status}. Nothing was sold.`);
      return 3;
    }
    await deps.sleep(pollMs);
  }
}
