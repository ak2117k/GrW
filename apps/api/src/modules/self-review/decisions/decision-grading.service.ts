import { Injectable, Logger, Optional } from '@nestjs/common';
import { eventContextFor, type EventContext } from '../../news-events/events/event-context';
import { MarketEventsRepository } from '../../news-events/events/market-events.repository';
import { DecisionGradeRepository } from './decision-grade.repository';
import { DecisionSourcesRepository } from './decision-sources.repository';
import { detectEventNoAction, detectInputMissing, detectLiveNotPlaced, detectThesisContradictions, familyOf, type EventDaySrc } from './detectors';
import { carryDrafts, entryDrafts, entryKindOf, exitDrafts, holdDrafts, istMidnight, istYmd, paperExitDrafts, reentryDrafts, sampleHolds, sessionEndTs, type BarLookup } from './ledger';
import type { Bar, DecisionGradeDraft, GradeSessionResult } from './types';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * SELF_REVIEW_DECISION_LOOP=on|off (default on; the same reading as the run's own flag). Off ⇒
 * gradeSession writes nothing and says so. Rollback: SELF_REVIEW_DECISION_LOOP=off and restart the API.
 */
export function decisionLoopEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.SELF_REVIEW_DECISION_LOOP ?? '').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0');
}

/** The weekday before `ymd` (holidays are not skipped: an empty day just grades nothing). */
export function previousWeekday(ymd: string): string {
  let t = Date.parse(`${ymd}T00:00:00.000Z`) - DAY;
  for (;;) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) return new Date(t).toISOString().slice(0, 10);
    t -= DAY;
  }
}

/** The underlyings an event day can affect (event-context's families) — always checked by EVENT_NO_ACTION. */
const EVENT_ROSTER = ['GOLD', 'SILVER', 'CRUDEOIL', 'NIFTY', 'BANKNIFTY', 'SENSEX'];

/**
 * Counts by DECISION (refTable, refId, decisionType), not by horizon row: `graded` = non-detector decisions
 * written; `wrong` = decisions (or detector hits) WRONG at any horizon; `unscorable` = decisions with no
 * scorable horizon; `byType` = decisions per type.
 */
export function countDrafts(drafts: readonly DecisionGradeDraft[]): Omit<GradeSessionResult, 'error' | 'skipped'> {
  const by = new Map<string, { type: string; wrong: boolean; scored: boolean }>();
  for (const d of drafts) {
    const k = `${d.refTable}|${d.refId}|${d.decisionType}`;
    const cur = by.get(k) ?? { type: d.decisionType, wrong: false, scored: false };
    if (d.verdict === 'WRONG') cur.wrong = true;
    if (d.verdict !== 'UNSCORABLE') cur.scored = true;
    by.set(k, cur);
  }
  const byType: Record<string, number> = {};
  let graded = 0;
  let wrong = 0;
  let unscorable = 0;
  for (const v of by.values()) {
    byType[v.type] = (byType[v.type] ?? 0) + 1;
    if (v.type !== 'DETECTOR') graded += 1;
    if (v.wrong) wrong += 1;
    if (!v.scored) unscorable += 1;
  }
  return { graded, wrong, unscorable, byType };
}

/**
 * The nightly decision ledger (plan 2026-11-04 stream F): reads every decision of session S AND of the
 * weekday before it (MCX decides until 23:30, after the 18:45 run, and carries are scored the next
 * morning — so each night also settles what the previous night could not), grades each horizon that is
 * over by `now`, runs the system detectors, and upserts `decision_grades`. Called by the self-review run
 * (G1). Fail-soft: a source that cannot be read is skipped and named in `error`; the call never throws.
 */
@Injectable()
export class DecisionGradingService {
  private readonly logger = new Logger('DecisionGrading');

  constructor(
    private readonly sources: DecisionSourcesRepository,
    private readonly grades: DecisionGradeRepository,
    @Optional() private readonly events?: MarketEventsRepository,
  ) {}

  async gradeSession(sessionDate: string, now: Date = new Date()): Promise<GradeSessionResult> {
    const zero: GradeSessionResult = { graded: 0, wrong: 0, unscorable: 0, byType: {} };
    if (!decisionLoopEnabled()) return { ...zero, skipped: 'SELF_REVIEW_DECISION_LOOP=off' };
    try {
      const errors: string[] = [];
      const drafts = await this.draftsFor(sessionDate, now.getTime(), errors);
      let written = drafts;
      try {
        await this.grades.upsertMany(drafts);
      } catch (err) {
        errors.push(`write: ${errText(err)}`);
        written = [];
      }
      const counts = countDrafts(written);
      const error = errors.length ? errors.join('; ').slice(0, 1000) : undefined;
      this.logger.log(`[decision-grades] ${sessionDate}: graded ${counts.graded}, wrong ${counts.wrong}, unscorable ${counts.unscorable}${error ? ` — ${error}` : ''}`);
      return { ...counts, ...(error ? { error } : {}) };
    } catch (err) {
      this.logger.error(`[decision-grades] ${sessionDate}: failed: ${errText(err)}`);
      return { ...zero, error: errText(err).slice(0, 1000) };
    }
  }

  /** Every draft for the window [previous weekday, S]. Exposed for tests; errors collects skipped sources. */
  async draftsFor(sessionDate: string, now: number, errors: string[]): Promise<DecisionGradeDraft[]> {
    const prev = previousWeekday(sessionDate);
    const from = new Date(istMidnight(prev));
    const to = new Date(istMidnight(sessionDate) + DAY);
    const sessions = [prev, sessionDate];
    const safe = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        errors.push(`${name}: ${errText(err)}`);
        return fallback;
      }
    };

    const signal = await safe('signal_decisions', () => this.sources.signalDecisions(from, to), []);
    const execs = await safe('ai_exit_executions', () => this.sources.exitExecutions(from, to), []);
    const holdsAll = await safe('sentinel_verdicts', () => this.sources.holdVerdicts(from, to), []);
    const holds = sampleHolds(holdsAll);
    const trackers = await safe('trade_trackers', () => this.sources.trackers([...new Set(holds.map((h) => h.trackerId))]), []);
    const trackerOf = new Map(trackers.map((t) => [t.id, t]));
    const paper = await safe('trades', () => this.sources.paperExits(from, to), []);
    const carries = await safe('intraday_carry_decisions', () => this.sources.carries(new Date(from.getTime() - 3 * DAY), to), []);
    const theses = await safe('sentinel_theses', () => this.sources.theses(from, to), []);
    const packets = await safe('input packets', () => this.sources.inputPackets(from, to, signal), []);
    const enters = await safe('entry_engine_decisions', () => this.sources.engineEnters(from, to), []);
    const reentries = await safe('reentry_watch_decisions', () => this.sources.reentrySignals(from, to), []);

    // One candles_1m read per contract, spanning every window it is needed for.
    const want = new Map<string, { exchange: string; token: string; from: number; to: number }>();
    const need = (exchange: string | null | undefined, token: string | null | undefined, a: number, b: number) => {
      if (!exchange || !token) return;
      const k = `${exchange}:${token}`;
      const cur = want.get(k);
      want.set(k, cur ? { ...cur, from: Math.min(cur.from, a), to: Math.max(cur.to, b) } : { exchange, token, from: a, to: b });
    };
    for (const s of signal) {
      const p = (s.plan ?? {}) as Record<string, unknown>;
      const ex = typeof p.exchange === 'string' ? p.exchange : null;
      const t = s.decidedAt.getTime();
      need(ex, typeof p.token === 'string' ? p.token : null, t - 5 * MIN, sessionEndTs(istYmd(t), ex) + MIN);
    }
    for (const e of execs) {
      if (e.outcome?.status === 'DONE') continue;
      const t = (e.outcome?.decisionAt ?? e.decisionAt ?? e.createdAt).getTime();
      need(e.exchange, e.token, t - 5 * MIN, t + 70 * MIN);
    }
    for (const h of holds) {
      const tr = trackerOf.get(h.trackerId);
      const t = h.createdAt.getTime();
      if (tr) need(tr.exchange, tr.token, t - 10 * MIN, t + 40 * MIN);
    }
    for (const p of paper) need(p.exchange, p.token, p.exitTime.getTime() - 5 * MIN, p.exitTime.getTime() + 70 * MIN);
    for (const r of reentries) {
      const p = (r.plan ?? {}) as Record<string, unknown>;
      const ex = typeof p.exchange === 'string' ? p.exchange : null;
      const t = r.at.getTime();
      need(ex, typeof p.token === 'string' ? p.token : null, t - 5 * MIN, sessionEndTs(istYmd(t), ex) + MIN);
    }
    const barCache = new Map<string, Bar[]>();
    for (const [k, w] of want) {
      barCache.set(k, await safe(`candles_1m ${k}`, () => this.sources.bars(w.exchange, w.token, new Date(w.from), new Date(w.to)), []));
    }
    const bars: BarLookup = (exchange, token) => {
      const b = exchange && token ? barCache.get(`${exchange}:${token}`) : undefined;
      return b && b.length ? b : null;
    };

    const drafts: DecisionGradeDraft[] = [];
    const takePnl = new Map<string, number | null>();
    for (const s of signal) {
      const ds = entryDrafts(s, bars, now);
      drafts.push(...ds);
      const entry = ds.find((d) => d.decisionType !== 'SIZE');
      if (entry) takePnl.set(s.id, entry.decisionType === 'ENTRY_TAKE' ? entry.pnlChosen : entry.pnlAlternative);
    }
    for (const e of execs) drafts.push(...exitDrafts(e, bars, now));
    for (const h of holds) drafts.push(...holdDrafts(h, trackerOf.get(h.trackerId), bars, now));
    for (const p of paper) drafts.push(...paperExitDrafts(p, bars, now));
    for (const c of carries) drafts.push(...carryDrafts(c));
    for (const r of reentries) drafts.push(...reentryDrafts(r, bars, now));

    // ─── detectors, per session ───
    drafts.push(...detectThesisContradictions(theses));
    for (const day of sessions) {
      const onDay = <T>(xs: readonly T[], at: (x: T) => Date) => xs.filter((x) => istYmd(at(x).getTime()) === day);
      const sig = onDay(signal, (s) => s.decidedAt);
      drafts.push(...detectLiveNotPlaced(day, sig.map((s) => ({ ...s, takePnl: takePnl.get(s.id) ?? null }))));
      drafts.push(...detectInputMissing(day, onDay(packets, (p) => p.at)));
      drafts.push(...detectEventNoAction(day, await this.eventDays(day, sig, onDay(enters, (e) => e.at), errors)));
    }
    return drafts;
  }

  private async eventDays(
    day: string,
    signal: ReadonlyArray<{ underlying: string | null; decidedAt: Date; decision: string | null; gate: unknown; judge: unknown }>,
    enters: ReadonlyArray<{ underlying: string; at: Date }>,
    errors: string[],
  ): Promise<EventDaySrc[]> {
    if (!this.events) return [];
    const repo = this.events;
    const dayStart = istMidnight(day);
    const midday = new Date(dayStart + 12 * 60 * MIN);
    const families = new Set([...EVENT_ROSTER, ...signal.map((s) => familyOf(s.underlying)).filter((u) => u !== '')]);
    const out: EventDaySrc[] = [];
    for (const u of families) {
      let context: EventContext;
      try {
        context = await eventContextFor(u, midday, { repo });
      } catch (err) {
        errors.push(`events ${u}: ${errText(err)}`);
        continue;
      }
      const calls = signal.filter((s) => familyOf(s.underlying) === u);
      const takes = calls.filter((s) => entryKindOf(s).type === 'ENTRY_TAKE').length + enters.filter((e) => familyOf(e.underlying) === u).length;
      const expect = context.status === 'present' && context.events.some((e) => e.expectMove);
      // The ATR read only matters for an event day with no take and no channel call.
      let moveAtr: number | null = null;
      if (expect && takes === 0 && calls.length === 0) {
        try {
          moveAtr = await this.sources.moveOverAtr(u, new Date(dayStart), new Date(dayStart + DAY));
        } catch {
          moveAtr = null;
        }
      }
      out.push({ underlying: u, context, takes, channelCalls: calls.length, moveAtr, at: calls[0]?.decidedAt ?? new Date(dayStart + (9 * 60 + 15) * MIN) });
    }
    return out;
  }
}
