import { lastSessionDates } from '../../night-report/domain/night-report.logic';
import { makeSentinelClock } from '../../trade-sentinel/overnight/overnight-calendar';
import type { DecisionPnlPort } from './auto-apply.ports';
import { AUTO_BY, AUTO_ROLLBACK_BY, type AutoApplyStore, type ProposalRow } from './auto-apply.repository';
import { AutoApplyService } from './auto-apply.service';

const clock = makeSentinelClock();
const NOW = new Date('2026-11-05T14:00:00Z'); // 19:30 IST
const SESSIONS = lastSessionDates(NOW, clock, 60).reverse(); // oldest first; last = 2026-11-05
const at = (session: string) => new Date(`${session}T14:00:00Z`); // 19:30 IST that day

const GOOD_EVIDENCE = { n: 30, right: 6, wrong: 24, sessions: 12, examples: [] };

function proposal(p: Partial<ProposalRow>): ProposalRow {
  return {
    id: 'p1', key: 'exit.floorTrailN', target: 'exit.floorTrailN', currentValue: 2.0, proposedValue: 3.0, rationale: 'live exits hit 20%',
    evidence: GOOD_EVIDENCE, status: 'PENDING', createdAt: new Date(NOW.getTime() - 3_600_000), decidedAt: null, decidedBy: null, ...p,
  };
}

class FakeStore implements AutoApplyStore {
  rows: ProposalRow[] = [];
  overrides = new Map<string, { value: unknown; proposalId: string | null }>();
  calls: string[] = [];
  private n = 0;
  async pending() { return this.rows.filter((r) => r.status === 'PENDING'); }
  async autoProposals() {
    return this.rows.filter((r) => r.status === 'APPLIED' && (r.decidedBy === AUTO_BY || r.decidedBy === AUTO_ROLLBACK_BY))
      .sort((a, b) => (a.decidedAt as Date).getTime() - (b.decidedAt as Date).getTime());
  }
  async override(target: string) { return this.overrides.get(target) ?? null; }
  async restep(id: string, value: number | boolean, evidence: unknown, rationale: string) {
    const r = this.rows.find((x) => x.id === id && x.status === 'PENDING');
    if (!r) return false;
    Object.assign(r, { proposedValue: value, evidence, rationale });
    return true;
  }
  async createRollback(d: { target: string; currentValue: unknown; proposedValue: unknown; rationale: string; evidence: unknown }) {
    const id = `rb${++this.n}`;
    this.rows.push(proposal({ id, key: d.target, ...d }));
    return { id };
  }
  async approveAndApply(id: string, target: string, value: number | boolean, by: string) {
    const r = this.rows.find((x) => x.id === id && x.status === 'PENDING');
    if (!r) return false;
    Object.assign(r, { status: 'APPLIED', decidedBy: by, decidedAt: NOW });
    this.overrides.set(target, { value, proposalId: id });
    this.calls.push(`${by}:${target}=${value}`);
    return true;
  }
}

/** ₹ per session: {decisions, total}; a session absent here had no such decision. */
function fakePnl(bySession: Record<string, { decisions: number; total: number }>): DecisionPnlPort & { perDecisionPnl: jest.Mock } {
  return {
    perDecisionPnl: jest.fn(async (_types: string[], dates: string[]) => {
      const had = dates.filter((d) => (bySession[d]?.decisions ?? 0) > 0);
      const decisions = had.reduce((s, d) => s + bySession[d].decisions, 0);
      const total = had.reduce((s, d) => s + bySession[d].total, 0);
      return { sessions: had, decisions, perDecision: decisions ? total / decisions : null };
    }),
  };
}

const every = (sessions: readonly string[], v: { decisions: number; total: number }) => Object.fromEntries(sessions.map((s) => [s, v]));

function make(opts: { enabled?: boolean; pnl?: DecisionPnlPort | null; store?: FakeStore } = {}) {
  const store = opts.store ?? new FakeStore();
  const tuning = { refresh: jest.fn(async () => undefined) };
  const alert = jest.fn(async () => true);
  const svc = new AutoApplyService({ enabled: opts.enabled ?? true }, store, tuning as never, clock, opts.pnl === null ? undefined : opts.pnl ?? fakePnl(every(SESSIONS, { decisions: 2, total: 1000 })), alert);
  return { svc, store, tuning, alert };
}

describe('AutoApplyService', () => {
  it('flag off ⇒ nothing applied', async () => {
    const store = new FakeStore();
    store.rows.push(proposal({}));
    const { svc, alert } = make({ enabled: false, store });
    const out = await svc.run(NOW);
    expect(out.applied).toEqual([]);
    expect(out.rolledBack).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(store.rows[0].status).toBe('PENDING');
    expect(alert).not.toHaveBeenCalled();
  });

  it('applies a gated PENDING proposal via approveAndApply by auto, step-limited, announced', async () => {
    const store = new FakeStore();
    store.rows.push(proposal({}));
    const { svc, alert, tuning } = make({ store });
    const out = await svc.run(NOW);
    expect(out.applied.map((c) => [c.target, c.from, c.to])).toEqual([['exit.floorTrailN', 2, 2.625]]);
    expect(store.calls).toEqual(['auto:exit.floorTrailN=2.625']);
    expect(store.rows[0].proposedValue).toBe(2.625);
    expect(store.rows[0].rationale).toMatch(/step-limited from 3/);
    expect(alert).toHaveBeenCalledWith('self-review-apply:p1', expect.stringContaining('exit.floorTrailN 2 → 2.625'));
    expect(tuning.refresh).toHaveBeenCalled();
    expect((await svc.recentChanges('2026-11-05')).map((c) => c.kind)).toEqual(['APPLY']);
  });

  it('evidence that fails evidenceGate, a target with nothing to watch, or no decision grades ⇒ not applied', async () => {
    const store = new FakeStore();
    store.rows.push(proposal({ id: 'weak', evidence: { n: 8, right: 3, wrong: 5, sessions: 4 } }));
    store.rows.push(proposal({ id: 'w', key: 'scorecard.factor.oi.weight', target: 'scorecard.factor.oi.weight', currentValue: 1, proposedValue: 0.5 }));
    const { svc } = make({ store });
    const out = await svc.run(NOW);
    expect(out.applied).toEqual([]);
    expect(out.blocked.join('\n')).toMatch(/evidence gate/);
    expect(out.blocked.join('\n')).toMatch(/no graded decision type/);

    const store2 = new FakeStore();
    store2.rows.push(proposal({}));
    const out2 = await make({ store: store2, pnl: null }).svc.run(NOW);
    expect(out2.applied).toEqual([]);
    expect(out2.blocked.join('\n')).toMatch(/DECISION_PNL/);
  });

  it('a stale proposal (the value in force moved since) is not applied', async () => {
    const store = new FakeStore();
    store.rows.push(proposal({}));
    store.overrides.set('exit.floorTrailN', { value: 2.5, proposalId: 'owner' });
    const out = await make({ store }).svc.run(NOW);
    expect(out.applied).toEqual([]);
    expect(out.blocked.join('\n')).toMatch(/stale/);
  });

  it('second change within 5 sessions blocked', async () => {
    const store = new FakeStore();
    const s0 = SESSIONS[SESSIONS.length - 3];
    store.rows.push(proposal({ id: 'old', status: 'APPLIED', decidedBy: AUTO_BY, decidedAt: at(s0), currentValue: 2.0, proposedValue: 2.5 }));
    store.overrides.set('exit.floorTrailN', { value: 2.5, proposalId: 'old' });
    store.rows.push(proposal({ id: 'new', currentValue: 2.5, proposedValue: 3.0 }));
    const out = await make({ store }).svc.run(NOW);
    expect(out.applied).toEqual([]);
    expect(out.blocked.join('\n')).toMatch(/last changed 2 session/);
  });

  it("sessions without the decision don't count", async () => {
    const store = new FakeStore();
    const i0 = SESSIONS.length - 8;
    const s0 = SESSIONS[i0];
    store.rows.push(proposal({ id: 'old', status: 'APPLIED', decidedBy: AUTO_BY, decidedAt: at(s0), currentValue: 2.0, proposedValue: 2.5 }));
    store.overrides.set('exit.floorTrailN', { value: 2.5, proposalId: 'old' });
    // Before: every session +₹500/decision. After: 7 sessions, only 2 of them had the decision (both awful).
    const before = every(SESSIONS.slice(0, i0 + 1), { decisions: 2, total: 1000 });
    const after = { [SESSIONS[i0 + 2]]: { decisions: 1, total: -5000 }, [SESSIONS[i0 + 6]]: { decisions: 1, total: -5000 } };
    const out = await make({ store, pnl: fakePnl({ ...before, ...after }) }).svc.run(NOW);
    expect(out.rolledBack).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(store.overrides.get('exit.floorTrailN')?.value).toBe(2.5);
  });

  it('worse after 3 sessions ⇒ rollback + 20-session direction block', async () => {
    const store = new FakeStore();
    const i0 = SESSIONS.length - 6;
    const s0 = SESSIONS[i0];
    store.rows.push(proposal({ id: 'old', status: 'APPLIED', decidedBy: AUTO_BY, decidedAt: at(s0), currentValue: 2.0, proposedValue: 2.5 }));
    store.overrides.set('exit.floorTrailN', { value: 2.5, proposalId: 'old' });
    // Tonight the engine proposes the same direction again.
    store.rows.push(proposal({ id: 'again', currentValue: 2.0, proposedValue: 3.0 }));
    const pnl = fakePnl({
      ...every(SESSIONS.slice(0, i0 + 1), { decisions: 2, total: 1000 }), // +₹500/decision before
      ...every(SESSIONS.slice(i0 + 1), { decisions: 2, total: -400 }), // −₹200/decision after
    });
    const { svc, alert } = make({ store, pnl });
    const out = await svc.run(NOW);
    expect(out.rolledBack.map((c) => [c.target, c.from, c.to, c.rollbackOf, c.blockedDirection])).toEqual([['exit.floorTrailN', 2.5, 2, 'old', 'up']]);
    expect(store.calls).toEqual(['auto-rollback:exit.floorTrailN=2']);
    expect(store.overrides.get('exit.floorTrailN')?.value).toBe(2);
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/^self-review-rollback:/), expect.stringContaining('ROLLED BACK exit.floorTrailN'));
    // The same-direction proposal is not applied (just rolled back: spacing + the direction block).
    expect(out.applied).toEqual([]);
    expect(store.rows.find((r) => r.id === 'again')?.status).toBe('PENDING');

    // 6 sessions later the spacing rule is satisfied but "up" is still blocked (20 sessions).
    const later = new FakeStore();
    const r0 = SESSIONS[SESSIONS.length - 7];
    later.rows.push(proposal({ id: 'old', status: 'APPLIED', decidedBy: AUTO_BY, decidedAt: at(SESSIONS[SESSIONS.length - 12]), currentValue: 2.0, proposedValue: 2.5 }));
    later.rows.push(proposal({ id: 'rb', status: 'APPLIED', decidedBy: AUTO_ROLLBACK_BY, decidedAt: at(r0), currentValue: 2.5, proposedValue: 2.0, evidence: { rollbackOf: 'old', blockedDirection: 'up' } }));
    later.overrides.set('exit.floorTrailN', { value: 2.0, proposalId: 'rb' });
    later.rows.push(proposal({ id: 'up', currentValue: 2.0, proposedValue: 3.0 }));
    later.rows.push(proposal({ id: 'down', key: 'exit.floorArmN', target: 'exit.floorArmN', currentValue: 1.5, proposedValue: 1.2 }));
    const out2 = await make({ store: later }).svc.run(NOW);
    expect(out2.blocked.join('\n')).toMatch(/moving up was rolled back 6 session/);
    expect(out2.applied.map((c) => c.target)).toEqual(['exit.floorArmN']);
  });

  it('a change the owner has since overridden is never rolled back', async () => {
    const store = new FakeStore();
    const i0 = SESSIONS.length - 6;
    store.rows.push(proposal({ id: 'old', status: 'APPLIED', decidedBy: AUTO_BY, decidedAt: at(SESSIONS[i0]), currentValue: 2.0, proposedValue: 2.5 }));
    store.overrides.set('exit.floorTrailN', { value: 3.0, proposalId: 'owner-approved' });
    const pnl = fakePnl({ ...every(SESSIONS.slice(0, i0 + 1), { decisions: 2, total: 1000 }), ...every(SESSIONS.slice(i0 + 1), { decisions: 2, total: -400 }) });
    const out = await make({ store, pnl }).svc.run(NOW);
    expect(out.rolledBack).toEqual([]);
    expect(store.overrides.get('exit.floorTrailN')?.value).toBe(3.0);
  });
});
