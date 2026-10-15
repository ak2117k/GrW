/**
 * E6 — exit-discipline replay tuning harness (plan Task 19). Offline only; never
 * runs in the API and never touches a database or the broker.
 *
 *   npx ts-node apps/api/scripts/exit-replay.ts <fixture.json>... [--floorArmN 1,1.5,2] [--floorTrailN 1.5,2,2.5]
 *       [--gateUnderlyingN 0.5,1,1.5] [--persistWindowSec 300] [--persistMinSec 60,120,180] [--verbose]
 *
 * Replays each exported fixture (scripts/export-exit-fixture.ts, *.real.json) or the
 * synthetic one through the SAME pure rules the API runs, once per multiplier
 * setting (the cartesian product of the lists; unlisted keys keep the E1
 * defaults / api.env values), and prints which AI exit would have executed and
 * the resulting gross P&L. Exit code 1 on an unreadable or invalid fixture.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import { parseExitDisciplineConfig, type ExitDisciplineConfig } from '../src/modules/exit-discipline/config';
import { gateSummary } from '../src/modules/exit-discipline/decision';
import { validateFixture, type ExitFixtureV1 } from '../src/modules/exit-discipline/replay/fixture';
import { GRID_KEYS, gridConfigs, replayExits, type GridKey, type ReplayResult } from '../src/modules/exit-discipline/replay/replay-exits';
import { breakevenPrice } from '../src/modules/trade-sentinel/charges';

/* eslint-disable no-console */
const USAGE = `Usage: npx ts-node apps/api/scripts/exit-replay.ts <fixture.json>... [--floorArmN 1,1.5,2] [--floorTrailN 1.5,2,2.5]
    [--gateUnderlyingN 0.5,1,1.5] [--persistWindowSec 300] [--persistMinSec 60,120,180] [--verbose]`;

interface Args { files: string[]; grid: Partial<Record<GridKey, number[]>>; verbose: boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = { files: [], grid: {}, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--verbose') { a.verbose = true; continue; }
    if (x === '--help' || x === '-h') throw new Error('help');
    if (x.startsWith('--')) {
      const key = x.slice(2) as GridKey;
      if (!GRID_KEYS.includes(key)) throw new Error(`unknown option ${x} (grid keys: ${GRID_KEYS.join(', ')})`);
      const raw = argv[++i];
      if (raw === undefined) throw new Error(`${x} needs a comma-separated list`);
      const values = raw.split(',').map((s) => Number(s.trim()));
      if (values.some((n) => !Number.isFinite(n) || n < 0)) throw new Error(`${x} ${raw}: every value must be a number >= 0`);
      a.grid[key] = values;
      continue;
    }
    a.files.push(x);
  }
  return a;
}

const istHm = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 16);
const signed = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x)}`;
const be = (m: ExitFixtureV1['meta']) => breakevenPrice({ segment: m.segment, entryPrice: m.entryPrice, qty: m.qty, side: m.side }) ?? NaN;

function actualPnl(fx: ExitFixtureV1): number {
  const dir = fx.meta.side === 'LONG' ? 1 : -1;
  const exit = fx.meta.actualExit?.price ?? fx.meta.finalMark.price;
  return (exit - fx.meta.entryPrice) * fx.meta.qty * dir;
}

const COLS = 'armN trailN uN  persist   | exit           P&L ₹    vs actual | gated awaiting passed';
function settingCells(c: ExitDisciplineConfig): string {
  return `${String(c.floorArmN).padEnd(4)} ${String(c.floorTrailN).padEnd(6)} ${String(c.gateUnderlyingN).padEnd(3)} ${`${c.persistWindowSec}/${c.persistMinSec}`.padEnd(9)}`;
}
function row(c: ExitDisciplineConfig, r: ReplayResult, actual: number): string {
  const exit = r.executed ? `${istHm(r.executed.at)} @${r.executed.ltpNow}` : `held→${r.pnl.exitPrice}`;
  return `${settingCells(c)} | ${exit.padEnd(14)} ${signed(r.pnl.grossRupees).padStart(7)}  ${signed(r.pnl.grossRupees - actual).padStart(9)} | ` +
    `${String(r.counts.gated).padStart(5)} ${String(r.counts.awaiting).padStart(8)} ${String(r.counts.passed).padStart(6)}`;
}

function main(): number {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const help = err instanceof Error && err.message === 'help';
    (help ? console.log : console.error)(help ? USAGE : `${(err as Error).message}\n${USAGE}`);
    return help ? 0 : 2;
  }
  if (args.files.length === 0) { console.error(USAGE); return 2; }

  const base = parseExitDisciplineConfig({ ...process.env, EXIT_DISCIPLINE_ENABLED: 'true' });
  for (const p of base.problems) console.warn(`[exit-replay] ${p}`);
  const configs = gridConfigs(base, args.grid);

  const fixtures: Array<{ name: string; fx: ExitFixtureV1 }> = [];
  for (const f of args.files) {
    try {
      fixtures.push({ name: basename(f), fx: validateFixture(JSON.parse(readFileSync(f, 'utf8'))) });
    } catch (err) {
      console.error(`${f}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const totals = configs.map(() => ({ pnl: 0, vs: 0, gated: 0, awaiting: 0, passed: 0 }));
  for (const { name, fx } of fixtures) {
    const m = fx.meta;
    const actual = actualPnl(fx);
    const ae = m.actualExit ? `actual exit ${m.actualExit.price} @${istHm(m.actualExit.at)} (${signed(actual).replace(/^(\+?)/, '$1₹')})` : 'no actual exit';
    console.log(`\n${name}  entry ${m.entryPrice} x${m.qty} ${m.side}  ${ae}  final mark ${m.finalMark.price}`);
    if (fx.contractBars.length === 0) console.log('  (no contract bars: N unknown, the packet fixed floor is used; the thesis gate still runs)');
    console.log(COLS);
    configs.forEach((c, i) => {
      const r = replayExits(fx, { cfg: c, breakeven: be });
      console.log(row(c, r, actual));
      const t = totals[i];
      t.pnl += r.pnl.grossRupees; t.vs += r.pnl.grossRupees - actual;
      t.gated += r.counts.gated; t.awaiting += r.counts.awaiting; t.passed += r.counts.passed;
      if (args.verbose) {
        for (const d of r.decisions) console.log(`    ${istHm(d.at)} ${d.verdictId}: ${gateSummary(d.record)}`);
      }
    });
    if (fx.outcomes && fx.outcomes.length > 0) {
      console.log('  recorded ai_exit_outcomes:');
      for (const o of fx.outcomes) {
        console.log(`    ${o.verdictId} ${o.kind} missed=₹${Math.round(o.missedPnl ?? 0)} saved=₹${Math.round(o.savedPnl ?? 0)} net=₹${Math.round(o.netAtEnd ?? 0)}`);
      }
    }
  }
  if (fixtures.length > 1) {
    console.log(`\nTOTAL across ${fixtures.length} fixtures`);
    console.log('armN trailN uN  persist   |   P&L ₹    vs actual | gated awaiting passed');
    configs.forEach((c, i) => {
      const t = totals[i];
      console.log(`${settingCells(c)} | ${signed(t.pnl).padStart(8)}  ${signed(t.vs).padStart(9)} | ${String(t.gated).padStart(5)} ${String(t.awaiting).padStart(8)} ${String(t.passed).padStart(6)}`);
    });
  }
  return 0;
}

process.exit(main());
