/**
 * FAIR re-score of the AI entry judge (owner 2026-11-02). Offline only: reads a JSON fixture dumped
 * read-only from prod, never touches a database or the broker, writes nothing but stdout.
 *
 *   npx tsx apps/api/scripts/rescore-judge.ts <judge-rescore.fixture.json> > judge-rescore.md
 *
 * The fixture comes from apps/api/scripts/sql/export-judge-rescore.sql (every signal_decisions row since
 * 2026-10-19 with a paper trade). Each row is scored with the same code the paper watch now runs at the
 * close (domain/fair-inputs → domain/fair-score): the cap-sized stop (entry ∓ caps.maxLossPerTrade / lot)
 * and the signal's own SL replayed on the stored path — the contract's candles_1m, else the underlying's
 * candles_1m × |delta| (the chain snapshot's greek → put-call parity from the other leg → the moneyness
 * heuristic), plus the exit shadow's 30 s STOP row. A row without a dense path is UNSCORABLE; for those a
 * PROVISIONAL read from the paper sentinel's sparse ltp samples is shown separately (a stop seen there is
 * real; a stop NOT seen there cannot be excluded) and never counted in the fair totals.
 */
import { readFileSync } from 'fs';
import { capSizedStop, type FairCheck, type StopOutcome } from '../src/modules/signal-trader/domain/fair-score';
import { orderedTargets } from '../src/modules/signal-trader/domain/paper';
import { fairOfRow, type JudgeFixtureRow as Row } from './lib/judge-fixture';
import { judgeFacts } from '../src/modules/signal-trader/domain/fair-inputs';

const ist = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');
const inr = (v: number | null) => (v === null ? '—' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const out = (o: StopOutcome) => (o.result === 'UNSCORABLE' ? 'UNSCORABLE' : `${o.result}${o.price !== null ? ` @ ${o.price}` : ''} ${inr(o.pnl1Lot)}${o.ambiguous ? ' (same-bar)' : ''}`);

/** Sparse samples (report-only): a stop seen in them is real; one not seen cannot be excluded. */
function provisional(r: Row, side: string, entry: number, entryTs: number, capStop: number | null, target: number | null, lotQty: number): string {
  if (!r.trade.exitTime || r.trade.exitPrice === null) return '—';
  const buy = side.toUpperCase() !== 'SELL';
  const pts = [...r.looks.map(([ts, ltp]) => ({ ts, p: ltp })), ...(r.shadowStop ? [{ ts: r.shadowStop.ts, p: r.shadowStop.price }] : [])].filter((x) => x.ts > entryTs).sort((a, b) => a.ts - b.ts);
  for (const x of pts) {
    if (target !== null && (buy ? x.p >= target : x.p <= target)) return `TARGET seen ${ist(x.ts)} ${inr((buy ? 1 : -1) * (target - entry) * lotQty)} (a stop before it cannot be excluded)`;
    if (capStop !== null && (buy ? x.p <= capStop : x.p >= capStop)) return `STOPPED (seen ${ist(x.ts)} LTP ${x.p}) ${inr((buy ? 1 : -1) * (capStop - entry) * lotQty)}`;
  }
  const pnl = (buy ? 1 : -1) * (r.trade.exitPrice - entry) * lotQty;
  return `not seen in ${pts.length} sample(s) → paper exit ${inr(pnl)} (a stop between samples cannot be excluded)`;
}

function main(argv: string[]): number {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: npx tsx apps/api/scripts/rescore-judge.ts <judge-rescore.fixture.json>');
    return 1;
  }
  let rows: Row[];
  try {
    rows = JSON.parse(readFileSync(file, 'utf8')) as Row[];
  } catch (e) {
    console.error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const lines: string[] = [];
  type Scored = { row: Row; fair: FairCheck; decision: string; old: boolean | null; prov: string; flag: string };
  const scored: Scored[] = [];
  for (const r of rows) {
    const t = r.trade;
    const { fair, facts, entryTs } = fairOfRow(r);
    const entry = t.entryPrice ?? 0;
    const capStop = capSizedStop({ side: t.side, entry, cap: facts.cap, lotQty: facts.lotQty, signalSl: facts.signalSl, tick: facts.tick });
    const target = orderedTargets(t.side, entry, facts.targets)[0] ?? null;
    const prov = fair.verdict === 'UNSCORABLE' && facts.aiDecision !== 'NONE' ? provisional(r, t.side, entry, entryTs, capStop, target, facts.lotQty) : '';
    const planLtp = Number(r.plan?.ltp);
    const off = entry > 0 && planLtp > 0 ? Math.abs(entry - planLtp) / planLtp : 0;
    const lim = Number(r.plan?.limitPrice);
    const atLimit = lim > 0 && Math.abs(entry - lim) / lim < 0.001 && off > 0.003;
    const flag = atLimit ? `paper filled at the LIMIT ${lim} (+${Math.round(off * 1000) / 10}% over LTP ${planLtp}; a paper-fill artefact of rows before ~10-30 13:00 IST): the replay starts that much worse than the market` : '';
    scored.push({ row: r, fair, decision: facts.aiDecision, old: typeof r.aiCheck?.correct === 'boolean' ? r.aiCheck.correct : null, prov, flag });
  }

  // ---- totals ----
  const dec = (s: Scored) => s.decision !== 'NONE';
  const oldScored = scored.filter((s) => dec(s) && s.old !== null);
  const oldRight = oldScored.filter((s) => s.old).length;
  const fairScored = scored.filter((s) => s.fair.verdict !== 'UNSCORABLE');
  const fairRight = fairScored.filter((s) => s.fair.verdict === 'RIGHT').length;
  const sameOld = fairScored.filter((s) => s.old !== null);
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
  const skips = (kind: string, v: string) => fairScored.filter((s) => s.decision === 'SKIP' && s.fair.skipKind === kind && s.fair.verdict === v).length;
  const allSkips = (kind: string) => scored.filter((s) => s.decision === 'SKIP' && s.fair.skipKind === kind).length;

  lines.push('# AI entry judge — FAIR re-score (read-only, prod)');
  lines.push('');
  lines.push(`Fixture: ${rows.length} signal_decisions since 2026-10-19 with a paper trade (prod, read-only export, ${new Date().toISOString().slice(0, 16)}Z). Script: apps/api/scripts/rescore-judge.ts; rule: apps/api/src/modules/signal-trader/domain/fair-score.ts (${fairScored[0]?.fair.version ?? 'fair-v1'}).`);
  lines.push('');
  lines.push('**Rule.** Cap-sized stop = entry − caps.maxLossPerTrade / lot qty (BUY; + for SELL), never wider than the signal SL. Both it and the signal SL are replayed on the stored path; exit at T1 or the stop, whichever first, else the paper trade\'s own exit. SKIP is RIGHT when the cap-sized trade lost or was stopped, WRONG when it made money; TAKE symmetric. Stop and target in one bar → stop first. A path gap > 5 min before the first event → UNSCORABLE.');
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`| | scored | right | wrong | accuracy |`);
  lines.push(`|---|---|---|---|---|`);
  lines.push(`| OLD rule (no-stop learning trade), all rows | ${oldScored.length} | ${oldRight} | ${oldScored.length - oldRight} | ${pct(oldRight, oldScored.length)} |`);
  lines.push(`| OLD rule, on the fair-scorable rows only | ${sameOld.length} | ${sameOld.filter((s) => s.old).length} | ${sameOld.filter((s) => !s.old).length} | ${pct(sameOld.filter((s) => s.old).length, sameOld.length)} |`);
  lines.push(`| **FAIR rule (cap-sized stop)** | ${fairScored.length} | ${fairRight} | ${fairScored.length - fairRight} | ${pct(fairRight, fairScored.length)} |`);
  lines.push('');
  lines.push(`UNSCORABLE under the fair rule: **${scored.length - fairScored.length} of ${scored.length}** (${scored.filter((s) => s.decision === 'NONE').length} with no judge verdict).`);
  lines.push('');
  lines.push('SKIPs by kind (fair-scorable / all SKIPs of that kind):');
  lines.push('');
  lines.push(`| skipKind | fair RIGHT | fair WRONG | unscorable | all |`);
  lines.push(`|---|---|---|---|---|`);
  for (const k of ['RISK_CAP', 'JUDGEMENT']) {
    const r = skips(k, 'RIGHT');
    const w = skips(k, 'WRONG');
    lines.push(`| ${k} | ${r} | ${w} | ${allSkips(k) - r - w} | ${allSkips(k)} |`);
  }
  const takes = scored.filter((s) => s.decision === 'TAKE');
  lines.push('');
  lines.push(`TAKEs: ${takes.length} (fair RIGHT ${takes.filter((s) => s.fair.verdict === 'RIGHT').length}, WRONG ${takes.filter((s) => s.fair.verdict === 'WRONG').length}, unscorable ${takes.filter((s) => s.fair.verdict === 'UNSCORABLE').length}).`);
  lines.push('');
  lines.push(`Paper fills at the LIMIT (~0.5% over LTP, rows before ~10-30 13:00 IST): ${scored.filter((x) => x.flag).length} rows; their replays start from that fill, which favours SKIP slightly.`);
  lines.push('');
  lines.push('Path methods: ' + Object.entries(scored.reduce<Record<string, number>>((m, s) => ((m[s.fair.method] = (m[s.fair.method] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ×${v}`).join(', ') + '.');
  lines.push('');
  lines.push('## Per decision');
  lines.push('');
  lines.push('| entry (IST) | symbol | judge | old correct | FAIR | skipKind | risk 1 lot / cap | signal SL | cap stop | cap-sized outcome | signal-SL outcome | method | why unscorable / provisional |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of scored) {
    const r = s.row;
    const f = s.fair;
    const base = f.verdict === 'UNSCORABLE' ? [f.capOutcome.reason, s.prov ? `provisional: ${s.prov}` : ''].filter(Boolean).join(' · ') : f.note.replace(/\|/g, '/').slice(0, 160);
    const why = [s.flag ? `**${s.flag}**` : '', base].filter(Boolean).join(' · ');
    const risk = judgeFacts(r.judge, r.plan, r.instrument.lotSize).riskRupees1Lot;
    lines.push(
      `| ${r.trade.entryTime ? ist(Date.parse(r.trade.entryTime)) : '—'} | ${r.instrument.symbol} | ${s.decision} | ${s.old === null ? '—' : s.old ? 'right' : 'wrong'} | **${f.verdict}** | ${f.skipKind ?? '—'} | ${inr(risk)} / ₹${f.cap ?? '?'} | ${f.signalStop ?? '—'} | ${f.capStop ?? '—'} | ${out(f.capOutcome)} | ${out(f.signalStopOutcome)} | ${f.method} | ${why} |`,
    );
  }
  console.log(lines.join('\n'));
  return 0;
}

process.exit(main(process.argv.slice(2)));
