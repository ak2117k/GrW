/**
 * The judge re-score fixture (scripts/sql/export-judge-rescore.sql) → the FAIR check of one row, with the
 * same code the paper watch runs at the close (signal-trader domain/fair-inputs → domain/fair-score).
 * Shared by scripts/rescore-judge.ts and scripts/replay-learning-kinds.ts. Pure, offline.
 */
import { buildFairPath, fairFromRecords, judgeFacts, kindOf, pathDelta, type JudgeFacts } from '../../src/modules/signal-trader/domain/fair-inputs';
import type { FairCheck } from '../../src/modules/signal-trader/domain/fair-score';

export type Bar = [number, number, number, number, number];
export interface JudgeFixtureRow {
  decisionId: string;
  underlying: string | null;
  createdAt: string;
  judge: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  aiCheck: { correct?: boolean | null; aiDecision?: string; pnl?: number } | null;
  trade: { id: string; side: string; quantity: number; entryPrice: number | null; exitPrice: number | null; entryTime: string | null; exitTime: string | null; status: string; exitTag: string | null; tags?: string[] };
  instrument: { symbol: string; name: string | null; exchange: string; strike: number | null; optionType: string | null; expiry: string | null; lotSize: number; tickSize: number };
  underlyingRef: { exchange: string; token: string | null };
  contractBars: Bar[];
  underlyingBars: Bar[];
  shadowStop: { ts: number; price: number } | null;
  chain: { capturedAt: string; spot: number; fut: number | null; row: { ce?: { delta?: number | null; iv?: number | null } | null; pe?: { delta?: number | null; iv?: number | null } | null } | null } | null;
  looks: Array<[number, number]>;
}

const INDEX = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'MIDCPNIFTY']);
const toBar = (b: Bar) => ({ ts: b[0], open: b[1], high: b[2], low: b[3], close: b[4] });

export function fairOfRow(r: JudgeFixtureRow): { fair: FairCheck; facts: JudgeFacts; kind: string; entryTs: number } {
  const t = r.trade;
  const inst = r.instrument;
  const kind = kindOf(inst.symbol, inst.optionType);
  const entryTs = t.entryTime ? Date.parse(t.entryTime) : NaN;
  const facts = judgeFacts(r.judge, r.plan, inst.lotSize);
  const leg = kind === 'CE' ? r.chain?.row?.ce : kind === 'PE' ? r.chain?.row?.pe : null;
  const other = kind === 'CE' ? r.chain?.row?.pe : kind === 'PE' ? r.chain?.row?.ce : null;
  const delta = pathDelta({
    kind, facts, chainDelta: leg?.delta ?? null, chainOtherLeg: other?.delta ?? null, chainIv: leg?.iv ?? other?.iv ?? null,
    strike: inst.strike, expiry: inst.expiry, at: new Date(entryTs), index: INDEX.has(String(r.underlying ?? inst.name).toUpperCase()), spot: r.chain?.spot ?? null,
  });
  const own = kind === 'EQ' || (kind === 'FUT' && inst.exchange === 'MCX');
  const path = Number.isFinite(entryTs) && t.entryPrice
    ? buildFairPath({
        kind: own ? 'FUT' : kind, entry: t.entryPrice, entryTs, exitTs: t.exitTime ? Date.parse(t.exitTime) : null,
        contractBars: r.contractBars.map(toBar), contractBarsSource: 'candles_1m',
        underlyingBars: own ? [] : r.underlyingBars.map(toBar), underlyingLabel: `${r.underlyingRef.exchange}:${r.underlyingRef.token}`,
        delta, shadowStop: r.shadowStop,
      })
    : null;
  const exit = t.exitTime && t.exitPrice !== null ? { ts: Date.parse(t.exitTime), price: t.exitPrice } : null;
  const fair = fairFromRecords({ judge: r.judge, plan: r.plan, side: t.side, entry: t.entryPrice, entryTs, exit, fallbackLotQty: inst.lotSize, path });
  return { fair, facts, kind, entryTs };
}
