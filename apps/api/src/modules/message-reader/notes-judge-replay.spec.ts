/**
 * scripts/notes-judge-replay.ts (Task 10, the gate before MESSAGE_READER=on). The spec lives here because jest's
 * rootDir is src/ (scripts/ is not a jest root). Fake transport only — no network, no database.
 */
import { signalJudgeSystem } from '../signal-trader/domain/judge';
import type { TransportMessage, TransportRequest } from '../ai-gateway/transport.types';
import { goVerdict, renderNotesReplay, replayNotes, type NotesReplayFixture, type NotesReplayRow } from '../../../scripts/notes-judge-replay';

const SESSION = '2026-11-24';
const ist = (hhmm: string) => new Date(`${SESSION}T${hhmm}:00+05:30`);
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
function row(id: string, stored: { verdict: 'TAKE' | 'SKIP'; confidence: number } | null, opts: { trade?: boolean; promptVersion?: string } = {}): NotesReplayRow {
  const entryTs = AT.getTime() + 30_000;
  const bars: Array<[number, number, number, number, number]> = [];
  for (let i = 1; i <= 5; i++) {
    const ts = Math.floor(entryTs / 60_000) * 60_000 + i * 60_000;
    bars.push([ts, 100 + i, 100 + i * 2.5, 99 + i, 100 + i * 2]);
  }
  const exitTs = bars[bars.length - 1][0] + 60_000;
  const packet = { promptVersion: opts.promptVersion ?? 'signal-judge-v8-take', at: AT.toISOString(), cluster: { agreeCount: 1, conflict: false }, channelViews: { status: 'ok', underlying: null }, caps: { maxLossPerTrade: 2000 } };
  return {
    decisionId: id,
    underlying: 'RELIANCE',
    createdAt: AT.toISOString(),
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

function fake(verdict: 'TAKE' | 'SKIP') {
  const requests: TransportRequest[] = [];
  return { requests, call: async (req: TransportRequest) => (requests.push(req), reply(verdict)) };
}

const OPTS = { session: SESSION, effort: 'medium' as const, minConfidence: 60, strongClusterBoost: 10, strongChannels: 3, concurrency: 1 };

describe('notes-judge-replay', () => {
  it('injects only notes posted (and stored) at or before the decision, with the live notes prompt and version', async () => {
    const f = fake('SKIP');
    await replayNotes({ session: SESSION, readings, decisions: [row('d1', { verdict: 'SKIP', confidence: 70 })] }, { ...OPTS, call: f.call });
    expect(f.requests).toHaveLength(1);
    const req = f.requests[0];
    const packet = JSON.parse(req.messages[0].content) as { promptVersion: string; at: string; channelViews: { status: string; verifiedNotes: Array<{ claim: string; at: string }>; verifiedNotesSource: string } };
    expect(packet.channelViews.verifiedNotes.map((n) => n.claim)).toEqual(['market strong before']);
    expect(packet.channelViews.verifiedNotes[0].at).toBe('10:00');
    expect(packet.channelViews.status).toBe('ok'); // the stored block is kept; notes are added like the live repository does
    expect(packet.channelViews.verifiedNotesSource).toBe('message_readings (AI present-state check), today');
    expect(packet.promptVersion).toBe('signal-judge-v9-take');
    expect(packet.at).toBe(AT.toISOString());
    expect(req.system[0].text).toBe(signalJudgeSystem('take', 60, true));
    expect(req.model).toBe('claude-opus-5'); // the stored record's model
    expect(req.output_config.effort).toBe('medium');
    expect(req.output_config.format.type).toBe('json_schema');
  });

  it('GO when the with-notes net is not worse', async () => {
    // Stored SKIP on a winning trade (0) → notes TAKE it (+₹100). Unscorable rows (no trade) never count.
    const fx: NotesReplayFixture = { session: SESSION, readings, decisions: [row('d1', { verdict: 'SKIP', confidence: 70 }), row('d2', { verdict: 'TAKE', confidence: 80 }, { trade: false })] };
    const r = await replayNotes(fx, { ...OPTS, call: fake('TAKE').call });
    expect(r.withoutNet).toBe(0);
    expect(r.withNet).toBe(100);
    expect(r.compared).toBe(1);
    expect(r.unscorable).toHaveLength(1);
    expect(r.flips.map((x) => x.decisionId)).toEqual(['d1']);
    expect(r.go).toBe(true);
    const md = renderNotesReplay(r);
    expect(md).toMatch(/^\*\*GO\*\*/m);
    expect(md).toContain('with-notes net +₹100 vs without-notes net +₹0');
  });

  it('GO on a tie (not worse)', () => {
    expect(goVerdict({ withNet: 50, withoutNet: 50, compared: 3, failed: 0 }).go).toBe(true);
  });

  it('NO-GO when worse', async () => {
    // Stored TAKE on a winning trade (+₹100) → notes SKIP it (0).
    const fx: NotesReplayFixture = { session: SESSION, readings, decisions: [row('d1', { verdict: 'TAKE', confidence: 80 })] };
    const r = await replayNotes(fx, { ...OPTS, call: fake('SKIP').call });
    expect(r.withoutNet).toBe(100);
    expect(r.withNet).toBe(0);
    expect(r.go).toBe(false);
    expect(renderNotesReplay(r)).toMatch(/^\*\*NO-GO\*\*/m);
  });

  it('NO-GO when nothing is comparable or a with-notes call failed', async () => {
    expect(goVerdict({ withNet: 0, withoutNet: 0, compared: 0, failed: 0 }).go).toBe(false);
    const failing = async () => {
      throw new Error('vertex 503');
    };
    const fx: NotesReplayFixture = { session: SESSION, readings, decisions: [row('d1', { verdict: 'TAKE', confidence: 80 })] };
    const r = await replayNotes(fx, { ...OPTS, call: failing });
    expect(r.failed).toHaveLength(1);
    expect(r.go).toBe(false);
  });

  it('skips rows with no stored verdict or whose stored verdict already saw notes, and other sessions', async () => {
    const f = fake('TAKE');
    const other = { ...row('d4', { verdict: 'TAKE', confidence: 80 }), createdAt: '2026-11-23T05:00:00.000Z' };
    (other.judge as { packet: { at: string } }).packet.at = '2026-11-23T05:00:00.000Z';
    const fx: NotesReplayFixture = {
      session: SESSION,
      readings,
      decisions: [row('d1', null), row('d2', { verdict: 'TAKE', confidence: 80 }, { promptVersion: 'signal-judge-v9-take' }), other],
    };
    const r = await replayNotes(fx, { ...OPTS, call: f.call });
    expect(f.requests).toHaveLength(0);
    expect(r.excluded.map((x) => x.decisionId).sort()).toEqual(['d1', 'd2']);
    expect(r.rows).toHaveLength(0);
    expect(r.go).toBe(false);
  });
});
