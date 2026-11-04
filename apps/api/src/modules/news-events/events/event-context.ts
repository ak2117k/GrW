import { activeEvents, marketEvents } from '../../../common/utils/market-events';
import type { EventImpact, StoredMarketEvent } from '../types';
import { MACRO_KINDS } from './macro-schedule';

/**
 * EVENT CONTEXT (2026-11-04). One event view per underlying, built from BOTH calendars:
 * the stored `market_events` macro schedule (config/market-events.json → EventsBuilderService) and
 * the operator's `MARKET_EVENT_DAYS` env list (common/utils/market-events).
 *
 * Why: on 4 Nov (US midterm results) GOLD moved ~3.5k points; both calendars knew it was an event day,
 * yet nothing handed that to a decision-maker — the signal judge SKIPped a correct GOLD CE call citing
 * missing chain/VIX/expected-move and "mixed news". An event day predicts move SIZE (not direction),
 * which favours a long option in the channel's direction.
 *
 * Window: an event counts from the start (IST midnight) of its IST session date through the first 2 h
 * of the next weekday session (until 11:15 IST). Holidays are not skipped — erring wide is harmless here.
 *
 * Honesty: if the stored calendar can't be read, or holds nothing at all (never built / schedule ran out),
 * the answer is `absent(<reason>)` — never "no event today".
 */

export interface EventContextEvent {
  name: string;
  /** 'YYYY-MM-DD HH:mm IST' for a timed event; 'YYYY-MM-DD IST session' for a configured event day. */
  at: string;
  impact: 'high' | 'medium' | 'low';
  /** Underlying roots this event moves (GOLD, SILVER, CRUDEOIL, NIFTY, BANKNIFTY, SENSEX). */
  affects: string[];
  /** A bigger-than-usual move is expected (direction unknown). */
  expectMove: boolean;
}

export type EventContext =
  | { status: 'present'; events: EventContextEvent[] }
  | { status: 'absent'; reason: string };

export interface EventContextDeps {
  /** MarketEventsRepository satisfies this. */
  repo: { listFrom(from: Date): Promise<StoredMarketEvent[]> };
  /** Defaults to process.env (MARKET_EVENT_DAYS). */
  env?: Record<string, string | undefined>;
}

const US_WIDE = Object.freeze(['GOLD', 'SILVER', 'CRUDEOIL', 'NIFTY', 'BANKNIFTY', 'SENSEX']);
const INDICES = Object.freeze(['NIFTY', 'BANKNIFTY', 'SENSEX']);
const CRUDE = Object.freeze(['CRUDEOIL']);

/** Stored macro kinds → affected underlyings. Non-macro rows (company results, expiry, EIA) are not event days here. */
const KIND_AFFECTS: Readonly<Record<(typeof MACRO_KINDS)[number], readonly string[]>> = Object.freeze({
  fomc: US_WIDE, us_cpi: US_WIDE, us_nfp: US_WIDE, us_election: US_WIDE,
  rbi_mpc: INDICES, india_cpi: INDICES,
  opec: CRUDE,
});

/** A configured MARKET_EVENT_DAYS name → affected underlyings. Unknown names are treated as global (US-wide). */
export function eventAffects(name: string): string[] {
  const n = name.toUpperCase();
  if (/RBI|INDIA|BUDGET/.test(n)) return [...INDICES];
  if (/OPEC/.test(n)) return [...CRUDE];
  return [...US_WIDE];
}

/** GOLDM / GOLDPETAL → GOLD, SILVERM / SILVERMIC → SILVER, CRUDEOILM → CRUDEOIL; else as given. */
function familyOf(underlying: string): string {
  const u = underlying.trim().toUpperCase();
  for (const root of ['CRUDEOIL', 'GOLD', 'SILVER']) if (u.startsWith(root)) return root;
  return u;
}

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const istYmd = (t: number): string => new Date(t + IST_MS).toISOString().slice(0, 10);
const istHm = (t: number): string => new Date(t + IST_MS).toISOString().slice(11, 16);
/** UTC ms of IST midnight on `ymd`. */
const istMidnight = (ymd: string): number => Date.parse(`${ymd}T00:00:00Z`) - IST_MS;

/** [IST midnight of the event date, next weekday 11:15 IST]. */
function windowOf(ymd: string): { from: number; to: number } {
  const from = istMidnight(ymd);
  let next = from + DAY_MS;
  for (;;) {
    const dow = new Date(next + IST_MS).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    next += DAY_MS;
  }
  return { from, to: next + (11 * 60 + 15) * 60_000 };
}

const inWindow = (ymd: string, at: number): boolean => {
  const w = windowOf(ymd);
  return at >= w.from && at <= w.to;
};

const isMacro = (kind: string): kind is keyof typeof KIND_AFFECTS => (MACRO_KINDS as readonly string[]).includes(kind);

/** Configured event days (MARKET_EVENT_DAYS) covering `at` that affect `fam`. */
function configuredFor(fam: string, at: number, env: Record<string, string | undefined>): EventContextEvent[] {
  return marketEvents(env)
    .filter((e) => inWindow(e.date, at))
    .map((e) => ({ name: e.name, at: `${e.date} IST session`, impact: 'high' as const, affects: eventAffects(e.name), expectMove: true }))
    .filter((e) => e.affects.includes(fam));
}

export async function eventContextFor(underlying: string, at: Date, deps: EventContextDeps): Promise<EventContext> {
  const env = deps.env ?? process.env;
  const fam = familyOf(underlying);
  const t = at.getTime();
  const configured = configuredFor(fam, t, env);
  const note = 'scheduled events may exist that this process cannot see; this is NOT a finding that nothing is scheduled';
  const configuredNote = (): string => {
    const today = activeEvents(at, env).map((e) => e.name);
    const names = configured.map((e) => e.name);
    const all = [...new Set([...names, ...today])];
    return all.length > 0 ? `; configured event day(s): ${all.join(', ')} (MARKET_EVENT_DAYS)` : '';
  };

  let rows: StoredMarketEvent[];
  try {
    // 5 days back: a Friday event still reaches a Monday (or post-holiday Tuesday) morning.
    rows = await deps.repo.listFrom(new Date(t - 5 * DAY_MS));
  } catch (err) {
    return { status: 'absent', reason: `the events calendar could not be read (${err instanceof Error ? err.message : String(err)}) — ${note}${configuredNote()}` };
  }
  if (rows.length === 0) {
    return { status: 'absent', reason: `the events calendar is empty (not built yet, or its schedule has run out) — ${note}${configuredNote()}` };
  }

  const stored: EventContextEvent[] = rows
    .filter((r) => isMacro(r.kind) && KIND_AFFECTS[r.kind].includes(fam))
    .filter((r) => inWindow(istYmd(r.startsAt.getTime()), t))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((r) => ({
      name: r.title,
      at: `${istYmd(r.startsAt.getTime())} ${istHm(r.startsAt.getTime())} IST`,
      impact: r.impact as EventImpact,
      affects: [...KIND_AFFECTS[r.kind as keyof typeof KIND_AFFECTS]],
      expectMove: r.impact === 'high',
    }));
  return { status: 'present', events: [...stored, ...configured] };
}
