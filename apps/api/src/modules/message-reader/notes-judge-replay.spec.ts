/**
 * scripts/notes-judge-replay.ts (Task 10, the gate before MESSAGE_READER=on). The spec lives here because jest's
 * rootDir is src/ (scripts/ is not a jest root). Fake transport only — no network, no database.
 *
 * Final review #6: BOTH arms are re-judged fresh (same model / effort), N runs each with a majority verdict
 * (tie → SKIP); the stored live verdict is a reported column only; GO needs ≥ 20 graded decisions, which may
 * come from several sessions.
 */
import { signalJudgeSystem } from '../signal-trader/domain/judge';
import type { TransportMessage, TransportRequest } from '../ai-gateway/transport.types';
import {
  MIN_GRADED,
  goVerdict,
  majority,
  parseReplayArgs,
  renderNotesReplay,
  replayNotes,
  type NotesReplayFixture,
  type NotesReplayRow,
} from '../../../scripts/notes-judge-replay';

const SESSION = '2026-11-24';
const SESSION2 = '2026-11-25';
const ist = (hhmm: string, day = SESSION) => new Date(`${day}T${hhmm}:00+05:30`);
const AT = ist('10:10');

const claim = (subject: string, text: string, verdict: 'CONFIRMED' | 'CONTRADICTED' = 'CONFIRMED') => ({ text, subject, bias: 'BULL' as const, horizon: 'INTRADAY' as const, claimType: 'DIRECTION' as const, verdict, evidence: [] });

const readings: NotesReplayFixture['readings'] = [
  { messageId: 'm1', channelId: 'c1', channelTitle: 'Alpha', postedAt: ist('10:00').toISOString(), availableAt: ist('10:00').toISOString(), scope: 'MARKET', claims: [claim('MARKET', 'market strong before')], summary: null },
  { messageId: 'm2', channelId: 'c1', channelTitle: 'Alpha', postedAt: ist('10:20').toISOString(), availableAt: ist('10:20').toISOString(), scope: 'INSTRUMENT', claims: [claim('RELIANCE', 'reliance posted after')], summary: null },
  { messageId: 'm3', channelId: 'c2', channelTitle: 'Beta', postedAt: '2026-11-23T05:00:00.000Z', availableAt: '2026-11-23T05:00:00.000Z', scope: 'MARKET', claims: [claim('MARKET', 'yesterday')], summary: null },
  // Posted before the decision but only read (stored) after it: the live judge could not have seen it.
  { messageId: 'm4', channelId: 'c2', channelTitle: 'Beta', postedAt: ist('10:09').toISOString(), availableAt: ist('10:11').toISOString(), scope: 'INSTRUMENT', claims: [claim('RELIANCE', 'read after the decision')], summary: null },
];

/** An EQ paper trade BUY 100 that runs to T1 110 → +₹100 on one 10-share lot (dense 1-min contract bars). */
function row(
  id: string,
  stored: { verdict: 'TAKE' | 'SKIP'; confidence: number } | null,
  opts: { trade?: boolean; promptVersion?: string; at?: Date } = {},
): NotesReplayRow {
  const at = opts.at ?? AT;
  const entryTs = at.getTime() + 30_000;
  const bars: Array<[number, number, number, number, number]> = [];
  for (let i = 1; i <= 5; i++) {
    const ts = Math.floor(entryTs / 60_000) * 60_000 + i * 60_000;
    bars.push([ts, 100 + i, 100 + i * 2.5, 99 + i, 100 + i * 2]);
  }
  const exitTs = bars[bars.length - 1][0] + 60_000;
  const packet = { promptVersion: opts.promptVersion ?? 'signal-judge-v8-take', at: at.toISOString(), cluster: { agreeCount: 1, conflict: false }, channelViews: { status: 'ok', underlying: null }, caps: { maxLossPerTrade: 2000 } };
  return {
    decisionId: id,
    underlying: 'RELIANCE',
    createdAt: at.toISOString(),
    judge: stored ? { ...stored, reasons: ['stored'], model: 'claude-opus-5', packet } : { unavailable: 'judge_unavailable', packet },
    plan: { lots: 1, qty: 10, lotSize: 10, sl: 95, targets: [110], tickSize: 0.05, riskRupees: 50 },
    aiCheck: null,
    trade: opts.trade === false ? null : { id: `t-${id}`, side: 'BUY', quantity: 10, entryPrice: 100, exitPrice: 104, entryTime: new Date(entryTs).toISOString(), exitTime: new Date(exitTs).toISOString(), status: 'CLOSED', exitTag: null },
    instrument: { symbol: 'RELIANCE-EQ', name: 'RELIANCE', exchange: 'NSE', strike: null, optionType: null, expiry: null, lotSize: 10, tickSize: 0.05 },
    underlyingRef: { exchange: 'NSE', token: '2885' },
    contractBars: bars,
    underlyingBars: [],
    shadowStop: null,
    chain: null,
    looks: [],
  };
}

const reply = (verdict: 'TAKE' | 'SKIP', confidence = 80): TransportMessage => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ verdict, confidence, reasons: ['notes'], entry: null, sl: null, targets: [], lots: null }) }],
});

const hasNotes = (req: TransportRequest) => /verifiedNotes/.test(req.system[0].text);

/** Per-arm scripted verdicts (cycled per call); 'fail' throws. */
function fake(arms: { with: Array<'TAKE' | 'SKIP' | 'fail'>; without: Array<'TAKE' | 'SKIP' | 'fail'> }) {
  const requests: TransportRequest[] = [];
  const n = { with: 0, without: 0 };
  const call = async (req: TransportRequest) => {
    requests.push(req);
    const arm = hasNotes(req) ? 'with' : 'without';
    const list = arms[arm];
    const v = list[n[arm]++ % list.length];
    if (v === 'fail') throw new Error('vertex 503');
    return reply(v);
  };
  return { requests, call };
}
const always = (w: 'TAKE' | 'SKIP', wo: 'TAKE' | 'SKIP') => fake({ with: [w], without: [wo] });

const OPTS = { sessions: [SESSION], effort: 'medium' as const, minConfidence: 60, strongClusterBoost: 10, strongChannels: 3, concurrency: 1 };

/** `n` scorable decisions on `day` (each a +₹100 winner if taken), stored SKIP. */
const many = (n: number, day = SESSION, prefix = 'd') =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, { verdict: 'SKIP', confidence: 70 }, { at: ist('10:10', day) }));

describe('notes-judge-replay', () => {
  it('re-judges BOTH arms fresh, 3 runs each, same model and effort; only the notes differ', async () => {
    const f = always('SKIP', 'SKIP');
    await replayNotes({ session: SESSION, readings, decisions: [row('d1', { verdict: 'SKIP', confidence: 70 })] }, { ...OPTS, call: f.call });
    expect(f.requests).toHaveLength(6);
    const withReqs = f.requests.filter(hasNotes);
    const withoutReqs = f.requests.filter((r) => !hasNotes(r));
    expect(withReqs).toHaveLength(3);
    expect(withoutReqs).toHaveLength(3);

    const w = withReqs[0];
    const packet = JSON.parse(w.messages[0].content) as { promptVersion: string; at: string; channelViews: { status: string; verifiedNotes: Array<{ claim: string; at: string }>; verifiedNotesSource: string } };
    expect(packet.channelViews.verifiedNotes.map((n) => n.claim)).toEqual(['market strong before']);
    expect(packet.channelViews.verifiedNotes[0].at).toBe('10:00');
    expect(packet.channelViews.status).toBe('ok');
    expect(packet.channelViews.verifiedNotesSource).toBe('message_readings (AI present-state check), today');
    expect(packet.promptVersion).toBe('signal-judge-v9-take');
    expect(packet.at).toBe(AT.toISOString());
    expect(w.system[0].text).toBe(signalJudgeSystem('take', 60, true));

    const wo = withoutReqs[0];
    const pWo = JSON.parse(wo.messages[0].content) as { promptVersion: string; channelViews: Record<string, unknown> };
    expect(pWo.promptVersion).toBe('signal-judge-v8-take');
    expect(pWo.channelViews).not.toHaveProperty('verifiedNotes');
    expect(wo.system[0].text).toBe(signalJudgeSystem('take', 60, false));

    for (const r of f.requests) {
      expect(r.model).toBe('claude-opus-5'); // the stored record's model, both arms
      expect(r.output_config.effort).toBe('medium');
      expect(r.output_config.format?.type).toBe('json_schema');
    }
  });

  it('majority per arm; a tie is SKIP', () => {
    expect(majority(['TAKE', 'TAKE', 'SKIP'])).toBe('TAKE');
    expect(majority(['TAKE', 'SKIP', 'SKIP'])).toBe('SKIP');
    expect(majority(['TAKE', 'SKIP'])).toBe('SKIP');
    expect(majority([])).toBe('SKIP');
  });

  it('the arm decision is the majority of its runs; the stored verdict is only reported', async () => {
    // with: TAKE, SKIP, TAKE → TAKE; without: SKIP, TAKE, SKIP → SKIP. Stored = TAKE (never graded).
    const f = fake({ with: ['TAKE', 'SKIP', 'TAKE'], without: ['SKIP', 'TAKE', 'SKIP'] });
    const r = await replayNotes({ session: SESSION, readings, decisions: [row('d1', { verdict: 'TAKE', confidence: 90 })] }, { ...OPTS, call: f.call });
    const x = r.rows[0];
    expect(x.with.runs.map((v) => v.decision)).toEqual(['TAKE', 'SKIP', 'TAKE']);
    expect(x.with.decision).toBe('TAKE');
    expect(x.without.decision).toBe('SKIP');
    expect(x.stored).toMatchObject({ decision: 'TAKE' });
    expect(r.withoutNet).toBe(0); // the fresh without-arm SKIP, not the stored TAKE
    expect(r.withNet).toBe(100);
    expect(renderNotesReplay(r)).toContain('| TAKE 90 → TAKE |');
  });

  it('a run that fails after a retry is counted; a tie of the rest is SKIP', async () => {
    // with: TAKE, then fail twice (one run lost), then SKIP → 1 TAKE / 1 SKIP → SKIP.
    const f = fake({ with: ['TAKE', 'fail', 'fail', 'SKIP'], without: ['SKIP'] });
    const r = await replayNotes({ session: SESSION, readings, decisions: [row('d1', { verdict: 'SKIP', confidence: 70 })] }, { ...OPTS, call: f.call });
    expect(r.rows[0].with.failedRuns).toBe(1);
    expect(r.rows[0].with.decision).toBe('SKIP');
    expect(r.failedRuns).toBe(1);
    expect(r.failed).toHaveLength(0);
  });

  it('LOW SAMPLE — NO-GO below 20 graded decisions, even when notes win', async () => {
    const r = await replayNotes({ session: SESSION, readings, decisions: many(MIN_GRADED - 1) }, { ...OPTS, call: always('TAKE', 'SKIP').call });
    expect(r.compared).toBe(19);
    expect(r.withNet).toBeGreaterThan(r.withoutNet);
    expect(r.lowSample).toBe(true);
    expect(r.go).toBe(false);
    expect(renderNotesReplay(r)).toMatch(/^\*\*LOW SAMPLE — NO-GO\*\*/m);
  });

  it('GO across two sessions once ≥ 20 graded and with-notes net is not worse; unscorable rows never count', async () => {
    const fx: NotesReplayFixture[] = [
      { session: SESSION, readings, decisions: [...many(12, SESSION, 'a'), row('u1', { verdict: 'TAKE', confidence: 80 }, { trade: false })] },
      { session: SESSION2, readings: [], decisions: many(8, SESSION2, 'b') },
    ];
    const r = await replayNotes(fx, { ...OPTS, sessions: [SESSION, SESSION2], call: always('TAKE', 'SKIP').call });
    expect(r.sessions).toEqual([SESSION, SESSION2]);
    expect(r.compared).toBe(20);
    expect(r.unscorable).toHaveLength(1);
    expect(r.withNet).toBe(2000);
    expect(r.withoutNet).toBe(0);
    expect(r.go).toBe(true);
    const md = renderNotesReplay(r);
    expect(md).toMatch(/^\*\*GO\*\*/m);
    expect(md).toContain(`session(s) ${SESSION}, ${SESSION2}`);
  });

  it('NO-GO when with-notes is worse (≥ 20 graded)', async () => {
    const r = await replayNotes({ session: SESSION, readings, decisions: many(20) }, { ...OPTS, call: always('SKIP', 'TAKE').call });
    expect(r.withoutNet).toBe(2000);
    expect(r.withNet).toBe(0);
    expect(r.go).toBe(false);
    expect(r.lowSample).toBe(false);
    expect(renderNotesReplay(r)).toMatch(/^\*\*NO-GO\*\*/m);
  });

  it('goVerdict: a tie is GO at the minimum; a dead arm blocks GO', () => {
    expect(goVerdict({ withNet: 50, withoutNet: 50, compared: MIN_GRADED, failed: 0 }).go).toBe(true);
    expect(goVerdict({ withNet: 50, withoutNet: 50, compared: MIN_GRADED - 1, failed: 0 })).toMatchObject({ go: false, lowSample: true });
    expect(goVerdict({ withNet: 0, withoutNet: 0, compared: 0, failed: 0 }).go).toBe(false);
    expect(goVerdict({ withNet: 900, withoutNet: 0, compared: 40, failed: 1 }).go).toBe(false);
  });

  it('an arm whose every run fails puts the decision in failed (NO-GO)', async () => {
    const failing = async () => {
      throw new Error('vertex 503');
    };
    const r = await replayNotes({ session: SESSION, readings, decisions: [row('d1', { verdict: 'TAKE', confidence: 80 })] }, { ...OPTS, call: failing });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toMatch(/without-notes: vertex 503; with-notes: vertex 503/);
    expect(r.go).toBe(false);
  });

  it('replays a decision with no stored verdict; skips packets that already saw notes, and other sessions', async () => {
    const f = always('TAKE', 'TAKE');
    const other = row('d4', { verdict: 'TAKE', confidence: 80 }, { at: ist('10:10', '2026-11-23') });
    const fx: NotesReplayFixture = {
      session: SESSION,
      readings,
      decisions: [row('d1', null), row('d2', { verdict: 'TAKE', confidence: 80 }, { promptVersion: 'signal-judge-v9-take' }), other],
    };
    const r = await replayNotes(fx, { ...OPTS, call: f.call });
    expect(r.excluded.map((x) => x.decisionId)).toEqual(['d2']);
    expect(r.otherSession).toBe(1);
    expect(r.rows.map((x) => x.decisionId)).toEqual(['d1']);
    expect(r.rows[0].stored).toBeNull();
    expect(f.requests).toHaveLength(6);
    expect(renderNotesReplay(r)).toContain('| — |');
  });

  it('CLI: several fixtures and a repeated --session', () => {
    expect(parseReplayArgs(['a.json', 'b.json', '--session', SESSION, '--session', SESSION2, '--runs', '5', '--effort', 'high'])).toEqual({
      files: ['a.json', 'b.json'],
      sessions: [SESSION, SESSION2],
    });
    expect(parseReplayArgs(['a.json'])).toBeNull();
    expect(parseReplayArgs(['a.json', '--session', '24-11-2026'])).toBeNull();
    expect(parseReplayArgs(['--session', SESSION])).toBeNull();
  });
});
