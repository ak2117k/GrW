/**
 * Deterministic stand-in for the 2026-10-14 CRUDEOIL17NOV269000CE day
 * (spec §1 / §12) until the real production export is available. Built only
 * from the spec's numbers: the premium path through the 16:31 sale at 527.1
 * and the later 542, the underlying path that never reached the thesis
 * invalidation (8932), and the HOLD / EXIT_NOW flip-flops. Pure: no clock.
 */
import type { MinuteBar } from '../types';
import type { ExitFixtureV1, FixtureVerdict } from './fixture';

const DAY_UTC = Date.UTC(2026, 9, 14); // 2026-10-14
const IST_MS = 330 * 60_000;
const MIN = 60_000;
const ENTRY = 521.9;
const QTY = 100;
const CHARGES = 61;
const CONTRACT_WICK = 2.25;
const UNDERLYING_WICK = 1.5;
const CLOSE_IST = '23:30'; // MCX evening close

/** 'HH:mm' IST on 2026-10-14 → ms epoch. */
function ist(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`synthetic-crude: bad IST time ${hhmm}`);
  return DAY_UTC + (Number(m[1]) * 60 + Number(m[2])) * MIN - IST_MS;
}
const isoAt = (ms: number) => new Date(ms).toISOString();
const r2 = (x: number) => Math.round(x * 100) / 100;

const CONTRACT_KNOTS: Array<[string, number]> = [
  ['15:39', 521.9], ['15:50', 530], ['16:00', 536], ['16:10', 539.5], ['16:18', 526], ['16:25', 533],
  ['16:31', 527.1], ['16:40', 531], ['16:50', 535], ['17:05', 538], ['17:20', 542], ['17:45', 540],
];
const UNDERLYING_KNOTS: Array<[string, number]> = [
  ['15:39', 9000], ['16:00', 9012], ['16:10', 9018], ['16:20', 8998], ['16:31', 9003], ['17:00', 9010], ['17:45', 9015],
];
const VERDICTS: Array<[string, string, string?]> = [
  ['15:40', 'HOLD'], ['16:00', 'HOLD'], ['16:05', 'EXIT_NOW'], ['16:12', 'EXIT_ARMED'], ['16:20', 'HOLD'],
  ['16:24', 'EXIT_NOW'], ['16:26', 'EXIT_ARMED'], ['16:28', 'EXIT_NOW'], ['16:29', 'EXIT_ARMED'],
  ['16:31', 'EXIT_NOW', 'v-1631'], ['16:40', 'HOLD'], ['17:00', 'HOLD'],
];

/** Linear interpolation through the knots, one value per minute, 2 decimals. */
function path(knots: Array<[string, number]>): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  for (let k = 0; k < knots.length - 1; k++) {
    const [t0, v0] = [ist(knots[k][0]), knots[k][1]];
    const [t1, v1] = [ist(knots[k + 1][0]), knots[k + 1][1]];
    for (let t = t0; t < t1; t += MIN) out.push({ ts: t, value: r2(v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)) });
  }
  const last = knots[knots.length - 1];
  out.push({ ts: ist(last[0]), value: last[1] });
  return out;
}

/** open = previous close; high/low = the body ± a fixed wick. */
function toBars(p: Array<{ ts: number; value: number }>, wick: number): MinuteBar[] {
  return p.map((x, i) => {
    const open = i === 0 ? x.value : p[i - 1].value;
    return { ts: x.ts, open, high: r2(Math.max(open, x.value) + wick), low: r2(Math.min(open, x.value) - wick), close: x.value };
  });
}

const block = <T>(value: T, source: string, at: string) => ({ available: true as const, value, source, at });

function packetAt(atMs: number, ltp: number, underlying: number, contractBars: MinuteBar[]): Record<string, unknown> {
  const since = contractBars.filter((b) => b.ts >= ist('15:39') && b.ts <= atMs).map((b) => b.close);
  const mfe = Math.max(ENTRY, ...since);
  const mae = Math.min(ENTRY, ...since);
  const nowUtc = isoAt(atMs - 30_000);
  const gross = r2((ltp - ENTRY) * QTY);
  return {
    position: {
      symbol: 'CRUDEOIL17NOV269000CE', exchange: 'MCX', token: '582930', side: 'LONG', qty: QTY, entryPrice: ENTRY, ltp,
      expiry: '2026-11-17', underlyingLtp: block(underlying, 'synthetic', nowUtc),
    },
    money: { grossPnl: gross, charges: CHARGES, netPnl: r2(gross - CHARGES), greenFloorPrice: 524.85, greenFloorArmed: true, mfe, mae },
    thesis: block({ direction: 'LONG', reason: 'synthetic: long call into 9100', levelPrice: 8960, targetPrice: 9100, invalidation: 8932, source: 'AGENT' }, 'synthetic', nowUtc),
    structure: {
      levelBook: block({ vwap: 8995, atr14: 13.5, interval: '15m' }, 'synthetic', nowUtc),
      nearestSupport: block(8946, 'synthetic', nowUtc),
      nearestResistance: block(9020, 'synthetic', nowUtc),
    },
    flow: { volumeRatio: { available: false, reason: 'synthetic' }, oiWalls: { available: false, reason: 'synthetic' } },
    session: { nowUtc, minutesToClose: block(Math.round((ist(CLOSE_IST) - atMs) / MIN), 'synthetic', nowUtc) },
  };
}

/**
 * @param opts.breakAt 'HH:mm' IST — from this minute the underlying is pinned at
 *   `breakTo`, verdicts after it are dropped and a breaking `EXIT_NOW` (`v-break`) is appended.
 */
export function buildSyntheticCrudeFixture(opts: { breakAt?: string; breakTo?: number } = {}): ExitFixtureV1 {
  const contractBars = toBars(path(CONTRACT_KNOTS), CONTRACT_WICK);
  let underlyingBars = toBars(path(UNDERLYING_KNOTS), UNDERLYING_WICK);
  const breakMs = opts.breakAt !== undefined ? ist(opts.breakAt) : null;
  const breakTo = opts.breakTo ?? 8925;
  if (breakMs !== null) {
    underlyingBars = underlyingBars.map((b) => (b.ts >= breakMs
      ? { ts: b.ts, open: breakTo, high: r2(breakTo + UNDERLYING_WICK), low: r2(breakTo - UNDERLYING_WICK), close: breakTo }
      : b));
  }
  const closeAt = (bars: MinuteBar[], ms: number) => {
    const minute = Math.floor(ms / MIN) * MIN;
    return bars.find((b) => b.ts === minute)!.close;
  };

  const verdicts: FixtureVerdict[] = [];
  for (const [hhmm, verdict, id] of VERDICTS) {
    const at = ist(hhmm);
    if (breakMs !== null && at > breakMs) continue;
    verdicts.push({
      id: id ?? `v-${hhmm.replace(':', '')}`, verdict, createdAt: isoAt(at),
      packet: packetAt(at, closeAt(contractBars, at), closeAt(underlyingBars, at), contractBars),
      promptVersion: 'v5/t1', reason: `synthetic ${verdict} at ${hhmm} IST`,
    });
  }
  if (breakMs !== null) {
    verdicts.push({
      id: 'v-break', verdict: 'EXIT_NOW', createdAt: isoAt(breakMs),
      packet: packetAt(breakMs, closeAt(contractBars, breakMs), breakTo, contractBars),
      promptVersion: 'v5/t1', reason: `synthetic EXIT_NOW: underlying ${breakTo} broke the invalidation 8932`,
    });
  }

  return {
    v: 1,
    name: breakMs !== null ? `synthetic CRUDEOIL 2026-10-14 (break ${opts.breakAt} → ${breakTo})` : 'synthetic CRUDEOIL 2026-10-14',
    meta: {
      symbol: 'CRUDEOIL17NOV269000CE', exchange: 'MCX', token: '582930', underlyingExchange: 'MCX', underlyingToken: null,
      side: 'LONG', qty: QTY, entryPrice: ENTRY, entryAt: isoAt(ist('15:39')), segment: 'OPT',
      productType: 'CARRYFORWARD', maxLossPerTrade: 2000,
      actualExit: { verdictId: 'v-1631', price: 527.1, at: isoAt(ist('16:31')) },
      finalMark: { price: 542, at: isoAt(ist('17:20')) },
      source: 'synthetic', exportedAt: '2026-10-15T00:00:00.000Z',
    },
    verdicts,
    contractBars,
    underlyingBars,
    executions: [{ verdictId: 'v-1631', status: 'FILLED', reason: null, createdAt: isoAt(ist('16:31') + 5_000), fillPrice: 527.1, orderLtp: 527.1 }],
  };
}
