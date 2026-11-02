/**
 * Self-review learning-kinds replay (owner 2026-11-02). Offline only: reads two JSON fixtures dumped
 * read-only from prod, never touches a database or the broker, prints markdown.
 *
 *   npx tsx apps/api/scripts/replay-learning-kinds.ts <judge-rescore.fixture.json> <learning-kinds.fixture.json> [sessions…]
 *
 * For each IST session (default 2026-10-29, 2026-10-30, 2026-11-02): the SIGNAL_JUDGE, PAPER_EXIT and
 * ENGINE_ENTRY verification rows the nightly run would now write (self-review domain/learning-kinds, the
 * same scorers the run calls), then topMisses over them plus the session's STORED misses of the old
 * diagnosed kinds (verification_results), capped at DIAGNOSIS_MISS_CAP — what the diagnosis would get.
 * SIGNAL_JUDGE uses the FAIR check computed here from the judge fixture (prod rows closed before the fair
 * scoring shipped carry no ai_check.fair: the live run will not judge them; this replay shows what it would).
 */
import { readFileSync } from 'fs';
import { recoveryFromBars, scoreEngineEntry, scorePaperExit, scoreSignalJudge, wantOf } from '../src/modules/self-review/domain/learning-kinds';
import { topMisses } from '../src/modules/self-review/domain/summary';
import { DIAGNOSIS_MISS_CAP } from '../src/modules/self-review/self-review.ports';
import type { VerificationDraft } from '../src/modules/self-review/self-review.types';
import { fairOfRow, type JudgeFixtureRow, type Bar } from './lib/judge-fixture';

interface PaperExitFx {
  tradeId: string; side: string; qty: number; entryPrice: number | null; exitPrice: number | null; exitAt: string; exitTag: string; exitNotes: string | null;
  strategy: string; symbol: string; underlying: string | null; uRef: string | null;
  read: { verdict: string; n: number | null; underlyingAtExit: number | null; after15m: number | null; after30m: number | null; maxFavour30m: number | null; maxAgainst30m: number | null; summary: string | null } | null;
  held: { rulePnl: number | null; heldPnl: number | null; saved: number | null } | null;
  bars: Bar[];
}
interface LearningFx {
  paperExits: PaperExitFx[];
  engineTrades: Array<{ id: string; side: string; quantity: number; entryPrice: number | null; exitPrice: number | null; exitAt: string; exitReasonTag: string | null; notes: string | null }>;
  engineOpen: number;
  storedMisses: Array<{ sessionDate: string; kind: string; refId: string; symbol: string | null; score: number | null; predicted: string; actual: string }>;
  storedCounts: Array<{ sessionDate: string; kind: string; n: number; wrong: number }>;
}

const istDay = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
const cell = (s: unknown) => String(s ?? '—').replace(/\|/g, '/').replace(/\n/g, ' ');

function main(argv: string[]): number {
  const files = argv.filter((a) => a.endsWith('.json'));
  const sessions = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (files.length < 2) {
    console.error('Usage: npx tsx apps/api/scripts/replay-learning-kinds.ts <judge-rescore.fixture.json> <learning-kinds.fixture.json> [YYYY-MM-DD…]');
    return 1;
  }
  const judgeRows = JSON.parse(readFileSync(files[0], 'utf8')) as JudgeFixtureRow[];
  const fx = JSON.parse(readFileSync(files[1], 'utf8')) as LearningFx;
  const days = sessions.length ? sessions : ['2026-10-29', '2026-10-30', '2026-11-02'];

  const drafts: VerificationDraft[] = [];
  for (const r of judgeRows) {
    if (!r.trade.exitTime || r.trade.status !== 'CLOSED' || !(r.trade.tags ?? []).includes('learn')) continue;
    const s = istDay(Date.parse(r.trade.exitTime));
    if (!days.includes(s)) continue;
    const { fair, facts } = fairOfRow(r);
    const j = r.judge ?? {};
    drafts.push(scoreSignalJudge({
      decisionId: r.decisionId, sessionDate: s, symbol: r.instrument.symbol, channelId: null, aiDecision: facts.aiDecision,
      confidence: typeof j.confidence === 'number' ? j.confidence : null, reasons: facts.reasons, fair: fair as never,
      oldCorrect: typeof r.aiCheck?.correct === 'boolean' ? r.aiCheck.correct : null, exitTag: r.trade.exitTag, paperPnl: r.aiCheck?.pnl ?? null, promptVersion: null,
    }));
  }
  for (const x of fx.paperExits) {
    const exitAt = new Date(x.exitAt);
    const s = istDay(exitAt.getTime());
    if (!days.includes(s)) continue;
    const want = wantOf(x.side, x.symbol);
    const fromRead = x.read && x.read.n !== null && (x.read.maxFavour30m !== null || x.read.after30m !== null);
    const path = fromRead
      ? x.read!
      : recoveryFromBars(x.bars.map((b) => ({ ts: b[0], open: b[1], high: b[2], low: b[3], close: b[4] })), exitAt, want);
    const rule = x.exitTag === 'MOVED_STOP' ? 'MOVED_STOP' : /^AI trigger/i.test(x.exitNotes ?? '') ? 'AI_TRIGGER' : 'AI_EXIT';
    drafts.push(scorePaperExit({
      tradeId: x.tradeId, sessionDate: s, symbol: x.symbol, underlying: x.underlying, exitRule: rule, exitAt, want,
      entryPrice: x.entryPrice, exitPrice: x.exitPrice, qty: x.qty, reason: x.exitNotes ? x.exitNotes.split(' | ')[0].slice(0, 200) : null,
      n: path.n, nSource: fromRead ? 'exit noise read' : `candles_1m ${x.uRef} (${x.bars.length} bars)`, underlyingAtExit: path.underlyingAtExit,
      after15m: path.after15m, after30m: path.after30m, maxFavour30m: path.maxFavour30m, maxAgainst30m: path.maxAgainst30m,
      noiseVerdict: x.read?.verdict ?? null, noiseSummary: x.read?.summary ?? null, held: x.held,
    }));
  }
  for (const t of fx.engineTrades) {
    const s = istDay(Date.parse(t.exitAt));
    if (!days.includes(s)) continue;
    drafts.push(scoreEngineEntry({ id: t.id, sessionDate: s, symbol: null, underlying: null, side: t.side, quantity: t.quantity, entryPrice: t.entryPrice, exitPrice: t.exitPrice, exitReasonTag: t.exitReasonTag, reasons: t.notes ? [t.notes] : [] }));
  }

  const L: string[] = [];
  L.push('# Self-review learning kinds — replay over prod (read-only)');
  L.push('');
  L.push(`Sessions ${days.join(', ')}. Fixtures: scripts/sql/export-judge-rescore.sql + scripts/sql/export-learning-kinds.sql. ENGINE_ENTRY paper trades in the window: ${fx.engineTrades.length} closed, ${fx.engineOpen} opened.`);
  L.push('');
  L.push('| session | kind | rows | judged | right | MISSES | not judged | old diagnosed misses stored | sent to the diagnosis (cap 15): new / old |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const s of days) {
    const old = fx.storedMisses.filter((m) => m.sessionDate === s).map((m) => ({ ...m, correct: false as const }));
    const mine = drafts.filter((d) => d.sessionDate === s);
    const sent = topMisses([...mine, ...old] as Array<{ correct: boolean | null; score: number | null; kind: string }>, DIAGNOSIS_MISS_CAP);
    const sentNew = sent.filter((m) => ['SIGNAL_JUDGE', 'PAPER_EXIT', 'ENGINE_ENTRY'].includes(m.kind)).length;
    for (const k of ['SIGNAL_JUDGE', 'PAPER_EXIT', 'ENGINE_ENTRY'] as const) {
      const rows = mine.filter((d) => d.kind === k);
      const judged = rows.filter((d) => d.correct !== null);
      L.push(`| ${s} | ${k} | ${rows.length} | ${judged.length} | ${judged.filter((d) => d.correct).length} | **${judged.filter((d) => !d.correct).length}** | ${rows.length - judged.length} | ${k === 'SIGNAL_JUDGE' ? old.length : ''} | ${k === 'SIGNAL_JUDGE' ? `${sentNew} / ${sent.length - sentNew}` : ''} |`);
    }
  }
  L.push('');
  L.push('Old diagnosed kinds as stored (n / wrong): ' + days.map((s) => `${s}: ` + (fx.storedCounts.filter((c) => c.sessionDate === s && ['SCORECARD_TOTAL', 'OVERNIGHT_VERDICT', 'LIVE_EXIT', 'NEWS_IDEA', 'TRADE_SETUP'].includes(c.kind)).map((c) => `${c.kind} ${c.n}/${c.wrong}`).join(', ') || 'no verification rows yet')).join(' · '));
  L.push('');
  L.push('## Every new row');
  L.push('');
  L.push('| session | kind | symbol | correct | score | predicted | actual |');
  L.push('|---|---|---|---|---|---|---|');
  for (const d of drafts.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.kind.localeCompare(b.kind))) {
    L.push(`| ${d.sessionDate} | ${d.kind} | ${cell(d.symbol)} | ${d.correct === null ? '—' : d.correct ? 'right' : '**MISS**'} | ${d.score ?? '—'} | ${cell(d.predicted).slice(0, 140)} | ${cell(d.actual).slice(0, 220)} |`);
  }
  console.log(L.join('\n'));
  return 0;
}

process.exit(main(process.argv.slice(2)));
