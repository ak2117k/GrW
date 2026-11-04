import { Inject, Injectable, Logger } from '@nestjs/common';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { ENGINE_UNIVERSE } from '../../entry-engine/domain/engine-inputs';
import { futureExchangeFor, parseLineFutures } from '../../market-hub/hub-lines';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { checkInputs, sessionVenue, type HealthClock, type InputsSnapshot, type Problem, type WatchedUnderlying } from '../domain/inputs-health';
import { InputsHealthRepository, type OpenUnderlying } from '../repositories/inputs-health.repository';

export const INPUTS_HEALTH_CLOCK = Symbol('INPUTS_HEALTH_CLOCK');

type Env = Record<string, string | undefined>;
type Alert = (key: string, text: string) => Promise<boolean>;
type Repo = Pick<
  InputsHealthRepository,
  'openUnderlyings' | 'nearestFuture' | 'cashLine' | 'optionable' | 'lastBarAt' | 'lastChainAt' | 'lastNewsAt' | 'engineNews' | 'claimAlert' | 'releaseAlert'
>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** IST calendar date, 'YYYY-MM-DD' (the dedupe day). */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istMidnight(at: Date): Date {
  return new Date(Date.parse(`${istDay(at)}T00:00:00.000Z`) - IST_OFFSET_MS);
}

/** INPUTS_HEALTH=off (or false / 0) disables the check; default on. Rollback: set INPUTS_HEALTH=off and restart. */
export function inputsHealthEnabled(env: Env = process.env): boolean {
  const raw = (env.INPUTS_HEALTH ?? 'on').trim().toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

export interface InputsHealthReport {
  skipped?: 'off' | 'closed';
  watched: number;
  problems: Problem[];
  alerted: number;
  failed?: string;
}

interface Candidate {
  name: string;
  exchange: string;
  why: Set<string>;
  cashRefs: Array<{ exchange: string; token: string }>;
}

/**
 * Every 15 min (cron): builds the inputs snapshot for the watched set — the entry engine universe,
 * the hub's pinned line futures (HUB_LINE_FUTURES) and the underlyings of OPEN tracker positions —
 * runs the pure checker, and sends ONE ops-bot Telegram alert per (problem, underlying, IST day).
 * The dedupe lives in inputs_health_alerts, so a restart mid-day does not re-send. DETECTION ONLY:
 * it reads, alerts and writes its own table; it never touches a trade, a feed or a decision.
 */
@Injectable()
export class InputsHealthService {
  private readonly logger = new Logger(InputsHealthService.name);

  constructor(
    private readonly repo: InputsHealthRepository,
    @Inject(INPUTS_HEALTH_CLOCK) private readonly clock: HealthClock,
  ) {}

  async run(now: Date = new Date(), deps: { env?: Env; alert?: Alert; repo?: Repo } = {}): Promise<InputsHealthReport> {
    const env = deps.env ?? process.env;
    const repo: Repo = deps.repo ?? this.repo;
    const alert: Alert = deps.alert ?? ((k, t) => sendOpsAlert(k, t, { env }));
    if (!inputsHealthEnabled(env)) return { skipped: 'off', watched: 0, problems: [], alerted: 0 };
    // Cheap pre-gate: nothing is judged outside a session, so no query runs at night / on holidays.
    if (!['NSE', 'BSE', 'MCX'].some((v) => this.clock.isOpen(v, now))) return { skipped: 'closed', watched: 0, problems: [], alerted: 0 };

    let snapshot: InputsSnapshot;
    try {
      snapshot = await this.snapshot(now, env, repo);
    } catch (e) {
      // A dead check is itself the silent failure this module exists to catch: say so (30-min cooldown).
      this.logger.warn(`[inputs-health] snapshot failed: ${errText(e)}`);
      await alert('inputs-health:failed', `GrW inputs health: the check could not run — ${errText(e).slice(0, 300)}`).catch(() => false);
      return { watched: 0, problems: [], alerted: 0, failed: errText(e) };
    }

    const problems = checkInputs(snapshot, this.clock);
    const day = istDay(now);
    let alerted = 0;
    for (const p of problems) {
      try {
        if (!(await repo.claimAlert(p.kind, p.underlying, day, p.message, now))) continue;
        const sent = await alert(`inputs-health:${p.kind}:${p.underlying}:${day}`, `GrW inputs ${p.kind} — ${p.message}`).catch(() => false);
        if (sent) alerted += 1;
        else await repo.releaseAlert(p.kind, p.underlying, day); // unconfigured / Telegram down: retried next run
      } catch (e) {
        this.logger.warn(`[inputs-health] could not alert ${p.kind} ${p.underlying}: ${errText(e)}`);
      }
    }
    if (alerted > 0) this.logger.warn(`[inputs-health] ${alerted} new alert(s); standing: ${problems.map((p) => `${p.kind}:${p.underlying}`).join(', ')}`);
    return { watched: snapshot.underlyings.length, problems, alerted };
  }

  /**
   * The watched set with each input's newest datum. A failed master lookup (future / cash line) only
   * drops that line; a failed bar / chain / news read throws, and run() alerts that the check is down.
   */
  async snapshot(now: Date, env: Env, repo: Repo): Promise<InputsSnapshot> {
    const today = istMidnight(now);
    const candidates = new Map<string, Candidate>();
    const add = (name: string, exchange: string, why: string, cash?: { exchange: string; token: string } | null) => {
      const n = name.toUpperCase();
      const key = `${n}|${sessionVenue(exchange)}`;
      const c = candidates.get(key) ?? { name: n, exchange: exchange.toUpperCase(), why: new Set<string>(), cashRefs: [] };
      c.why.add(why);
      if (cash) c.cashRefs.push(cash);
      candidates.set(key, c);
    };
    for (const n of ENGINE_UNIVERSE as readonly string[]) add(n, futureExchangeFor(n), 'ENGINE');
    for (const n of parseLineFutures(env.HUB_LINE_FUTURES)) add(n, futureExchangeFor(n), 'LINE');
    const open: OpenUnderlying[] = await repo.openUnderlyings();
    for (const o of open) add(o.name, o.exchange, 'POSITION', o.cashRef);

    const underlyings: WatchedUnderlying[] = [];
    for (const c of candidates.values()) {
      const refs: Array<{ exchange: string; token: string }> = [...c.cashRefs];
      const index = INDEX_UNDERLYINGS[c.name];
      if (index) refs.push({ exchange: index.exchange, token: index.token });
      const derivative = c.exchange === 'NFO' || c.exchange === 'BFO' || c.exchange === 'MCX';
      if (derivative) {
        const fut = await repo.nearestFuture(c.name, c.exchange, today).catch(() => null);
        if (fut) refs.push(fut);
        // A stock derivative's underlying is its NSE cash line (the hub's pick).
        if (!index && c.exchange !== 'MCX') {
          const cash = await repo.cashLine(c.name).catch(() => null);
          if (cash) refs.push(cash);
        }
      }
      const uniq = [...new Map(refs.map((r) => [`${r.exchange}:${r.token}`, r])).values()];
      const [lastBarAt, optionable] = await Promise.all([repo.lastBarAt(uniq, now), derivative ? repo.optionable(c.name, today) : Promise.resolve(false)]);
      const lastChainAt = optionable ? await repo.lastChainAt(c.name, now) : null;
      underlyings.push({
        name: c.name,
        exchange: c.exchange,
        why: [...c.why],
        barRefs: uniq.map((r) => `${r.exchange}:${r.token}`),
        lastBarAt,
        optionable,
        lastChainAt,
      });
    }

    const [lastNewsAt, engineNews] = await Promise.all([repo.lastNewsAt(), repo.engineNews(today)]);
    return { now, underlyings, lastNewsAt, engineNews };
  }
}
