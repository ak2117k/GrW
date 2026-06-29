// End-to-end verification for M5: trade journal context capture.
//
// Replaces the manual click-through described in Task 14 of
// docs/superpowers/plans/2026-04-25-m5-trade-journal-context-capture.md.
//
// What it does:
//   1. Pre-flight: confirms DATABASE_URL is reachable and the API responds.
//   2. Applies any pending migrations via `prisma migrate deploy` (idempotent).
//   3. Drives a paper-trade lifecycle through the REST API:
//        - creates a paper trade with entryReason + entryTags
//        - asserts the M5 entry-context columns are populated
//        - closes the trade with a structured exitReasonTag + exitNotes
//        - asserts those exit fields are persisted
//   4. Drives the journal filter API (vixRegime + exitReasonTag).
//   5. Tears down the test trade so reruns are clean.
//   6. Prints PASS/FAIL summary; exits non-zero on any assertion failure.
//
// Usage:
//   node scripts/verify-m5.mjs
//
// Env (all optional — sensible defaults):
//   API_BASE_URL   default http://localhost:3001
//   DATABASE_URL   read from .env / shell
//
// Pre-reqs: postgres + redis up, `npm run dev:api` running.

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

// ---------- ANSI helpers (no chalk dep) ----------
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};
const ok = (msg) => console.log(`${c.green}✓${c.reset} ${msg}`);
const warn = (msg) => console.log(`  ${c.yellow}⚠${c.reset} ${msg}`);
const info = (msg) => console.log(`${c.cyan}▶${c.reset} ${msg}`);
const fail = (msg) => console.log(`${c.red}✗${c.reset} ${msg}`);

const ASSERT_TAG = 'verify-m5-assertion';

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
    this.tag = ASSERT_TAG;
  }
}

function assert(cond, message) {
  if (!cond) throw new AssertionError(message);
}

// ---------- Config ----------
const API_BASE = (process.env.API_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRISMA_SCHEMA = resolve(REPO_ROOT, 'prisma', 'schema.prisma');
// The api workspace is where prisma is installed as a devDependency, so we
// invoke `npx prisma migrate deploy` from there.
const API_DIR = resolve(REPO_ROOT, 'apps', 'api');

// Marker text used in the paper trade so this run can find / clean up its row
// even if multiple runs collided.
const RUN_ID = `m5-verify-${Date.now()}`;
const ENTRY_REASON = `M5 verification run [${RUN_ID}]`;
const EXIT_NOTES = `verified by verify-m5.mjs [${RUN_ID}]`;

// ---------- HTTP helper ----------
async function http(method, path, body) {
  const url = `${API_BASE}${path}`;
  const init = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`network error calling ${method} ${path}: ${err.message}`);
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!res.ok) {
    const dump = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(`HTTP ${res.status} on ${method} ${path}: ${dump}`);
  }
  return payload;
}

// ---------- Prisma ----------
let prisma = null;
async function getPrisma() {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

// ---------- Steps ----------

async function checkDb() {
  let p;
  try {
    p = await getPrisma();
    await p.$queryRawUnsafe('SELECT 1');
  } catch (err) {
    fail('DB unreachable.');
    console.log(`${c.dim}    ${err.message}${c.reset}`);
    console.log(`\n  Start postgres (e.g. \`docker compose up -d postgres\`) and re-run.`);
    process.exit(2);
  }
  ok('DB reachable');
}

async function checkApi() {
  // No dedicated /health route exists — probe a cheap GET that the API
  // exposes unconditionally. /api/trades/risk-status is in trade-engine
  // and returns 200 with a JSON body once the app is up.
  const probes = [
    '/api/trades/risk-status',
    '/api/market-data/status',
    '/api/trades/open',
  ];
  let lastErr = null;
  for (const path of probes) {
    try {
      await http('GET', path);
      ok(`API reachable (${API_BASE})`);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  fail('API unreachable.');
  if (lastErr) console.log(`${c.dim}    ${lastErr.message}${c.reset}`);
  console.log(`\n  Run \`npm run dev:api\` (or set API_BASE_URL) and re-run.`);
  process.exit(2);
}

function applyMigrations() {
  if (process.env.SKIP_MIGRATION === '1') {
    warn('Skipping migration step (SKIP_MIGRATION=1) — relying on column-presence check');
    return;
  }
  info('Applying migrations (npx prisma migrate deploy)…');
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prisma', 'migrate', 'deploy', '--schema', PRISMA_SCHEMA],
    {
      cwd: API_DIR,
      stdio: 'pipe',
      encoding: 'utf8',
      env: process.env,
    },
  );
  if (result.status !== 0) {
    // Migration failure is not fatal — the next step verifies columns directly
    // via information_schema. If columns exist (e.g. applied via direct SQL or
    // a prior deploy), we proceed; if they don't, verifyM5ColumnsPresent fails
    // with a clearer message than the raw prisma drift output.
    warn('prisma migrate deploy returned non-zero — falling back to direct column check');
    if (result.stdout) console.log(c.dim + result.stdout.split('\n').slice(0, 6).join('\n') + c.reset);
    return;
  }
  const out = (result.stdout || '').trim();
  if (/No pending migrations/.test(out)) {
    ok('Migrations already up to date');
  } else {
    ok('Migrations applied');
  }
}

async function verifyM5ColumnsPresent() {
  const p = await getPrisma();
  // Use information_schema rather than depending on the generated client
  // having M5 fields — generated client may lag the DB right after a deploy.
  const rows = await p.$queryRawUnsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'trades'
      AND column_name IN (
        'entryReason','entryTags','spotAtEntry','vixAtEntry',
        'vixRegimeAtEntry','pcrAtEntry','maxPainAtEntry','adRatioAtEntry',
        'contextSnapshot','exitReasonTag','exitNotes'
      )
  `);
  const present = new Set(rows.map((r) => r.column_name));
  const required = [
    'entryReason', 'entryTags', 'vixRegimeAtEntry', 'exitReasonTag', 'exitNotes',
  ];
  const missing = required.filter((col) => !present.has(col));
  assert(
    missing.length === 0,
    `M5 columns missing from trades table: ${missing.join(', ')}. ` +
    `Did the M5 schema migration land yet? (Stream A — see plan Task 1.)`,
  );
  ok(`Migration applied (${present.size} M5 columns present on trades)`);
}

async function pickInstrument() {
  const search = await http('GET', '/api/market-data/instruments?search=NIFTY');
  const list = Array.isArray(search?.instruments) ? search.instruments : [];
  // Prefer index spot / equity over options for a clean liquid pick.
  const liquid = list.find((i) => /^(NSE|BSE)$/.test(i.exchange) && /^NIFTY/.test(i.symbol))
              ?? list[0];
  assert(
    liquid && liquid.symbol && liquid.token && liquid.exchange,
    'instrument search for "NIFTY" returned no usable instruments. ' +
    'Seed the instruments table or change the search symbol in this script.',
  );
  return liquid;
}

async function createPaperTrade(instrument) {
  // NOTE: contract assumption — the existing controller exposes
  // POST /api/trades/execute. The plan brief mentions POST /api/trades but
  // we use the one that is actually wired today; flag for review when
  // Stream A's DTO update lands.
  const body = {
    symbol: instrument.symbol,
    token: instrument.token,
    exchange: instrument.exchange,
    side: 'BUY',
    orderType: 'MARKET',
    quantity: instrument.lotSize && instrument.lotSize > 0 ? instrument.lotSize : 1,
    positionType: 'INTRADAY',
    strategy: 'M5_VERIFY',
    entryReason: ENTRY_REASON,
    entryTags: ['OI_BUILDUP', 'VWAP_RECLAIM'],
  };

  const trade = await http('POST', '/api/trades/execute', body);
  assert(trade && trade.id, 'POST /api/trades/execute did not return a Trade with an id');
  return trade;
}

async function fetchTrade(id) {
  return http('GET', `/api/trades/${id}`);
}

function summarizeContext(t) {
  const parts = [];
  const push = (k, v, fmt = (x) => x) => {
    if (v == null) parts.push(`${k}=${c.dim}null${c.reset}`);
    else parts.push(`${k}=${fmt(v)}`);
  };
  push('spot', t.spotAtEntry, (n) => Number(n).toFixed(2));
  push('vix', t.vixAtEntry, (n) => Number(n).toFixed(2));
  push('regime', t.vixRegimeAtEntry ?? null);
  push('pcr', t.pcrAtEntry, (n) => Number(n).toFixed(2));
  push('maxPain', t.maxPainAtEntry);
  push('adRatio', t.adRatioAtEntry, (n) => Number(n).toFixed(2));
  return parts.join(' ');
}

function assertEntryContext(t) {
  assert(t.entryReason === ENTRY_REASON,
    `entryReason mismatch: expected ${JSON.stringify(ENTRY_REASON)}, got ${JSON.stringify(t.entryReason)}`);

  const tags = Array.isArray(t.entryTags) ? t.entryTags : [];
  assert(
    tags.includes('OI_BUILDUP') && tags.includes('VWAP_RECLAIM'),
    `entryTags missing one of OI_BUILDUP/VWAP_RECLAIM. Got: ${JSON.stringify(tags)}`,
  );

  const ctxFields = {
    spotAtEntry: t.spotAtEntry,
    vixAtEntry: t.vixAtEntry,
    pcrAtEntry: t.pcrAtEntry,
    adRatioAtEntry: t.adRatioAtEntry,
  };
  const populated = Object.entries(ctxFields).filter(([, v]) => v != null);
  assert(
    populated.length >= 1,
    `expected at least ONE of {spotAtEntry, vixAtEntry, pcrAtEntry, adRatioAtEntry} to be non-null, ` +
    `but all were null. Snapshot: ${JSON.stringify(ctxFields)}`,
  );

  const allowedRegimes = new Set(['LOW', 'NORMAL', 'ELEVATED', 'HIGH', 'UNKNOWN']);
  assert(
    t.vixRegimeAtEntry == null || allowedRegimes.has(t.vixRegimeAtEntry),
    `vixRegimeAtEntry must be one of LOW|NORMAL|ELEVATED|HIGH|UNKNOWN, got ${JSON.stringify(t.vixRegimeAtEntry)}`,
  );

  ok(`Paper trade created with entryReason + 2 entryTags`);
  ok(`Context captured: ${summarizeContext(t)}`);

  if (t.maxPainAtEntry == null) {
    warn('maxPainAtEntry was null (acceptable: options-chain may not be populated)');
  }
  if (t.vixAtEntry == null) {
    warn('vixAtEntry was null (acceptable: Yahoo Finance may have rate-limited)');
  }
}

async function closeTrade(id) {
  return http('POST', `/api/trades/${id}/close`, {
    exitReasonTag: 'HIT_TARGET',
    exitNotes: EXIT_NOTES,
  });
}

function assertClosedTrade(t) {
  assert(
    t.status === 'CLOSED',
    `expected status === 'CLOSED' after close, got ${JSON.stringify(t.status)}`,
  );
  assert(
    t.exitReasonTag === 'HIT_TARGET',
    `expected exitReasonTag === 'HIT_TARGET', got ${JSON.stringify(t.exitReasonTag)}`,
  );
  assert(
    t.exitNotes === EXIT_NOTES,
    `exitNotes mismatch: expected ${JSON.stringify(EXIT_NOTES)}, got ${JSON.stringify(t.exitNotes)}`,
  );
  ok('Trade closed with structured exit reason');
}

async function checkRegimeFilter(tradeId, regime) {
  if (!regime || regime === 'UNKNOWN') {
    // Filter on UNKNOWN may be valid but skip when null — note instead.
    warn(`Skipping vixRegime filter assertion (regime was ${regime ?? 'null'})`);
    return;
  }
  const res = await http('GET', `/api/trades?vixRegime=${encodeURIComponent(regime)}&limit=200`);
  const trades = extractTrades(res);
  assert(
    trades.some((t) => t.id === tradeId),
    `vixRegime=${regime} filter did not return our test trade (${tradeId}). ` +
    `Got ${trades.length} trades back.`,
  );
  ok(`vixRegime filter (${regime}) returned the trade`);
}

async function checkExitReasonFilter(tradeId) {
  const res = await http('GET', `/api/trades?exitReasonTag=HIT_TARGET&limit=200`);
  const trades = extractTrades(res);
  assert(
    trades.some((t) => t.id === tradeId),
    `exitReasonTag=HIT_TARGET filter did not return our test trade (${tradeId}). ` +
    `Got ${trades.length} trades back.`,
  );
  ok('exitReasonTag filter returned the trade');
}

function extractTrades(res) {
  // The list endpoint returns { trades, total } per TradeRepository.getTradeHistory.
  // Tolerate plain array shape too.
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.trades)) return res.trades;
  if (res && Array.isArray(res.data)) return res.data;
  return [];
}

async function cleanup(tradeId) {
  const p = await getPrisma();
  // Delete by id; ignore "not found" — the trade may already be gone.
  try {
    await p.trade.delete({ where: { id: tradeId } });
    ok('Cleanup complete');
  } catch (err) {
    // Fall back to raw delete in case the generated client is stale and
    // missing M5 fields it tries to validate on read-back.
    try {
      await p.$executeRawUnsafe(
        `DELETE FROM trades WHERE id = $1`,
        tradeId,
      );
      ok('Cleanup complete (raw)');
    } catch (err2) {
      warn(`Cleanup failed (manual delete needed for trade ${tradeId}): ${err2.message}`);
    }
  }
}

// ---------- Main ----------
async function main() {
  console.log(`${c.bold}M5 Verification${c.reset}`);
  console.log('===============');

  await checkDb();
  await checkApi();
  applyMigrations();
  await verifyM5ColumnsPresent();

  const instrument = await pickInstrument();
  info(`Using instrument: ${instrument.symbol} (${instrument.exchange}, token ${instrument.token})`);

  const created = await createPaperTrade(instrument);
  // Re-read to be sure we see the persisted shape (createTrade may return
  // a partial response shape pre-persistence).
  const entry = await fetchTrade(created.id);
  assertEntryContext(entry);

  await closeTrade(entry.id);
  const closed = await fetchTrade(entry.id);
  assertClosedTrade(closed);

  await checkRegimeFilter(closed.id, closed.vixRegimeAtEntry);
  await checkExitReasonFilter(closed.id);

  await cleanup(closed.id);

  console.log('');
  console.log(`${c.bold}${c.green}M5 IS WORKING.${c.reset}`);
}

main()
  .catch(async (err) => {
    console.log('');
    if (err && err.tag === ASSERT_TAG) {
      fail(`ASSERTION FAILED: ${err.message}`);
    } else {
      fail(`UNEXPECTED ERROR: ${err?.message ?? err}`);
      if (err?.stack) console.log(c.dim + err.stack + c.reset);
    }
    console.log('');
    console.log(`${c.bold}${c.red}M5 VERIFICATION FAILED.${c.reset}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (prisma) {
      try { await prisma.$disconnect(); } catch { /* ignore */ }
    }
  });
