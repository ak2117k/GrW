/**
 * Deterministic stand-in for prod 2026-10-29, the owner's CRUDEOILM17NOV269350PE (2 lots = qty 20,
 * entry 362.55 at 20:10 IST), built only from the incident's numbers: the premium peaked at 380.4,
 * the noise floor armed (~20:54) and trailed to 376.8, and from 21:09 to 21:31 crude futures ground
 * up 9539 → 9603 (about 5 N at N_u ≈ 12.5) while netPnl went +180 → −330 and the premium fell to
 * 352.8 — through 37 verdicts, all HOLD, each "only X points against me since my last HOLD".
 *
 * Assumed where the incident is silent (stated so the replay's verdict can be weighed):
 *  - charges a flat ₹135 (the only value that makes +180 at 21:09 and −330 at 352.8 agree at qty 20);
 *  - the peak at 21:00 with crude at 9531 (a long put's best point is the underlying's low), and the
 *    premium moving ~0.4 per underlying point in the grind (25.5 over 64 points);
 *  - N_c = 1.8 (the trail: 380.4 − 2 × 1.8 = 376.8). Pure: no clock.
 */
import type { MinuteBar } from '../types';
import type { ExitFixtureV1, FixtureVerdict } from './fixture';

const DAY_UTC = Date.UTC(2026, 9, 29); // 2026-10-29
const IST_MS = 330 * 60_000;
const MIN = 60_000;
export const PE_ENTRY = 362.55;
export const PE_QTY = 20;
export const PE_CHARGES = 135;
export const PE_N_CONTRACT = 1.8;
export const PE_N_UNDERLYING = 12.5;
const ARM_N = 1.5;
const TRAIL_N = 2;
const SYMBOL = 'CRUDEOILM17NOV269350PE';

/** 'HH:mm' or 'HH:mm:ss' IST on 2026-10-29 → ms epoch. */
export function istPe(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm);
  if (!m) throw new Error(`synthetic-crude-pe: bad IST time ${hhmm}`);
  return DAY_UTC + (Number(m[1]) * 60 + Number(m[2])) * MIN + Number(m[3] ?? 0) * 1000 - IST_MS;
}
const isoAt = (ms: number) => new Date(ms).toISOString();
const r2 = (x: number) => Math.round(x * 100) / 100;
export const peNet = (ltp: number) => r2((ltp - PE_ENTRY) * PE_QTY - PE_CHARGES);
const BREAKEVEN = PE_ENTRY + PE_CHARGES / PE_QTY; // 369.3

// The floor arms at 20:54 (premium 373 ≥ breakeven 369.3 + 1.5 N_c) and trails to 376.8 at the 21:00 peak.
const CONTRACT_KNOTS: Array<[string, number]> = [
  ['20:10', 362.55], ['20:30', 365], ['20:50', 371], ['20:54', 373], ['21:00', 380.4], ['21:06', 379.2], ['21:09', 378.3], ['21:31', 352.8], ['21:40', 350],
];
const UNDERLYING_KNOTS: Array<[string, number]> = [
  ['20:10', 9572], ['20:30', 9566], ['20:50', 9551], ['20:54', 9547], ['21:00', 9531], ['21:06', 9534], ['21:09', 9539], ['21:31', 9603], ['21:40', 9610],
];

function path(knots: Array<[string, number]>): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  for (let k = 0; k < knots.length - 1; k++) {
    const [t0, v0] = [istPe(knots[k][0]), knots[k][1]];
    const [t1, v1] = [istPe(knots[k + 1][0]), knots[k + 1][1]];
    for (let t = t0; t < t1; t += MIN) out.push({ ts: t, value: r2(v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)) });
  }
  const last = knots[knots.length - 1];
  out.push({ ts: istPe(last[0]), value: last[1] });
  return out;
}

function toBars(p: Array<{ ts: number; value: number }>, wick: number): MinuteBar[] {
  return p.map((x, i) => {
    const open = i === 0 ? x.value : p[i - 1].value;
    return { ts: x.ts, open, high: r2(Math.max(open, x.value) + wick), low: r2(Math.min(open, x.value) - wick), close: x.value };
  });
}

const block = <T>(value: T, at: string) => ({ available: true as const, value, source: 'synthetic', at });

/** The live cycle's noise floor at `atMs` (arms at breakeven + 1.5 N_c, trails the peak by 2 N_c, tighten-only). */
function floorAt(contract: MinuteBar[], atMs: number): { price: number; armed: boolean } {
  let peak = PE_ENTRY;
  let level: number | null = null;
  for (const b of contract) {
    if (b.ts > atMs) break;
    peak = Math.max(peak, b.close);
    if (level === null && peak - BREAKEVEN < ARM_N * PE_N_CONTRACT - 1e-9) continue;
    level = Math.max(level ?? BREAKEVEN, BREAKEVEN, peak - TRAIL_N * PE_N_CONTRACT);
  }
  return level === null ? { price: r2(BREAKEVEN + ARM_N * PE_N_CONTRACT), armed: false } : { price: r2(level), armed: true };
}

function packetAt(atMs: number, ltp: number, underlying: number, contract: MinuteBar[]): Record<string, unknown> {
  const since = contract.filter((b) => b.ts <= atMs).map((b) => b.close);
  const nowUtc = isoAt(atMs - 5_000);
  const f = floorAt(contract, atMs);
  const gross = r2((ltp - PE_ENTRY) * PE_QTY);
  return {
    position: {
      symbol: SYMBOL, exchange: 'MCX', side: 'LONG', qty: PE_QTY, entryPrice: PE_ENTRY, ltp, expiry: '2026-11-17',
      underlyingLtp: block(underlying, nowUtc),
    },
    money: {
      grossPnl: gross, charges: PE_CHARGES, netPnl: r2(gross - PE_CHARGES), greenFloorPrice: f.price, greenFloorArmed: f.armed,
      floorBasis: 'noise', mfe: Math.max(PE_ENTRY, ...since), mae: Math.min(PE_ENTRY, ...since),
    },
    thesis: block({ direction: 'SHORT', reason: 'synthetic: long put on a crude pullback', levelPrice: 9560, targetPrice: 9480, invalidation: 9650, source: 'AGENT' }, nowUtc),
    structure: {
      levelBook: block({ vwap: 9590, atr14: 180, interval: '15m' }, nowUtc),
      nearestSupport: block(9500, nowUtc),
      nearestResistance: block(9620, nowUtc),
    },
    flow: {
      volumeRatio: { available: false, reason: 'synthetic' },
      oiWalls: { available: false, reason: 'synthetic' },
      noiseUnit: block({
        contract: { n: PE_N_CONTRACT, method: 'atr14-1m', bars: 60, at: nowUtc },
        underlying: { n: PE_N_UNDERLYING, method: 'atr14-1m', bars: 60, at: nowUtc },
      }, nowUtc),
    },
    session: { nowUtc, minutesToClose: block(Math.round((istPe('23:30') - atMs) / MIN), nowUtc) },
  };
}

/** HOLD every 3 min to 21:08, then the incident's 37 HOLDs evenly over 21:09–21:31. */
function verdictTimes(): number[] {
  const out: number[] = [];
  for (let t = istPe('20:11'); t < istPe('21:09'); t += 3 * MIN) out.push(t);
  const a = istPe('21:09');
  const b = istPe('21:31');
  for (let i = 0; i < 37; i++) out.push(Math.round(a + ((b - a) * i) / 36));
  return out;
}

export function buildSyntheticCrudePeFixture(): ExitFixtureV1 {
  const contractBars = toBars(path(CONTRACT_KNOTS), 0.6);
  const underlyingBars = toBars(path(UNDERLYING_KNOTS), 4);
  const closeAt = (bars: MinuteBar[], ms: number) => bars.find((x) => x.ts === Math.floor(ms / MIN) * MIN)!.close;
  const verdicts: FixtureVerdict[] = [];
  let prevU: number | null = null;
  for (const at of verdictTimes()) {
    const u = closeAt(underlyingBars, at);
    const since = prevU === null ? 0 : r2(u - prevU);
    verdicts.push({
      id: `v-${new Date(at + IST_MS).toISOString().slice(11, 19).replace(/:/g, '')}`, verdict: 'HOLD', createdAt: isoAt(at),
      packet: packetAt(at, closeAt(contractBars, at), u, contractBars),
      promptVersion: 'v9+l1+d1+e1+s1/t1',
      reason: `synthetic HOLD: only ${Math.max(0, since)} points against me since my last HOLD — under one underlying N`,
    });
    prevU = u;
  }
  return {
    v: 1,
    name: 'synthetic CRUDEOILM17NOV269350PE 2026-10-29',
    meta: {
      symbol: SYMBOL, exchange: 'MCX', token: '000000', underlyingExchange: 'MCX', underlyingToken: null,
      side: 'LONG', qty: PE_QTY, entryPrice: PE_ENTRY, entryAt: isoAt(istPe('20:10')), segment: 'OPT',
      productType: 'CARRYFORWARD', maxLossPerTrade: null,
      actualExit: null,
      finalMark: { price: 352.8, at: isoAt(istPe('21:31')) },
      source: 'synthetic', exportedAt: '2026-10-30T00:00:00.000Z',
    },
    verdicts,
    contractBars,
    underlyingBars,
    executions: [],
  };
}
