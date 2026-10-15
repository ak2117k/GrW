/**
 * Exit discipline replay fixture (plan Task 17). One trade's live verdicts,
 * 1-minute bars of the contract and its underlying, and what the executor did.
 * Produced by `scripts/export-exit-fixture.ts` / `scripts/sql/export-exit-fixture.sql`
 * (real, git-ignored `*.real.json`) or `buildSyntheticCrudeFixture()` (synthetic).
 */
import type { MinuteBar, PositionSide } from '../types';

export interface FixtureVerdict { id: string; verdict: string; createdAt: string; packet: unknown; promptVersion: string; reason: string }

export type FixtureSegment = 'OPT' | 'FUT' | 'EQ_DELIVERY' | 'EQ_INTRADAY';

export interface ExitFixtureV1 {
  v: 1;
  name: string;
  meta: {
    symbol: string; exchange: string; token: string; underlyingExchange: string | null; underlyingToken: string | null;
    side: PositionSide; qty: number; entryPrice: number; entryAt: string; segment: FixtureSegment;
    productType: string | null; maxLossPerTrade: number | null;
    actualExit: { verdictId: string; price: number; at: string } | null;
    finalMark: { price: number; at: string };
    source: 'prod-export' | 'synthetic'; exportedAt: string;
  };
  /** Oldest first, live verdicts only (overnight-review rows excluded). */
  verdicts: FixtureVerdict[];
  contractBars: MinuteBar[];
  underlyingBars: MinuteBar[];
  executions: Array<{ verdictId: string; status: string; reason: string | null; createdAt: string; fillPrice: number | null; orderLtp: number | null }>;
  outcomes?: Array<{ verdictId: string; kind: string; missedPnl: number | null; savedPnl: number | null; netAtEnd: number | null }>;
}

type Obj = Record<string, unknown>;
const SEGMENTS: readonly string[] = ['OPT', 'FUT', 'EQ_DELIVERY', 'EQ_INTRADAY'];

function fail(path: string, why: string): never {
  throw new Error(`invalid exit fixture: ${path} ${why}`);
}
function obj(x: unknown, path: string): Obj {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail(path, 'must be an object');
  return x as Obj;
}
function arr(x: unknown, path: string): unknown[] {
  if (!Array.isArray(x)) fail(path, 'must be an array');
  return x;
}
function str(x: unknown, path: string): string {
  if (typeof x !== 'string' || x === '') fail(path, 'must be a non-empty string');
  return x;
}
function iso(x: unknown, path: string): string {
  const s = str(x, path);
  if (!Number.isFinite(Date.parse(s))) fail(path, 'must be an ISO timestamp');
  return s;
}
/** Finite number; a numeric string is accepted (psql/Decimal exports). */
function fin(x: unknown, path: string): number {
  const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(path, 'must be a finite number');
  return n;
}
function finOrNull(x: unknown, path: string): number | null {
  return x === null || x === undefined ? null : fin(x, path);
}
function strOrNull(x: unknown, path: string): string | null {
  return x === null || x === undefined ? null : str(x, path);
}

function bars(x: unknown, path: string): MinuteBar[] {
  return arr(x, path).map((b, i) => {
    const o = obj(b, `${path}[${i}]`);
    const p = `${path}[${i}]`;
    return { ts: fin(o.ts, `${p}.ts`), open: fin(o.open, `${p}.open`), high: fin(o.high, `${p}.high`), low: fin(o.low, `${p}.low`), close: fin(o.close, `${p}.close`) };
  });
}

/**
 * Validates and normalises a parsed fixture (bar fields as numbers, missing
 * optionals as null). Throws an Error naming the first bad field.
 */
export function validateFixture(x: unknown): ExitFixtureV1 {
  const f = obj(x, 'fixture');
  if (f.v !== 1) fail('v', `must be 1 (got ${JSON.stringify(f.v)})`);
  const m = obj(f.meta, 'meta');
  const side = m.side;
  if (side !== 'LONG' && side !== 'SHORT') fail('meta.side', 'must be LONG or SHORT');
  const qty = fin(m.qty, 'meta.qty');
  if (qty <= 0) fail('meta.qty', 'must be > 0 (units; meta.side carries the direction)');
  if (!SEGMENTS.includes(m.segment as string)) fail('meta.segment', `must be one of ${SEGMENTS.join('|')}`);
  if (m.source !== 'prod-export' && m.source !== 'synthetic') fail('meta.source', 'must be prod-export or synthetic');
  const ae = m.actualExit === null || m.actualExit === undefined ? null : obj(m.actualExit, 'meta.actualExit');
  const fm = obj(m.finalMark, 'meta.finalMark');

  const out: ExitFixtureV1 = {
    v: 1,
    name: str(f.name, 'name'),
    meta: {
      symbol: str(m.symbol, 'meta.symbol'), exchange: str(m.exchange, 'meta.exchange'), token: str(m.token, 'meta.token'),
      underlyingExchange: strOrNull(m.underlyingExchange, 'meta.underlyingExchange'),
      underlyingToken: strOrNull(m.underlyingToken, 'meta.underlyingToken'),
      side, qty, entryPrice: fin(m.entryPrice, 'meta.entryPrice'), entryAt: iso(m.entryAt, 'meta.entryAt'),
      segment: m.segment as FixtureSegment,
      productType: strOrNull(m.productType, 'meta.productType'),
      maxLossPerTrade: finOrNull(m.maxLossPerTrade, 'meta.maxLossPerTrade'),
      actualExit: ae
        ? { verdictId: str(ae.verdictId, 'meta.actualExit.verdictId'), price: fin(ae.price, 'meta.actualExit.price'), at: iso(ae.at, 'meta.actualExit.at') }
        : null,
      finalMark: { price: fin(fm.price, 'meta.finalMark.price'), at: iso(fm.at, 'meta.finalMark.at') },
      source: m.source, exportedAt: iso(m.exportedAt, 'meta.exportedAt'),
    },
    verdicts: arr(f.verdicts, 'verdicts').map((v, i) => {
      const o = obj(v, `verdicts[${i}]`);
      return {
        id: str(o.id, `verdicts[${i}].id`), verdict: str(o.verdict, `verdicts[${i}].verdict`),
        createdAt: iso(o.createdAt, `verdicts[${i}].createdAt`), packet: o.packet ?? null,
        promptVersion: typeof o.promptVersion === 'string' ? o.promptVersion : '',
        reason: typeof o.reason === 'string' ? o.reason : '',
      };
    }),
    contractBars: bars(f.contractBars, 'contractBars'),
    underlyingBars: bars(f.underlyingBars, 'underlyingBars'),
    executions: arr(f.executions, 'executions').map((e, i) => {
      const o = obj(e, `executions[${i}]`);
      return {
        verdictId: str(o.verdictId, `executions[${i}].verdictId`), status: str(o.status, `executions[${i}].status`),
        reason: typeof o.reason === 'string' ? o.reason : null, createdAt: iso(o.createdAt, `executions[${i}].createdAt`),
        fillPrice: finOrNull(o.fillPrice, `executions[${i}].fillPrice`), orderLtp: finOrNull(o.orderLtp, `executions[${i}].orderLtp`),
      };
    }),
  };
  for (let i = 1; i < out.verdicts.length; i++) {
    if (Date.parse(out.verdicts[i].createdAt) < Date.parse(out.verdicts[i - 1].createdAt)) {
      fail(`verdicts[${i}].createdAt`, 'is older than the verdict before it (verdicts must be oldest first)');
    }
  }
  if (f.outcomes !== undefined && f.outcomes !== null) {
    out.outcomes = arr(f.outcomes, 'outcomes').map((r, i) => {
      const o = obj(r, `outcomes[${i}]`);
      return {
        verdictId: str(o.verdictId, `outcomes[${i}].verdictId`), kind: str(o.kind, `outcomes[${i}].kind`),
        missedPnl: finOrNull(o.missedPnl, `outcomes[${i}].missedPnl`), savedPnl: finOrNull(o.savedPnl, `outcomes[${i}].savedPnl`),
        netAtEnd: finOrNull(o.netAtEnd, `outcomes[${i}].netAtEnd`),
      };
    });
  }
  return out;
}
