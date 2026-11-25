/**
 * Judge replay WITH and WITHOUT the AI-verified Telegram notes — the gate before MESSAGE_READER=on (spec
 * 2026-11-25-ai-message-reader-design §5.8). Offline: reads a JSON fixture dumped read-only from prod, never
 * touches a database or the broker; the only outside call is the judge on Vertex. Writes nothing but stdout.
 *
 *   npx tsx apps/api/scripts/notes-judge-replay.ts <notes-replay.fixture.json> --session YYYY-MM-DD \
 *     [--effort low|medium|high] [--model <id>] [--min-confidence N] [--concurrency N] > notes-replay.md
 *
 * The fixture comes from apps/api/scripts/sql/export-notes-replay.sql (one session's judged signal_decisions with
 * their paper trade's price path, and that session's message_readings). Per decision:
 *   - WITHOUT notes = the STORED verdict (no re-call). The stored packet must be a pre-reader one
 *     (signal-judge-v6 / signal-judge-v8-take); a packet that already carried notes is excluded.
 *   - WITH notes = the stored packet re-judged with channelViews.verifiedNotes as the live judge builds it at
 *     MESSAGE_READER=on: selectVerifiedNotes over the readings stored at or before the decision time (posted ≤ it
 *     AND read ≤ it — what the live judge could have seen), sector null as the live call passes, the notes
 *     prompt (signalJudgeSystem(mode, minConfidence, true)) and promptVersion (v7 / v9-take). Same request shape
 *     as SignalJudgeService; model = the stored record's model (else SIGNAL_JUDGE_MODEL / the default), effort
 *     = --effort, else SIGNAL_JUDGE_EFFORT, else medium (prod since 2026-11-20).
 *   - Both verdicts go through judgeDecision (the same floor and cluster boost) → TAKE / SKIP, and each is
 *     graded by the FAIR re-score path (scripts/lib/judge-fixture → domain/fair-inputs → domain/fair-score): a
 *     TAKE earns the cap-sized 1-lot outcome on the stored path, a SKIP earns ₹0.
 * A row with no gradeable path is UNSCORABLE: listed, never counted. Verdict: GO only if at least one row was
 * compared, no with-notes call failed, and with-notes net ≥ without-notes net.
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
  session: string;
  call: JudgeCall;
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
  verdict: JudgeVerdict;
  decision: Decision;
  fair: FairCheck | null;
  /** The decision's graded 1-lot outcome: TAKE = the cap-sized outcome, SKIP = 0; null = unscorable. */
  pnl: number | null;
}
export interface ReplayRow {
  decisionId: string;
  at: string;
  symbol: string;
  underlying: string;
  mode: 'take' | 'skip';
  notes: VerifiedNote[];
  without: Side;
  with: Side;
  unscorable: string | null;
}
export interface ReplayReport {
  session: string;
  model: string;
  effort: Effort;
  minConfidence: number;
  rows: ReplayRow[];
  /** Compared, graded rows only. */
  withNet: number;
  withoutNet: number;
  compared: number;
  flips: ReplayRow[];
  unscorable: ReplayRow[];
  excluded: Array<{ decisionId: string; reason: string }>;
  failed: Array<{ decisionId: string; error: string }>;
  otherSession: number;
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
  // sector null: the live call passes none (SECTOR notes reach the judge only via MARKET), as signal-trader.service does.
  return selectVerifiedNotes(rows, { underlying: underlying.trim().toUpperCase(), sector: null, now: at });
}

/** The stored packet as the live judge would have sent it at MESSAGE_READER=on. Never mutates the input. */
export function packetWithNotes(packet: Record<string, unknown>, mode: 'take' | 'skip', notes: VerifiedNote[]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
  copy.promptVersion = signalJudgePromptVersion(mode, true);
  copy.channelViews = { ...obj(copy.channelViews), verifiedNotes: notes, verifiedNotesSource: VERIFIED_NOTES_SOURCE };
  return copy;
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

/** GO only with at least one compared row, no failed with-notes call, and with-notes net ≥ without-notes net. */
export function goVerdict(i: { withNet: number; withoutNet: number; compared: number; failed: number }): { go: boolean; reason: string } {
  if (i.compared === 0) return { go: false, reason: 'no scorable decision to compare' };
  if (i.failed > 0) return { go: false, reason: `${i.failed} with-notes call(s) failed — re-run before deciding` };
  if (i.withNet >= i.withoutNet) return { go: true, reason: 'with-notes net is not worse' };
  return { go: false, reason: 'with-notes net is worse' };
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

export async function replayNotes(fx: NotesReplayFixture, o: ReplayOptions): Promise<ReplayReport> {
  const cfg = { judgeMinConfidence: o.minConfidence, strongClusterBoost: o.strongClusterBoost, strongChannels: o.strongChannels };
  const excluded: ReplayReport['excluded'] = [];
  const failed: ReplayReport['failed'] = [];
  const rows: ReplayRow[] = [];
  let otherSession = 0;
  const models = new Set<string>();
  type Job = { r: NotesReplayRow; packet: Record<string, unknown>; at: Date; mode: 'take' | 'skip'; stored: JudgeVerdict };
  const jobs: Job[] = [];
  for (const r of fx.decisions) {
    const judge = obj(r.judge);
    const packet = obj(judge.packet);
    const at = new Date(typeof packet.at === 'string' ? packet.at : r.createdAt);
    if (!Number.isFinite(at.getTime()) || istYmd(at) !== o.session) {
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
    const stored = storedVerdict(judge);
    if (!stored) {
      excluded.push({ decisionId: r.decisionId, reason: `no stored verdict (${String(judge.unavailable ?? judge.reason ?? 'judge unavailable')})` });
      continue;
    }
    jobs.push({ r, packet, at, mode, stored });
  }

  const cluster = (p: Record<string, unknown>) => {
    const c = obj(p.cluster);
    return { agreeCount: Number(c.agreeCount) || 1, conflict: c.conflict === true };
  };

  await pool(jobs, o.concurrency ?? 4, async ({ r, packet, at, mode, stored }) => {
    const underlying = String(r.underlying ?? r.instrument?.name ?? '');
    const notes = notesAt(fx.readings, underlying, at);
    const model = o.model ?? (typeof obj(r.judge).model === 'string' ? (obj(r.judge).model as string) : SIGNAL_DEFAULTS.judgeModel);
    models.add(model);
    const request = judgeRequest({ packet: packetWithNotes(packet, mode, notes), system: signalJudgeSystem(mode, o.minConfidence, true), model, effort: o.effort });
    let fresh: JudgeVerdict | null = null;
    let lastErr = '';
    for (let attempt = 0; attempt < 2 && !fresh; attempt++) {
      try {
        fresh = parseJudgeVerdict(await o.call(request));
      } catch (e) {
        lastErr = errText(e);
      }
    }
    if (!fresh) {
      failed.push({ decisionId: r.decisionId, error: lastErr });
      return;
    }
    const c = cluster(packet);
    const side = (v: JudgeVerdict): Side => {
      const decision: Decision = judgeDecision(v, c, cfg).take ? 'TAKE' : 'SKIP';
      const g = grade(r, decision);
      return { verdict: v, decision, fair: g.fair, pnl: g.pnl };
    };
    const without = side(stored);
    const withN = side(fresh);
    const unscorable = without.pnl === null || withN.pnl === null ? grade(r, without.decision).why ?? grade(r, withN.decision).why ?? 'unscorable' : null;
    rows.push({ decisionId: r.decisionId, at: at.toISOString(), symbol: r.instrument?.symbol ?? String(obj(obj(packet.plan)).contract ?? '—'), underlying, mode, notes, without, with: withN, unscorable });
  });

  rows.sort((a, b) => a.at.localeCompare(b.at) || a.decisionId.localeCompare(b.decisionId));
  const scored = rows.filter((x) => x.unscorable === null);
  const withNet = r2(scored.reduce((s, x) => s + (x.with.pnl as number), 0));
  const withoutNet = r2(scored.reduce((s, x) => s + (x.without.pnl as number), 0));
  const v = goVerdict({ withNet, withoutNet, compared: scored.length, failed: failed.length });
  return {
    session: o.session,
    model: [...models].join(', ') || o.model || '—',
    effort: o.effort,
    minConfidence: o.minConfidence,
    rows,
    withNet,
    withoutNet,
    compared: scored.length,
    flips: rows.filter((x) => x.with.decision !== x.without.decision),
    unscorable: rows.filter((x) => x.unscorable !== null),
    excluded,
    failed,
    otherSession,
    go: v.go,
    reason: v.reason,
  };
}

const inr = (v: number | null) => (v === null ? '—' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const istHm = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(11, 16);
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160);

export function renderNotesReplay(r: ReplayReport): string {
  const L: string[] = [];
  L.push(`**${r.go ? 'GO' : 'NO-GO'}** — ${r.reason}: with-notes net ${inr(r.withNet)} vs without-notes net ${inr(r.withoutNet)} over ${r.compared} graded decision(s).`);
  L.push('');
  L.push(`# Signal judge replay with and without verified notes — session ${r.session}`);
  L.push('');
  L.push(`Model ${r.model}, effort ${r.effort}, min confidence ${r.minConfidence}. Without notes = the stored verdict; with notes = the stored packet re-judged with channelViews.verifiedNotes as of the decision time (notes prompt v7 / v9-take). Each TAKE graded by the FAIR cap-sized 1-lot outcome (domain/fair-score); a SKIP = ₹0. Script: apps/api/scripts/notes-judge-replay.ts.`);
  L.push('');
  L.push('## Totals');
  L.push('');
  L.push('| | decisions | TAKEs | net (1 lot) |');
  L.push('|---|---|---|---|');
  const scored = r.rows.filter((x) => x.unscorable === null);
  L.push(`| without notes (stored) | ${scored.length} | ${scored.filter((x) => x.without.decision === 'TAKE').length} | ${inr(r.withoutNet)} |`);
  L.push(`| with notes (re-run) | ${scored.length} | ${scored.filter((x) => x.with.decision === 'TAKE').length} | ${inr(r.withNet)} |`);
  L.push('');
  L.push(`Re-judged: ${r.rows.length}. Unscorable (listed, not counted): ${r.unscorable.length}. Excluded: ${r.excluded.length}. With-notes calls failed: ${r.failed.length}. Rows from other sessions ignored: ${r.otherSession}.`);
  L.push('');
  L.push(`## Flips (${r.flips.length})`);
  L.push('');
  if (r.flips.length === 0) L.push('None.');
  for (const f of r.flips) {
    const delta = f.unscorable === null ? inr((f.with.pnl as number) - (f.without.pnl as number)) : `unscorable (${cell(f.unscorable)})`;
    L.push(`- ${istHm(f.at)} ${f.symbol}: ${f.without.decision} → ${f.with.decision}, Δ ${delta}. Notes: ${f.notes.length}. With-notes first reason: ${cell(f.with.verdict.reasons[0] ?? '—')}`);
  }
  L.push('');
  L.push('## Per decision');
  L.push('');
  L.push('| IST | symbol | prompt | notes | without: verdict → decision | outcome | with: verdict → decision | outcome | why unscorable |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) {
    const s = (d: Side) => `${d.verdict.verdict} ${d.verdict.confidence} → ${d.decision}`;
    L.push(`| ${istHm(x.at)} | ${x.symbol} | ${x.mode} | ${x.notes.length} | ${s(x.without)} | ${inr(x.without.pnl)} | ${s(x.with)} | ${inr(x.with.pnl)} | ${x.unscorable ? cell(x.unscorable) : ''} |`);
  }
  if (r.excluded.length) {
    L.push('');
    L.push('## Excluded');
    L.push('');
    for (const e of r.excluded) L.push(`- ${e.decisionId}: ${e.reason}`);
  }
  if (r.failed.length) {
    L.push('');
    L.push('## Failed with-notes calls');
    L.push('');
    for (const e of r.failed) L.push(`- ${e.decisionId}: ${cell(e.error)}`);
  }
  return L.join('\n');
}

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

async function main(argv: string[]): Promise<number> {
  const valued = new Set(['--session', '--effort', '--model', '--min-confidence', '--concurrency']);
  const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && valued.has(argv[i - 1])));
  const session = flag(argv, '--session');
  if (!file || !session || !/^\d{4}-\d{2}-\d{2}$/.test(session)) {
    console.error('Usage: npx tsx apps/api/scripts/notes-judge-replay.ts <notes-replay.fixture.json> --session YYYY-MM-DD [--effort low|medium|high] [--model id] [--min-confidence N] [--concurrency N]');
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
  if (!Number.isFinite(minConfidence) || !Number.isInteger(concurrency) || concurrency < 1) {
    console.error('bad --min-confidence / --concurrency');
    return 1;
  }
  let fx: NotesReplayFixture;
  try {
    fx = JSON.parse(readFileSync(file, 'utf8')) as NotesReplayFixture;
  } catch (e) {
    console.error(`${file}: ${errText(e)}`);
    return 1;
  }
  if (fx.session && fx.session !== session) {
    console.error(`${file} was exported for session ${fx.session}, not ${session}`);
    return 1;
  }
  // Loaded here so the tests (fake transport) never load the Vertex SDK.
  const { AnthropicVertexProvider, createVertexClient, vertexSettingsFrom } = await import('../src/modules/ai-gateway/providers/anthropic-vertex.provider');
  const vertex = new AnthropicVertexProvider(createVertexClient(vertexSettingsFrom(process.env)));
  const report = await replayNotes(fx, {
    session,
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
