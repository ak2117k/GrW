import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { istYmd, lastSessionDates } from '../../night-report/domain/night-report.logic';
import type { SessionClock } from '../../market-hub/session-clock';
import { decide, directionOf, evidenceGate } from '../domain/proposals';
import { SELF_REVIEW_CLOCK } from '../services/self-review-run.service';
import { isAllowedTarget, isForbiddenTarget, TUNABLES, validateTunable, type TunableValue } from '../tuning/tunables';
import { TuningService } from '../tuning/tuning.service';
import { AUTO_APPLY_CONFIG, DECISION_PNL, type AutoApplyConfig, type DecisionPnlPort } from './auto-apply.ports';
import { AUTO_BY, AUTO_ROLLBACK_BY, AutoApplyRepository, type AutoApplyStore, type ProposalRow } from './auto-apply.repository';
import { AFFECTED_DECISIONS, blockedDirectionOf, changeBlock, rollbackDue, stepLimit, WATCH_SESSIONS, type Change, type WindowPnl } from './policy';

/** Sessions of history the watch and the spacing rules look at. */
export const HISTORY_SESSIONS = 60;
/** A change is watched at most this many sessions; after that it is KEPT whatever the data says. */
export const MAX_WATCH_SESSIONS = 20;

export interface AutoApplyResult {
  applied: Change[];
  rolledBack: Change[];
  blocked: string[];
  error?: string;
}

type Alert = (key: string, text: string) => Promise<unknown>;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const tv = (v: unknown): TunableValue | null => (typeof v === 'number' || typeof v === 'boolean' ? v : null);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmt = (x: number | null) => (x === null ? 'n/a' : `₹${Math.round(x).toLocaleString('en-IN')}`);

/** A tuning_proposals row decided automatically, as a {@link Change}. */
export function toChange(p: ProposalRow): Change {
  const ev = obj(p.evidence);
  const rollback = p.decidedBy === AUTO_ROLLBACK_BY;
  const at = (p.decidedAt ?? p.createdAt).toISOString();
  return {
    id: p.id,
    target: p.target,
    kind: rollback ? 'ROLLBACK' : 'APPLY',
    from: tv(p.currentValue),
    to: tv(p.proposedValue),
    session: istYmd(p.decidedAt ?? p.createdAt),
    at,
    reason: p.rationale,
    ...(rollback
      ? { rollbackOf: typeof ev.rollbackOf === 'string' ? ev.rollbackOf : null, blockedDirection: typeof ev.blockedDirection === 'string' ? ev.blockedDirection : null }
      : {}),
  };
}

/**
 * The wrong-decision loop's SETTING fix (spec 2026-11-04, goal 6 + S1/S2/S4; 2026-11-05). Each evening after
 * the self-review run:
 *  1. WATCH: every automatic change still in force is compared, ₹ per affected decision (stream F's grades),
 *     over the 3 sessions WITH the decision after it vs the 3 such sessions before it. Worse ⇒ the previous
 *     value is restored (a new proposal approved by `auto-rollback`) and that direction is blocked 20 sessions.
 *  2. APPLY: each PENDING proposal (made by the deterministic engine, so it already passed evidenceGate — re-
 *     checked here on its stored evidence) is applied through the existing approveAndApply with by='auto',
 *     its value step-limited to 25 % of the range, at most one change per target per 5 sessions, never while
 *     the target's last change is still watched, and only for a target with graded decisions to watch.
 * Every apply and rollback goes to Telegram (sendOpsAlert) and to the night report via {@link recentChanges}.
 * Never throws. SELF_REVIEW_AUTO_APPLY=off ⇒ nothing at all (PENDING waits for the owner, as before).
 */
@Injectable()
export class AutoApplyService {
  private readonly logger = new Logger(AutoApplyService.name);
  private running = false;

  constructor(
    @Inject(AUTO_APPLY_CONFIG) private readonly cfg: AutoApplyConfig,
    @Inject(AutoApplyRepository) private readonly store: AutoApplyStore,
    private readonly tuning: TuningService,
    @Inject(SELF_REVIEW_CLOCK) private readonly clock: SessionClock,
    @Optional() @Inject(DECISION_PNL) private readonly pnl?: DecisionPnlPort,
    @Optional() @Inject('AUTO_APPLY_ALERT') private readonly alert: Alert = (k, t) => sendOpsAlert(k, t),
  ) {}

  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  async run(now: Date = new Date()): Promise<AutoApplyResult> {
    const out: AutoApplyResult = { applied: [], rolledBack: [], blocked: [] };
    if (!this.cfg.enabled) return { ...out, blocked: ['SELF_REVIEW_AUTO_APPLY=off'] };
    if (this.running) return { ...out, blocked: ['an auto-apply run is already going'] };
    this.running = true;
    try {
      const sessionsAsc = lastSessionDates(now, this.clock, HISTORY_SESSIONS).reverse();
      const history = (await this.store.autoProposals()).map(toChange);
      await this.watch(history, sessionsAsc, now, out);
      await this.apply(history, sessionsAsc, now, out);
      if (out.applied.length || out.rolledBack.length) await this.tuning.refresh();
      for (const b of out.blocked) this.logger.log(`[auto-apply] not applied: ${b}`);
      return out;
    } catch (e) {
      this.logger.warn(`[auto-apply] run failed: ${errText(e)}`);
      return { ...out, error: errText(e) };
    } finally {
      this.running = false;
    }
  }

  /** Automatic changes (applies and rollbacks) made on or after `sinceSessionDate`, oldest first. For G1's night report. */
  async recentChanges(sinceSessionDate: string): Promise<Change[]> {
    try {
      return (await this.store.autoProposals()).map(toChange).filter((c) => c.session >= sinceSessionDate);
    } catch (e) {
      this.logger.warn(`[auto-apply] recent changes read failed: ${errText(e)}`);
      return [];
    }
  }

  // ─── 1. watch / rollback ───────────────────────────────────────────────────

  private async watch(history: Change[], sessionsAsc: readonly string[], now: Date, out: AutoApplyResult): Promise<void> {
    const undone = new Set(history.filter((c) => c.kind === 'ROLLBACK' && c.rollbackOf).map((c) => c.rollbackOf as string));
    const latestApply = new Map<string, Change>();
    for (const c of history) if (c.kind === 'APPLY') latestApply.set(c.target, c);
    for (const c of latestApply.values()) {
      if (undone.has(c.id)) {
        c.watch = 'ROLLED_BACK';
        continue;
      }
      try {
        c.watch = await this.judge(c, sessionsAsc, now, out);
      } catch (e) {
        c.watch = 'WATCHING';
        out.blocked.push(`${c.target}: watch failed (${errText(e)})`);
      }
    }
  }

  private async judge(c: Change, sessionsAsc: readonly string[], now: Date, out: AutoApplyResult): Promise<Change['watch']> {
    const ov = await this.store.override(c.target);
    if (!ov || ov.proposalId !== c.id) return 'SUPERSEDED'; // the owner (or a later change) moved it since
    const types = AFFECTED_DECISIONS[c.target];
    if (!this.pnl || !types) return 'WATCHING';
    const after = await this.window(types, sessionsAsc.filter((d) => d > c.session), 'first');
    if (after.sessions < WATCH_SESSIONS) {
      return sessionsAsc.filter((d) => d > c.session).length >= MAX_WATCH_SESSIONS ? 'KEPT' : 'WATCHING';
    }
    const before = await this.window(types, sessionsAsc.filter((d) => d <= c.session), 'last');
    if (!rollbackDue(before, after)) return 'KEPT';
    const prev = c.from;
    const v = validateTunable(c.target, prev);
    if (prev === null || !v.ok) {
      out.blocked.push(`${c.target}: rollback due but the previous value ${JSON.stringify(prev)} is not valid (${v.ok ? '' : v.reason})`);
      return 'WATCHING';
    }
    const blockedDirection = blockedDirectionOf(c);
    const why =
      `auto rollback of ${c.id}: ${c.target} ${JSON.stringify(c.from)}→${JSON.stringify(c.to)} made ${fmt(after.perDecision)}/decision over ` +
      `${after.sessions} sessions vs ${fmt(before.perDecision)} over ${before.sessions} before`;
    const row = await this.store.createRollback({
      target: c.target,
      currentValue: c.to,
      proposedValue: v.value,
      rationale: why,
      evidence: { n: 0, right: 0, wrong: 0, examples: [], rollbackOf: c.id, blockedDirection, before, after, types },
    });
    if (!(await this.store.approveAndApply(row.id, c.target, v.value as number | boolean, AUTO_ROLLBACK_BY))) {
      out.blocked.push(`${c.target}: rollback proposal ${row.id} could not be applied`);
      return 'WATCHING';
    }
    const rb: Change = {
      id: row.id, target: c.target, kind: 'ROLLBACK', from: c.to, to: v.value, session: istYmd(now),
      at: now.toISOString(), reason: why, rollbackOf: c.id, blockedDirection, watch: null,
    };
    out.rolledBack.push(rb);
    this.logger.warn(`[auto-apply] ROLLED BACK ${why}`);
    await this.say(`self-review-rollback:${row.id}`, `GrW self-review ROLLED BACK ${c.target} ${JSON.stringify(c.to)} → ${JSON.stringify(v.value)} (from the next session). ${why}. Same direction blocked 20 sessions.`);
    return 'ROLLED_BACK';
  }

  /** ₹/decision over the first / last WATCH_SESSIONS sessions of `candidates` that HAD the decision. */
  private async window(types: readonly string[], candidates: readonly string[], pick: 'first' | 'last'): Promise<WindowPnl> {
    if (!this.pnl || candidates.length === 0) return { perDecision: null, sessions: 0 };
    const all = await this.pnl.perDecisionPnl([...types], [...candidates]);
    const had = [...all.sessions].sort();
    if (had.length < WATCH_SESSIONS) return { perDecision: all.perDecision, sessions: had.length };
    const chosen = pick === 'first' ? had.slice(0, WATCH_SESSIONS) : had.slice(-WATCH_SESSIONS);
    const r = await this.pnl.perDecisionPnl([...types], chosen);
    return { perDecision: r.perDecision, sessions: r.sessions.length };
  }

  // ─── 2. apply ──────────────────────────────────────────────────────────────

  private async apply(history: Change[], sessionsAsc: readonly string[], now: Date, out: AutoApplyResult): Promise<void> {
    const pending = await this.store.pending();
    const done = new Set<string>();
    const changesSoFar = (): Change[] => [...history, ...out.rolledBack, ...out.applied];
    for (const p of pending) {
      const tag = `${p.target} → ${JSON.stringify(p.proposedValue)} (${p.id})`;
      try {
        const reason = await this.applyOne(p, changesSoFar(), sessionsAsc, now, done, out);
        if (reason) out.blocked.push(`${tag}: ${reason}`);
      } catch (e) {
        out.blocked.push(`${tag}: ${errText(e)}`);
      }
    }
  }

  /** Apply one PENDING proposal; returns why not, or null when applied. */
  private async applyOne(p: ProposalRow, history: Change[], sessionsAsc: readonly string[], now: Date, done: Set<string>, out: AutoApplyResult): Promise<string | null> {
    if (isForbiddenTarget(p.target) || !isAllowedTarget(p.target)) return 'not an allow-listed target';
    if (done.has(p.target)) return 'already changed this run';
    const d = decide(p, 'approve', now);
    if (!d.ok || d.value === undefined) return d.ok ? 'no value' : d.reason;
    const ev = obj(p.evidence);
    const gate = evidenceGate({ n: Number(ev.n) || 0, right: Number(ev.right) || 0, sessions: Number(ev.sessions) || 0 });
    if (gate) return `evidence gate: ${gate}`;
    const types = AFFECTED_DECISIONS[p.target];
    if (!types) return 'no graded decision type to watch this target with (owner approval only)';
    if (!this.pnl) return 'decision grades are not wired (DECISION_PNL) — nothing could watch the change';
    const ov = await this.store.override(p.target);
    const from = tv(p.currentValue);
    if (from === null) return 'no current value on the proposal';
    if (ov && tv(ov.value) !== from) return `stale: the value in force is ${JSON.stringify(ov.value)}, the proposal assumed ${JSON.stringify(from)}`;
    const t = TUNABLES[p.target];
    let value: TunableValue = d.value;
    if (t.kind === 'number' && typeof from === 'number' && typeof value === 'number') value = stepLimit(t, from, value);
    if (value === from) return 'the step limit leaves nothing to change';
    const v = validateTunable(p.target, value);
    if (!v.ok) return v.reason;
    const direction = directionOf(from, v.value);
    const block = changeBlock(p.target, direction, history, sessionsAsc);
    if (block) return block;
    const before = await this.window(types, sessionsAsc, 'last');
    if (before.sessions < WATCH_SESSIONS) return `only ${before.sessions} recent session(s) with ${types.join('/')} decisions to compare a change against (need ${WATCH_SESSIONS})`;

    const stepped = v.value !== d.value;
    const rationale = stepped ? `${p.rationale} [auto: step-limited from ${JSON.stringify(d.value)}]` : p.rationale;
    if (!(await this.store.restep(p.id, v.value as number | boolean, { ...ev, autoApply: { requested: d.value, applied: v.value, types } }, rationale))) {
      return 'decided concurrently';
    }
    if (!(await this.store.approveAndApply(p.id, p.target, v.value as number | boolean, AUTO_BY))) return 'decided concurrently';
    done.add(p.target);
    const c: Change = {
      id: p.id, target: p.target, kind: 'APPLY', from, to: v.value, session: istYmd(now), at: now.toISOString(), reason: rationale, watch: 'WATCHING',
    };
    out.applied.push(c);
    this.logger.warn(`[auto-apply] APPLIED ${p.target}: ${JSON.stringify(from)} → ${JSON.stringify(v.value)} (proposal ${p.id}; ${rationale})`);
    await this.say(
      `self-review-apply:${p.id}`,
      `GrW self-review CHANGED ${p.target} ${JSON.stringify(from)} → ${JSON.stringify(v.value)} (from the next session). Why: ${rationale}. ` +
        `Evidence ${Number(ev.right) || 0}/${Number(ev.n) || 0} over ${Number(ev.sessions) || 0} sessions. Watched over the next ${WATCH_SESSIONS} sessions with ${types.join('/')} decisions; worse ⇒ rolled back.`,
    );
    return null;
  }

  private async say(key: string, text: string): Promise<void> {
    try {
      await this.alert(key, text);
    } catch (e) {
      this.logger.warn(`[auto-apply] alert failed: ${errText(e)}`);
    }
  }
}
