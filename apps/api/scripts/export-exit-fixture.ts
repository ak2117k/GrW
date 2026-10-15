/**
 * Export one tracked trade as an exit-discipline replay fixture (ExitFixtureV1).
 *
 *   npx ts-node apps/api/scripts/export-exit-fixture.ts --tracker <trackerId> --underlying-token <token>
 *       [--underlying-exchange MCX] [--from <ISO>] [--to <ISO>]
 *       [--final-price <n> --final-at <ISO>] --out <file.real.json>
 *
 * READ-ONLY: it only SELECTs (trade_trackers, sentinel_verdicts, ai_exit_executions,
 * ai_exit_outcomes, candles_1m, core_risk_limits) through DATABASE_URL and writes
 * a JSON file. Name the output `*.real.json` and drop it into
 * apps/api/src/modules/exit-discipline/replay/fixtures/ (git-ignored) — the replay
 * spec runs every such file, and scripts/exit-replay.ts tunes against it.
 * psql-only alternative: scripts/sql/export-exit-fixture.sql.
 */
import { writeFileSync } from 'fs';
import { validateFixture, type ExitFixtureV1 } from '../src/modules/exit-discipline/replay/fixture';
import { segmentFor } from '../src/modules/trade-sentinel/charges';

const USAGE = `Usage: npx ts-node apps/api/scripts/export-exit-fixture.ts --tracker <trackerId> --underlying-token <token> [--underlying-exchange MCX]
         [--from <ISO>] [--to <ISO>] [--final-price <n> --final-at <ISO>] --out <file.real.json>`;

/* eslint-disable no-console */
function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === 'help') { out.help = 'true'; continue; }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) throw new Error(`--${key} needs a value`);
    out[key] = val;
    i++;
  }
  return out;
}

const num = (x: unknown): number | null => {
  const n = typeof x === 'bigint' ? Number(x) : typeof x === 'object' && x !== null ? Number(String(x)) : Number(x);
  return x === null || x === undefined || !Number.isFinite(n) ? null : n;
};
const iso = (x: unknown) => (x instanceof Date ? x.toISOString() : String(x));
const date = (raw: string, name: string): Date => {
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) throw new Error(`--${name} is not a timestamp: ${raw}`);
  return d;
};

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  if (a.help) { console.log(USAGE); return 0; }
  if (!a.tracker || !a['underlying-token'] || !a.out) { console.error(USAGE); return 2; }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); return 2; }

  // Loaded here so `--help` works without a generated client or a database.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    type TrackerRow = { id: string; userId: string; symbol: string; exchange: string; token: string; kind: string; entryPrice: number; qty: number; entryTime: Date };
    const [t] = await prisma.$queryRaw<TrackerRow[]>`
      SELECT "id", "userId", "symbol", "exchange", "token", "kind", "entryPrice", "qty", "entryTime"
      FROM "trade_trackers" WHERE "id" = ${a.tracker}`;
    if (!t) { console.error(`tracker ${a.tracker} not found`); return 1; }
    const from = a.from ? date(a.from, 'from') : new Date(t.entryTime);
    const to = a.to ? date(a.to, 'to') : new Date(from.getTime() + 8 * 3_600_000);
    const uex = a['underlying-exchange'] ?? t.exchange;
    const utoken = a['underlying-token'];

    type VerdictRow = { id: string; verdict: string; createdAt: Date; packet: unknown; promptVersion: string; reason: string };
    const verdicts = await prisma.$queryRaw<VerdictRow[]>`
      SELECT "id", "verdict", "createdAt", "packet", "promptVersion", "reason" FROM "sentinel_verdicts"
      WHERE "trackerId" = ${t.id} AND "createdAt" BETWEEN ${from} AND ${to} AND "promptVersion" !~ '^o[0-9]+/'
      ORDER BY "createdAt" ASC`;
    type ExecRow = { verdictId: string; status: string; reason: string | null; createdAt: Date; fillPrice: number | null; orderLtp: number | null };
    const executions = await prisma.$queryRaw<ExecRow[]>`
      SELECT "verdictId", "status", "reason", "createdAt", "fillPrice", "orderLtp" FROM "ai_exit_executions"
      WHERE "trackerId" = ${t.id} ORDER BY "createdAt" ASC`;
    type OutcomeRow = { verdictId: string; kind: string; missedPnl: number | null; savedPnl: number | null; netAtEnd: number | null };
    const outcomes = await prisma.$queryRaw<OutcomeRow[]>`
      SELECT "verdictId", "kind", "missedPnl", "savedPnl", "netAtEnd" FROM "ai_exit_outcomes"
      WHERE "trackerId" = ${t.id} ORDER BY "decisionAt" ASC`;
    type BarRow = { ts: Date; open: number; high: number; low: number; close: number };
    const bars = (exchange: string, token: string) => prisma.$queryRaw<BarRow[]>`
      SELECT "ts", "open", "high", "low", "close" FROM "candles_1m"
      WHERE "exchange" = ${exchange} AND "token" = ${token} AND "ts" BETWEEN ${from} AND ${to} ORDER BY "ts" ASC`;
    const toBars = (rows: BarRow[]) => rows.map((b) => ({ ts: new Date(b.ts).getTime(), open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close) }));
    const contractBars = toBars(await bars(t.exchange, t.token));
    const underlyingBars = toBars(await bars(uex, utoken));
    const [limit] = await prisma.$queryRaw<Array<{ numValue: unknown }>>`
      SELECT "numValue" FROM "core_risk_limits"
      WHERE "userId" = ${t.userId} AND "key" = 'maxRiskPerTrade' AND "scope" = 'ALL' AND "effectiveFrom" <= ${to}
      ORDER BY "effectiveFrom" DESC, "createdAt" DESC LIMIT 1`;

    const sold = executions.find((e) => e.status === 'FILLED') ?? executions.find((e) => e.status === 'PLACED') ?? null;
    const lastBar = contractBars[contractBars.length - 1];
    const finalMark = a['final-price']
      ? { price: Number(a['final-price']), at: a['final-at'] ?? to.toISOString() }
      : lastBar ? { price: lastBar.close, at: new Date(lastBar.ts).toISOString() } : { price: t.entryPrice, at: to.toISOString() };

    const fx: ExitFixtureV1 = validateFixture({
      v: 1,
      name: `export ${t.symbol} ${t.id} ${from.toISOString().slice(0, 10)}`,
      meta: {
        symbol: t.symbol, exchange: t.exchange, token: t.token, underlyingExchange: uex, underlyingToken: utoken,
        side: t.qty < 0 ? 'SHORT' : 'LONG', qty: Math.abs(t.qty), entryPrice: t.entryPrice, entryAt: iso(t.entryTime),
        segment: segmentFor({ exchange: t.exchange, symbol: t.symbol, kind: t.kind }),
        productType: null, maxLossPerTrade: num(limit?.numValue),
        actualExit: sold ? { verdictId: sold.verdictId, price: sold.fillPrice ?? sold.orderLtp ?? 0, at: iso(sold.createdAt) } : null,
        finalMark, source: 'prod-export', exportedAt: new Date().toISOString(),
      },
      verdicts: verdicts.map((v) => ({ ...v, createdAt: iso(v.createdAt) })),
      contractBars, underlyingBars,
      executions: executions.map((e) => ({ ...e, createdAt: iso(e.createdAt), fillPrice: num(e.fillPrice), orderLtp: num(e.orderLtp) })),
      outcomes: outcomes.map((o) => ({ ...o, missedPnl: num(o.missedPnl), savedPnl: num(o.savedPnl), netAtEnd: num(o.netAtEnd) })),
    });
    writeFileSync(a.out, JSON.stringify(fx, null, 2));
    console.log(`wrote ${a.out}: verdicts=${fx.verdicts.length} contractBars=${fx.contractBars.length} underlyingBars=${fx.underlyingBars.length} executions=${fx.executions.length} outcomes=${fx.outcomes?.length ?? 0}`);
    if (fx.contractBars.length === 0) {
      console.warn('WARNING: no contract bars — N will be unknown in the replay; the floor falls back to fixed; the thesis gate still runs.');
    }
    if (sold && sold.fillPrice === null) console.warn('WARNING: the executed exit has no fillPrice — actualExit.price is the order LTP (or 0); fix it by hand if needed.');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
