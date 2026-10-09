import { readFileSync } from 'fs';
import { join } from 'path';
import { validateBlocks } from './blocks/validate-blocks';
import type { StrategyBlocks } from './blocks/block-types';
import * as adaptive from '../../adaptive-stop-track/constants';

/**
 * The M1 seeds are rows in the migration (data, not code). This spec proves
 * (1) they are valid blocks and (2) every number equals the silo code it was
 * copied from at M1 (plan decision 5). The silo is read, never imported for
 * behaviour. If a silo legitimately changes later, v1 does NOT change: replace
 * the source lookup here with the M1 literal and keep the seed as it is.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const MIGRATION = join(ROOT, 'prisma', 'migrations', '20261009120000_sp2_m1_strategy_catalogue', 'migration.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const silo = (rel: string) => readFileSync(join(ROOT, 'apps', 'api', 'src', 'modules', rel), 'utf8');

const ADAPTIVE_WATCH = 'adaptive-stop-track/services/adaptive-stop-watch.service.ts';
const ADAPTIVE_POLLER = 'adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts';
const UNGATED_WATCH = 'ungated-track/services/ungated-watch.service.ts';
const UNGATED_POLLER = 'ungated-track/services/ungated-tick-poller.service.ts';
const UNGATED_ACCOUNT = 'ungated-track/services/ungated-paper-account.service.ts';
const TRADE_POLICY = 'watch-monitor/services/trade-policy.ts';
const DECISION_GATE = 'adaptive-stop-track/adaptive-stop-decision-gate.ts';
const CHARTINK_PROCESS = 'chartink/services/chartink-process.service.ts';

/** Minutes in `export const TRADE_COOLDOWN_MS = 45 * 60_000;`. */
function cooldownMinutes(file: string): number {
  const m = /TRADE_COOLDOWN_MS = (\d+) \* 60_000/.exec(silo(file));
  if (!m) throw new Error(`TRADE_COOLDOWN_MS not found in ${file}`);
  return Number(m[1]);
}

/** Seed version id → blocks, from the migration's single-line JSON literals. */
function seedBlocks(): Map<string, StrategyBlocks> {
  const out = new Map<string, StrategyBlocks>();
  const re = /SELECT '(csv_[a-z0-9_]+)', s\."id", 1, '(\{[^']*\})'::jsonb/g;
  for (const m of sql.matchAll(re)) out.set(m[1], JSON.parse(m[2]) as StrategyBlocks);
  return out;
}

/** The first numeric literal assigned to `name` in a silo file (underscores allowed). */
function constIn(file: string, name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*([0-9_.]+)`).exec(silo(file));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return Number(m[1].replace(/_/g, ''));
}

/** "HH:MM" of the `@Cron('0 M H * * 1-5')` EOD square-off in a tick poller. */
function eodClock(file: string): string {
  const m = /@Cron\('0 (\d{1,2}) (\d{1,2}) \* \* 1-5'/.exec(silo(file));
  if (!m) throw new Error(`no EOD cron in ${file}`);
  return `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
}

describe('M1 seed rows', () => {
  const seeds = seedBlocks();

  it('are exactly Adaptive-Stop v1 and Ungated v1, inserted idempotently as OWNER drafts', () => {
    expect([...seeds.keys()].sort()).toEqual(['csv_adaptive_stop_v1', 'csv_ungated_v1']);
    expect(sql).toContain('ON CONFLICT ("key") DO NOTHING');
    expect(sql).toContain('ON CONFLICT ("strategyId", "version") DO NOTHING');
    expect(sql.match(/'DRAFT', 'OWNER'/g)).toHaveLength(2);
  });

  it('every seed passes validateBlocks for its strategy', () => {
    for (const blocks of seeds.values()) {
      expect(validateBlocks(blocks, { allowedVehicles: ['CASH_INTRADAY'] })).toEqual([]);
    }
  });

  it('Adaptive-Stop v1 equals the adaptive-stop-track code', () => {
    const b = seeds.get('csv_adaptive_stop_v1')!;
    expect(b.entry).toEqual({
      kind: 'chartink', scanName: null, match: 'ANY', side: 'BUY',
      minScore: {
        base: constIn(TRADE_POLICY, 'MIN_SCORE_NORMAL'),
        windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: constIn(TRADE_POLICY, 'MIN_SCORE_STRICT') }],
      },
    });
    expect(silo(TRADE_POLICY)).toContain('minutesOfDay >= 11 * 60 + 45 && minutesOfDay < 14 * 60');
    expect(silo(ADAPTIVE_WATCH)).toMatch(/if \(input\.side !== 'BUY'\) throw new AdaptiveStopSellDirectionError/);

    expect(b.filters).toEqual({
      staleEntry: { maxMovePct: 1 },
      cooldown: { minutes: cooldownMinutes(ADAPTIVE_WATCH) },
      lastLoss: { window: 'SAME_IST_DAY' },
      gates: [{
        kind: 'evaluator',
        evaluatorKey: 'adaptive-stop-decision-gate',
        params: {
          nearSupportPct: adaptive.GATE_NEAR_SUPPORT_PCT,
          rsiHot: adaptive.GATE_RSI_HOT,
          vwapExtPct: adaptive.GATE_VWAP_EXT_PCT,
          requireMacdBullish: adaptive.GATE_REQUIRE_15M_MACD,
          srLookbackDays: adaptive.GATE_SR_LOOKBACK_DAYS,
          minCandles: 10,
          minSameDayCandles: 3,
          failOpen: true,
        },
      }],
    });
    expect(adaptive.DECISION_GATE_ENABLED).toBe(true);
    expect(silo(ADAPTIVE_WATCH)).toContain('if (moveFromAlert > 0.01)');
    expect(silo(ADAPTIVE_WATCH)).toContain('if (lastPnl !== null && lastPnl <= 0)');
    expect(silo(DECISION_GATE)).toContain('if (before.length < 10 || sameDay.length < 3) return skip(');
    expect(silo(DECISION_GATE)).toContain('pass: true, skipped: true');

    expect(b.stop).toEqual({
      kind: 'atr', period: 14, timeframe: '5m',
      multiple: adaptive.ATR_MULT, minPct: adaptive.MIN_STOP_PCT, maxPct: adaptive.MAX_STOP_PCT,
    });
    expect(silo(ADAPTIVE_WATCH)).toMatch(/getHistoricalData\(token, exchange, '5m', from, now\)/);
    expect(silo(ADAPTIVE_WATCH)).toMatch(/c\.map\(\(x: any\) => x\.close\),\s*14,/);

    expect(b.target).toEqual({ kind: 'fixedPct', pct: expect.closeTo(adaptive.PROFIT_TARGET_PCT * 100, 10) });
    expect(b.trail).toEqual({
      kind: 'atr', multiple: adaptive.TRAIL_ATR_MULT, minPct: adaptive.TRAIL_MIN_PCT, maxPct: adaptive.TRAIL_MAX_PCT,
      startsAfter: 'PARTIAL',
    });
    expect(b.partial).toEqual({
      kind: 'atTarget1',
      fraction: constIn(ADAPTIVE_WATCH, 'PARTIAL_EXIT_FRACTION'),
      atPct: expect.closeTo(constIn(ADAPTIVE_WATCH, 'PARTIAL_EXIT_THRESHOLD_PCT') * 100, 10),
    });
    expect(b.sizing).toEqual({ kind: 'riskRupees', amount: adaptive.RISK_PER_TRADE });
    expect(b.timeExit).toEqual({ kind: 'clock', hhmm: eodClock(ADAPTIVE_POLLER) });
    expect(b.timeExit).toEqual({ kind: 'clock', hhmm: '15:15' });
    expect(b.vehicle).toEqual({ kind: 'CASH_INTRADAY' });
  });

  it('Ungated v1 equals the ungated-track code', () => {
    const b = seeds.get('csv_ungated_v1')!;
    expect(b.entry).toEqual({ kind: 'chartink', scanName: 'hull', match: 'CONTAINS', side: 'BUY', minScore: null });
    expect(silo(CHARTINK_PROCESS)).toContain('UNGATED shadow track — runs unconditionally for every scored alert');
    expect(b.filters).toEqual({
      staleEntry: { maxMovePct: 1 },
      cooldown: { minutes: cooldownMinutes(UNGATED_WATCH) },
      lastLoss: { window: 'SAME_IST_DAY' },
      gates: [],
    });
    expect(silo(UNGATED_WATCH)).toContain('if (moveFromAlert > 0.01)');
    expect(silo(UNGATED_WATCH)).toContain('if (lastPnl !== null && lastPnl <= 0)');
    expect(silo('ungated-track/services/ungated-scanner-filter.ts')).toContain(".includes('hull')");
    // Ruling P5: the silo's Hull match is case-insensitive (CONTAINS compares case-insensitively).
    expect(silo('ungated-track/services/ungated-scanner-filter.ts')).toContain(".toLowerCase().includes('hull')");
    expect(silo(UNGATED_WATCH)).toMatch(/if \(input\.side !== 'BUY'\) throw new UngatedSellDirectionError/);

    expect(b.stop).toEqual({ kind: 'fixedPct', pct: expect.closeTo(constIn(UNGATED_WATCH, 'HARD_STOP_PCT') * 100, 10) });
    expect(b.target).toEqual({ kind: 'fixedPct', pct: expect.closeTo(constIn(UNGATED_WATCH, 'PROFIT_TARGET_PCT') * 100, 10) });
    expect(b.trail).toEqual({ kind: 'none' });
    expect(b.partial).toEqual({ kind: 'none' });
    expect(silo(UNGATED_WATCH)).toContain('Pure-hold: partial-exit + trailing removed');
    expect(b.sizing).toEqual({ kind: 'notionalRupees', amount: constIn(UNGATED_ACCOUNT, 'TRADE_CAPITAL') });
    expect(b.timeExit).toEqual({ kind: 'clock', hhmm: eodClock(UNGATED_POLLER) });
    expect(b.timeExit).toEqual({ kind: 'clock', hhmm: '15:25' });
    expect(b.vehicle).toEqual({ kind: 'CASH_INTRADAY' });
  });
});
