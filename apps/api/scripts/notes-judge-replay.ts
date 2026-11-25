/**
 * Judge replay WITH and WITHOUT the AI-verified Telegram notes — the gate before MESSAGE_READER=on (spec
 * 2026-11-25-ai-message-reader-design §5.8). Offline: reads a JSON fixture dumped read-only from prod, never
 * touches a database or the broker; the only outside call is the judge on Vertex. Writes nothing but stdout.
 *
 *   npx tsx apps/api/scripts/notes-judge-replay.ts <fixture.json> [<fixture.json> …] --session YYYY-MM-DD \
 *     [--session YYYY-MM-DD …] [--runs N] [--effort low|medium|high] [--model <id>] [--min-confidence N] \
 *     [--concurrency N] > notes-replay.md
 *
 * Each fixture comes from apps/api/scripts/sql/export-notes-replay.sql (one session's judged signal_decisions with
 * their paper trade's price path, and that session's message_readings). Several sessions are replayed together
 * (repeat --session, one fixture per session) so the sample can reach the GO minimum. Per decision, BOTH arms are
 * judged fresh with the same model and effort, N runs each (--runs, default 3):
 *   - WITHOUT notes = the stored pre-reader packet (signal-judge-v6 / signal-judge-v8-take) and the pre-reader
 *     prompt (signalJudgeSystem(mode, minConfidence, false)); a packet that already carried notes is excluded.
 *   - WITH notes = the same packet with channelViews.verifiedNotes as the live judge builds it at
 *     MESSAGE_READER=on: selectVerifiedNotes over the readings stored at or before the decision time (posted ≤ it
 *     AND read ≤ it — what the live judge could have seen), sector null as the live call passes, the notes
 *     prompt (signalJudgeSystem(mode, minConfidence, true)) and promptVersion (v7 / v9-take).
 *   Same request shape as SignalJudgeService; model = --model, else the stored record's model (else the
 *   default), effort = --effort, else SIGNAL_JUDGE_EFFORT, else medium (prod since 2026-11-20).
 *   - Every run goes through judgeDecision (the same floor and cluster boost) → TAKE / SKIP; an arm's decision is
 *     the MAJORITY of its successful runs (a tie → SKIP). Each arm's decision is graded by the FAIR re-score
 *     path (scripts/lib/judge-fixture → domain/fair-inputs → domain/fair-score): a TAKE earns the cap-sized
 *     1-lot outcome on the stored path, a SKIP earns ₹0. The STORED live verdict is only a reported column.
 * A row with no gradeable path is UNSCORABLE: listed, never counted. Verdict: GO only with ≥ 20 graded decisions
 * (below that "LOW SAMPLE — NO-GO"), no arm with every run failed, and with-notes net ≥ without-notes net.
 *
 * Vertex env: VERTEX_AI_PROJECT_ID, VERTEX_AI_LOCATION (default global), GOOGLE_APPLICATION_CREDENTIALS.
 */
import { readFileSync } from 'fs';
import { istYmd } from '../src/modules/market-cues/fetchers/ist-dates';
import { selectVerifiedNotes, type ReadingRow, type VerifiedNote } from '../src/modules/message-reader/domain/notes-for-judge';
import type { Claim, ReadScope } from '../src/modules/message-reader/domain/reading.types';
import {
  SIGNAL_JUDGE_PROMPT_VERSION,
  SIGNAL_JUDGE_PROMPT_VERSION_TAKE,
  SIGNAL_JUDGE_SCHEMA,
  judgeDecision,
  parseJudgeVerdict,
  signalJudgePromptVersion,
  signalJudgeSystem,
  type JudgeVerdict,
} from '../src/modules/signal-trader/domain/judge';
import { SIGNAL_DEFAULTS } from '../src/modules/signal-trader/domain/signal-trader.config';
import type { FairCheck } from '../src/modules/signal-trader/domain/fair-score';
import type { TransportMessage, TransportRequest } from '../src/modules/ai-gateway/transport.types';
import { fairOfRow, type JudgeFixtureRow } from './lib/judge-fixture';

/** = SignalJudgeService's JUDGE_MAX_TOKENS. */
const JUDGE_MAX_TOKENS = 4_000;
/** = signal-trader.repository's VERIFIED_NOTES_SOURCE (the channelViews field the live judge sees). */
const VERIFIED_NOTES_SOURCE = 'message_readings (AI present-state check), today';
/** GO needs at least this many graded decisions (across sessions). */
export const MIN_GRADED = 20;
/** Default runs per arm (majority verdict). */
export const DEFAULT_RUNS = 3;

export interface ReplayReading {
  messageId: string;
  channelId: string;
  channelTitle: string;
  postedAt: string;
  /** When the reading was stored (read_at, else created_at): the live judge could not see it before this. */
  availableAt: string;
  scope: string | null;
  claims: unknown;
  summary: string | null;
}

/** export-judge-rescore's row shape; `trade` / `instrument` are null when the decision opened no paper trade. */
export type NotesReplayRow = Omit<JudgeFixtureRow, 'trade' | 'instrument'> & {
  trade: JudgeFixtureRow['trade'] | null;
  instrument: JudgeFixtureRow['instrument'] | null;
};

export interface NotesReplayFixture {
  session: string;
  readings: ReplayReading[];
  decisions: NotesReplayRow[];
}

export type Effort = 'low' | 'medium' | 'high';
export type JudgeCall = (request: TransportRequest) => Promise<TransportMessage>;

export interface ReplayOptions {
  /** The IST sessions to replay (decisions outside them are ignored). */
  sessions: string[];
  call: JudgeCall;
  /** Fresh runs per arm (majority verdict; ties → SKIP). Default 3. */
  runs?: number;
  /** Overrides the stored record's model. */
  model?: string;
  effort: Effort;
  minConfidence: number;
  strongClusterBoost: number;
  strongChannels: number;
  concurrency?: number;
}

type Decision = 'TAKE' | 'SKIP';
interface Side {
  /** Each successful run's verdict and its judgeDecision. */
  runs: Array<{ verdict: JudgeVerdict; decision: Decision }>;
  /** Runs that failed (after one retry each). */
  failedRuns: number;
  /** Majority of the successful runs; a tie → SKIP. */
  decision: Decision;
  fair: FairCheck | null;
  /** The decision's graded 1-lot outcome: TAKE = the cap-sized outcome, SKIP = 0; null = unscorable. */
  pnl: number | null;
}
export interface ReplayRow {
  decisionId: string;
  session: string;
  at: string;
  symbol: string;
  underlying: string;
  mode: 'take' | 'skip';
  notes: VerifiedNote[];
  /** The live verdict stored at the time (reported only, never graded); null = the judge was unavailable then. */
  stored: { verdict: JudgeVerdict; decision: Decision } | null;
  without: Side;
  with: Side;
  unscorable: string | null;
}
export interface ReplayReport {
  sessions: string[];
  model: string;
  effort: Effort;
  minConfidence: number;
  runs: number;
  rows: ReplayRow[];
  /** Compared, graded rows only. */
  withNet: number;
  withoutNet: number;
  compared: number;
  flips: ReplayRow[];
  unscorable: ReplayRow[];
  excluded: Array<{ decisionId: string; reason: string }>;
  /** Decisions where an arm had no successful run (blocks GO). */
  failed: Array<{ decisionId: string; error: string }>;
  /** Individual failed runs across all arms (a partial failure still has a majority of the rest). */
  failedRuns: number;
  otherSession: number;
  lowSample: boolean;
  go: boolean;
  reason: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const r2 = (n: number) => Math.round(n * 100) / 100;
/** = signal-judge.service's signalJudgeEffort (not imported: that file pulls the Nest AI-gateway graph). */
const effortOf = (raw: string | null | undefined): Effort | null => {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'low' || v === 'medium' || v === 'high' ? v : null;
};

/** The stored packet's judge mode; null = not a pre-reader packet (an older prompt, or notes already on). */
export function storedMode(promptVersion: unknown): 'take' | 'skip' | null {
  if (promptVersion === SIGNAL_JUDGE_PROMPT_VERSION) return 'skip';
  if (promptVersion === SIGNAL_JUDGE_PROMPT_VERSION_TAKE) return 'take';
  return null;
}

/** The verified notes the live judge would have had at `at`: stored by then, posted by then, today, relevant. */
export function notesAt(readings: readonly ReplayReading[], underlying: string, at: Date): VerifiedNote[] {
  const t = at.getTime();
  const rows: ReadingRow[] = readings
    .filter((r) => Date.parse(r.availableAt) <= t && (r.scope === 'MARKET' || r.scope === 'SECTOR' || r.scope === 'INSTRUMENT'))
    .map((r) => ({
      messageId: r.messageId,
      channelId: r.channelId,
      channelTitle: r.channelTitle,
      postedAt: new Date(r.postedAt),
      scope: r.scope as ReadScope,
      claims: Array.isArray(r.claims) ? (r.claims as Claim[]) : [],
      summary: r.summary,
    }));
  // sector null: the live call passes none (sector claims are not matched), as signal-trader.service does.
  return selectVerifiedNotes(rows, { underlying: underlying.trim().toUpperCase(), sector: null, now: at });
}

/** The stored packet as the live judge would have sent it at MESSAGE_READER=on. Never mutates the input. */
export function packetWithNotes(packet: Record<string, unknown>, mode: 'take' | 'skip', notes: VerifiedNote[]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
  copy.promptVersion = signalJudgePromptVersion(mode, true);
  copy.channelViews = { ...obj(copy.channelViews), verifiedNotes: notes, verifiedNotesSource: VERIFIED_NOTES_SOURCE };
  return copy;
}

/** The stored pre-reader packet as the live judge sends it with MESSAGE_READER off / shadow. Never mutates the input. */
export function packetWithout(packet: Record<string, unknown>, mode: 'take' | 'skip'): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
  copy.promptVersion = signalJudgePromptVersion(mode, false);
  return copy;
}

/** Majority of the runs' decisions; a tie (or no run) → SKIP. */
export function majority(decisions: readonly Decision[]): Decision {
  const takes = decisions.filter((d) => d === 'TAKE').length;
  return takes > decisions.length - takes ? 'TAKE' : 'SKIP';
}

/** The request SignalJudgeService.judge builds (same schema, max tokens, effort placement). */
export function judgeRequest(i: { packet: Record<string, unknown>; system: string; model: string; effort: Effort }): TransportRequest {
  return {
    model: i.model,
    max_tokens: JUDGE_MAX_TOKENS,
    output_config: { effort: i.effort, format: { type: 'json_schema', schema: SIGNAL_JUDGE_SCHEMA as unknown as Record<string, unknown> } },
    system: [{ type: 'text', text: i.system }],
    messages: [{ role: 'user', content: JSON.stringify(i.packet) }],
    cli: { effort: i.effort },
  };
}

/** The stored judge record → its verdict; null when the judge was unavailable / invalid. */
function storedVerdict(judge: Record<string, unknown>): JudgeVerdict | null {
  if (judge.verdict !== 'TAKE' && judge.verdict !== 'SKIP') return null;
  const c = Number(judge.confidence);
  if (!Number.isFinite(c)) return null;
  return { verdict: judge.verdict, confidence: c, reasons: Array.isArray(judge.reasons) ? judge.reasons.filter((r): r is string => typeof r === 'string') : [], entry: null, sl: null, targets: [], lots: null };
}

/** Grade one decision on the row's stored path with the fair-score code (null fair = no paper trade). */
function grade(row: NotesReplayRow, decision: Decision): { fair: FairCheck | null; pnl: number | null; why: string | null } {
  if (!row.trade || !row.instrument) return { fair: null, pnl: null, why: 'no paper trade (no price path to grade)' };
  const { fair } = fairOfRow({ ...row, trade: row.trade, instrument: row.instrument, judge: { ...obj(row.judge), aiDecision: decision } });
  const pnl = fair.capOutcome.result === 'UNSCORABLE' ? null : fair.capOutcome.pnl1Lot;
  if (pnl === null) return { fair, pnl: null, why: fair.capOutcome.reason || 'no cap-sized outcome' };
  return { fair, pnl: decision === 'TAKE' ? pnl : 0, why: null };
}

/** GO only with ≥ MIN_GRADED graded decisions, no arm with every run failed, and with-notes net ≥ without-notes net. */
export function goVerdict(i: { withNet: number; withoutNet: number; compared: number; failed: number }): { go: boolean; lowSample: boolean; reason: string } {
  if (i.failed > 0) return { go: false, lowSample: false, reason: `${i.failed} decision(s) with an arm whose every run failed — re-run before deciding` };
  if (i.compared < MIN_GRADED) {
    return { go: false, lowSample: true, reason: `LOW SAMPLE — NO-GO: ${i.compared} graded decision(s), at least ${MIN_GRADED} needed (add sessions)` };
  }
  if (i.withNet >= i.withoutNet) return { go: true, lowSample: false, reason: 'with-notes net is not worse' };
  return { go: false, lowSample: false, reason: 'with-notes net is worse' };
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

export async function replayNotes(input: NotesReplayFixture | readonly NotesReplayFixture[], o: ReplayOptions): Promise<ReplayReport> {
  const fixtures = Array.isArray(input) ? (input as readonly NotesReplayFixture[]) : [input as NotesReplayFixture];
  const sessions = new Set(o.sessions);
  const runs = Math.max(1, Math.floor(o.runs ?? DEFAULT_RUNS));
  const cfg = { judgeMinConfidence: o.minConfidence, strongClusterBoost: o.strongClusterBoost, strongChannels: o.strongChannels };
  const excluded: ReplayReport['excluded'] = [];
  const failed: ReplayReport['failed'] = [];
  const rows: ReplayRow[] = [];
  let otherSession = 0;
  let failedRuns = 0;
  const models = new Set<string>();
  // Notes only ever come from the decision's own IST day (selectVerifiedNotes), so the readings can be pooled.
  const readings = fixtures.flatMap((f) => f.readings ?? []);
  type Job = { r: NotesReplayRow; packet: Record<string, unknown>; at: Date; session: string; mode: 'take' | 'skip'; stored: JudgeVerdict | null };
  const jobs: Job[] = [];
  for (const r of fixtures.flatMap((f) => f.decisions ?? [])) {
    const judge = obj(r.judge);
    const packet = obj(judge.packet);
    const at = new Date(typeof packet.at === 'string' ? packet.at : r.createdAt);
    const session = Number.isFinite(at.getTime()) ? istYmd(at) : '';
    if (!sessions.has(session)) {
      otherSession++;
      continue;
    }
    if (Object.keys(packet).length === 0) {
      excluded.push({ decisionId: r.decisionId, reason: 'no stored judge packet' });
      continue;
    }
    const mode = storedMode(packet.promptVersion);
    if (!mode) {
      excluded.push({ decisionId: r.decisionId, reason: `stored packet ${String(packet.promptVersion)} is not a pre-reader prompt (v6 / v8-take) — nothing to compare against` });
      continue;
    }
    // The stored verdict is only reported: a decision whose live judge was unavailable is still replayed.
    jobs.push({ r, packet, at, session, mode, stored: storedVerdict(judge) });
  }

  const cluster = (p: Record<string, unknown>) => {
    const c = obj(p.cluster);
    return { agreeCount: Number(c.agreeCount) || 1, conflict: c.conflict === true };
  };

  await pool(jobs, o.concurrency ?? 4, async ({ r, packet, at, session, mode, stored }) => {
    const underlying = String(r.underlying ?? r.instrument?.name ?? '');
    const notes = notesAt(readings, underlying, at);
    const model = o.model ?? (typeof obj(r.judge).model === 'string' ? (obj(r.judge).model as string) : SIGNAL_DEFAULTS.judgeModel);
    models.add(model);
    const c = cluster(packet);
    const decide = (v: JudgeVerdict): Decision => (judgeDecision(v, c, cfg).take ? 'TAKE' : 'SKIP');
    // Both arms fresh, same model and effort; only the notes (and their prompt line) differ.
    const requests = {
      without: judgeRequest({ packet: packetWithout(packet, mode), system: signalJudgeSystem(mode, o.minConfidence, false), model, effort: o.effort }),
      with: judgeRequest({ packet: packetWithNotes(packet, mode, notes), system: signalJudgeSystem(mode, o.minConfidence, true), model, effort: o.effort }),
    };
    const arms = { without: { runs: [] as Side['runs'], failedRuns: 0, lastErr: '' }, with: { runs: [] as Side['runs'], failedRuns: 0, lastErr: '' } };
    for (let k = 0; k < runs; k++) {
      for (const arm of ['without', 'with'] as const) {
        let v: JudgeVerdict | null = null;
        for (let attempt = 0; attempt < 2 && !v; attempt++) {
          try {
            v = parseJudgeVerdict(await o.call(requests[arm]));
          } catch (e) {
            arms[arm].lastErr = errText(e);
          }
        }
        if (v) arms[arm].runs.push({ verdict: v, decision: decide(v) });
        else arms[arm].failedRuns++;
      }
    }
    failedRuns += arms.without.failedRuns + arms.with.failedRuns;
    const dead = (['without', 'with'] as const).filter((a) => arms[a].runs.length === 0);
    if (dead.length) {
      failed.push({ decisionId: r.decisionId, error: dead.map((a) => `${a}-notes: ${arms[a].lastErr}`).join('; ') });
      return;
    }
    const side = (a: (typeof arms)['with']): Side => {
      const decision = majority(a.runs.map((x) => x.decision));
      const g = grade(r, decision);
      return { runs: a.runs, failedRuns: a.failedRuns, decision, fair: g.fair, pnl: g.pnl };
    };
    const without = side(arms.without);
    const withN = side(arms.with);
    const unscorable = without.pnl === null || withN.pnl === null ? grade(r, without.decision).why ?? grade(r, withN.decision).why ?? 'unscorable' : null;
    rows.push({
      decisionId: r.decisionId,
      session,
      at: at.toISOString(),
      symbol: r.instrument?.symbol ?? String(obj(obj(packet.plan)).contract ?? '—'),
      underlying,
      mode,
      notes,
      stored: stored ? { verdict: stored, decision: decide(stored) } : null,
      without,
      with: withN,
      unscorable,
    });
  });

  rows.sort((a, b) => a.at.localeCompare(b.at) || a.decisionId.localeCompare(b.decisionId));
  const scored = rows.filter((x) => x.unscorable === null);
  const withNet = r2(scored.reduce((s, x) => s + (x.with.pnl as number), 0));
  const withoutNet = r2(scored.reduce((s, x) => s + (x.without.pnl as number), 0));
  const v = goVerdict({ withNet, withoutNet, compared: scored.length, failed: failed.length });
  return {
    sessions: [...sessions].sort(),
    model: [...models].join(', ') || o.model || '—',
    effort: o.effort,
    minConfidence: o.minConfidence,
    runs,
    rows,
    withNet,
    withoutNet,
    compared: scored.length,
    flips: rows.filter((x) => x.with.decision !== x.without.decision),
    unscorable: rows.filter((x) => x.unscorable !== null),
    excluded,
    failed,
    failedRuns,
    otherSession,
    lowSample: v.lowSample,
    go: v.go,
    reason: v.reason,
  };
}

const inr = (v: number | null) => (v === null ? '—' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const istHm = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(11, 16);
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160);

export function renderNotesReplay(r: ReplayReport): string {
  const L: string[] = [];
  L.push(`**${r.lowSample ? 'LOW SAMPLE — NO-GO' : r.go ? 'GO' : 'NO-GO'}** — ${r.reason}: with-notes net ${inr(r.withNet)} vs without-notes net ${inr(r.withoutNet)} over ${r.compared} graded decision(s) (GO needs ≥ ${MIN_GRADED}).`);
  L.push('');
  L.push(`# Signal judge replay with and without verified notes — session(s) ${r.sessions.join(', ')}`);
  L.push('');
  L.push(`Model ${r.model}, effort ${r.effort}, min confidence ${r.minConfidence}, ${r.runs} run(s) per arm. Both arms re-judged fresh on the stored packet with the same model and effort: without notes = the pre-reader prompt (v6 / v8-take); with notes = channelViews.verifiedNotes as of the decision time (notes prompt v7 / v9-take). An arm's decision = the majority of its runs (tie → SKIP). Each TAKE graded by the FAIR cap-sized 1-lot outcome (domain/fair-score); a SKIP = ₹0. The stored live verdict is shown for reference only. Script: apps/api/scripts/notes-judge-replay.ts.`);
  L.push('');
  L.push('## Totals');
  L.push('');
  L.push('| | decisions | TAKEs | net (1 lot) |');
  L.push('|---|---|---|---|');
  const scored = r.rows.filter((x) => x.unscorable === null);
  L.push(`| without notes (re-run) | ${scored.length} | ${scored.filter((x) => x.without.decision === 'TAKE').length} | ${inr(r.withoutNet)} |`);
  L.push(`| with notes (re-run) | ${scored.length} | ${scored.filter((x) => x.with.decision === 'TAKE').length} | ${inr(r.withNet)} |`);
  L.push('');
  L.push(`Re-judged: ${r.rows.length}. Unscorable (listed, not counted): ${r.unscorable.length}. Excluded: ${r.excluded.length}. Decisions with a dead arm: ${r.failed.length}. Failed runs (all arms): ${r.failedRuns}. Rows from other sessions ignored: ${r.otherSession}.`);
  L.push('');
  L.push(`## Flips (${r.flips.length})`);
  L.push('');
  if (r.flips.length === 0) L.push('None.');
  for (const f of r.flips) {
    const delta = f.unscorable === null ? inr((f.with.pnl as number) - (f.without.pnl as number)) : `unscorable (${cell(f.unscorable)})`;
    L.push(`- ${f.session} ${istHm(f.at)} ${f.symbol}: ${f.without.decision} → ${f.with.decision}, Δ ${delta}. Notes: ${f.notes.length}. With-notes first reason: ${cell(f.with.runs[0]?.verdict.reasons[0] ?? '—')}`);
  }
  L.push('');
  L.push('## Per decision');
  L.push('');
  L.push('| session | IST | symbol | prompt | notes | stored (live) | without: runs → decision | outcome | with: runs → decision | outcome | why unscorable |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) {
    const s = (d: Side) => `${d.runs.map((v) => `${v.verdict.verdict[0]}${v.verdict.confidence}`).join(' ')}${d.failedRuns ? ` (+${d.failedRuns} failed)` : ''} → ${d.decision}`;
    const st = x.stored ? `${x.stored.verdict.verdict} ${x.stored.verdict.confidence} → ${x.stored.decision}` : '—';
    L.push(`| ${x.session} | ${istHm(x.at)} | ${x.symbol} | ${x.mode} | ${x.notes.length} | ${st} | ${s(x.without)} | ${inr(x.without.pnl)} | ${s(x.with)} | ${inr(x.with.pnl)} | ${x.unscorable ? cell(x.unscorable) : ''} |`);
  }
  if (r.excluded.length) {
    L.push('');
    L.push('## Excluded');
    L.push('');
    for (const e of r.excluded) L.push(`- ${e.decisionId}: ${e.reason}`);
  }
  if (r.failed.length) {
    L.push('');
    L.push('## Decisions with an arm whose every run failed');
    L.push('');
    for (const e of r.failed) L.push(`- ${e.decisionId}: ${cell(e.error)}`);
  }
  return L.join('\n');
}

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** Every value of a repeatable flag. */
function flags(argv: string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name && i + 1 < argv.length ? [argv[i + 1]] : []));
}

const VALUED = new Set(['--session', '--effort', '--model', '--min-confidence', '--concurrency', '--runs']);

/** CLI → fixture files and sessions (exported for the tests). */
export function parseReplayArgs(argv: string[]): { files: string[]; sessions: string[] } | null {
  const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.has(argv[i - 1])));
  const sessions = [...new Set(flags(argv, '--session'))];
  if (files.length === 0 || sessions.length === 0 || !sessions.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))) return null;
  return { files, sessions };
}

async function main(argv: string[]): Promise<number> {
  const args = parseReplayArgs(argv);
  if (!args) {
    console.error(
      'Usage: npx tsx apps/api/scripts/notes-judge-replay.ts <fixture.json> [<fixture.json> …] --session YYYY-MM-DD [--session YYYY-MM-DD …] [--runs N] [--effort low|medium|high] [--model id] [--min-confidence N] [--concurrency N]',
    );
    return 1;
  }
  const effortArg = flag(argv, '--effort');
  if (effortArg !== null && !effortOf(effortArg)) {
    console.error(`bad --effort: ${effortArg}`);
    return 1;
  }
  const effort = effortOf(effortArg) ?? effortOf(process.env.SIGNAL_JUDGE_EFFORT) ?? 'medium';
  const minConfidence = Number(flag(argv, '--min-confidence') ?? process.env.SIGNAL_JUDGE_MIN_CONFIDENCE ?? SIGNAL_DEFAULTS.judgeMinConfidence);
  const concurrency = Number(flag(argv, '--concurrency') ?? 4);
  const runs = Number(flag(argv, '--runs') ?? DEFAULT_RUNS);
  if (!Number.isFinite(minConfidence) || !Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(runs) || runs < 1) {
    console.error('bad --min-confidence / --concurrency / --runs');
    return 1;
  }
  const fixtures: NotesReplayFixture[] = [];
  for (const file of args.files) {
    let fx: NotesReplayFixture;
    try {
      fx = JSON.parse(readFileSync(file, 'utf8')) as NotesReplayFixture;
    } catch (e) {
      console.error(`${file}: ${errText(e)}`);
      return 1;
    }
    if (fx.session && !args.sessions.includes(fx.session)) {
      console.error(`${file} was exported for session ${fx.session}, not one of ${args.sessions.join(', ')}`);
      return 1;
    }
    fixtures.push(fx);
  }
  // Loaded here so the tests (fake transport) never load the Vertex SDK.
  const { AnthropicVertexProvider, createVertexClient, vertexSettingsFrom } = await import('../src/modules/ai-gateway/providers/anthropic-vertex.provider');
  const vertex = new AnthropicVertexProvider(createVertexClient(vertexSettingsFrom(process.env)));
  const report = await replayNotes(fixtures, {
    sessions: args.sessions,
    runs,
    call: async (req) => (await vertex.send(req)).message,
    model: flag(argv, '--model') ?? undefined,
    effort,
    minConfidence,
    strongClusterBoost: Number(process.env.SIGNAL_STRONG_CLUSTER_BOOST ?? SIGNAL_DEFAULTS.strongClusterBoost),
    strongChannels: Number(process.env.SIGNAL_STRONG_CHANNELS ?? SIGNAL_DEFAULTS.strongChannels),
    concurrency,
  });
  console.log(renderNotesReplay(report));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(errText(e));
      process.exitCode = 1;
    },
  );
}
