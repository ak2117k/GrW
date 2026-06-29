// One-shot historical candle backfill from Angel One SmartAPI.
//
// Fetches 10+ years of OHLC for NIFTY and BANKNIFTY across daily/hourly/
// 15m/5m timeframes and writes them to the local Postgres `candles` table.
// After this runs, the backtest engine's tier-1 local DB path will serve
// every request instead of falling through to live Angel One per-run.
//
// Angel One per-request limits (as documented in SmartAPI docs):
//   ONE_DAY        → up to ~2000 trading days per call (~5.5 years)
//   ONE_HOUR       → up to ~400 trading days per call (~1.5 years)
//   FIFTEEN_MINUTE → up to ~30 calendar days per call
//   FIVE_MINUTE    → up to ~30 calendar days per call
//   ONE_MINUTE     → retention typically <2 years; skipped for a 10y run
//
// Rate limit: Angel One historical API is documented at 1 req/sec. This
// script sleeps 1200 ms between chunks to stay comfortably under.
//
// Idempotent: re-running is safe. `candles` has a unique constraint on
// (instrumentId, timeframe, timestamp), and we use createMany with
// skipDuplicates so previously-fetched bars aren't touched.
//
// Usage:
//   node scripts/backfill-candles.mjs
//   TIMEFRAMES=1d,1h node scripts/backfill-candles.mjs   # subset
//   YEARS_BACK=5 node scripts/backfill-candles.mjs       # shorter range

import 'dotenv/config';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SmartAPI } from 'smartapi-javascript';

/**
 * RFC 6238 TOTP from a base32 secret. Lifted from apps/api's angel-one-auth
 * service so this script doesn't need otplib (which has API breakage across
 * versions in this workspace).
 */
function generateTOTP(base32Secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32Secret.toUpperCase().replace(/=+$/g, '')) {
    const v = alphabet.indexOf(c);
    if (v === -1) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);

  const time = Math.floor(Date.now() / 1000 / 30);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(Math.floor(time / 0x100000000), 0);
  timeBuffer.writeUInt32BE(time & 0xffffffff, 4);

  const hmac = crypto.createHmac('sha1', key).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    1_000_000;
  return code.toString().padStart(6, '0');
}

const YEARS_BACK = Number(process.env.YEARS_BACK ?? 10);
const RATE_LIMIT_MS = 1200;

const SYMBOLS = [
  { symbol: 'NIFTY',     token: '99926000', exchange: 'NSE', name: 'Nifty 50' },
  { symbol: 'BANKNIFTY', token: '99926009', exchange: 'NSE', name: 'Nifty Bank' },
];

/**
 * chunkDays is how many calendar days we ask Angel One for per request.
 * Keeping these conservative (well inside documented limits) so a change
 * in Angel One's per-call caps doesn't silently start returning zero rows.
 */
const TIMEFRAMES = [
  { name: '1d',  interval: 'ONE_DAY',        chunkDays: 1500 },
  { name: '1h',  interval: 'ONE_HOUR',       chunkDays: 300  },
  { name: '15m', interval: 'FIFTEEN_MINUTE', chunkDays: 25   },
  { name: '5m',  interval: 'FIVE_MINUTE',    chunkDays: 25   },
];

const FILTER_TIMEFRAMES = process.env.TIMEFRAMES
  ? new Set(process.env.TIMEFRAMES.split(',').map((s) => s.trim()))
  : null;

const prisma = new PrismaClient();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Angel One SmartAPI requires a TOTP (computed from the shared secret) as
 * the third factor on every session. We generate it fresh at login.
 */
async function login() {
  const {
    ANGEL_ONE_API_KEY,
    ANGEL_ONE_CLIENT_ID,
    ANGEL_ONE_PASSWORD,
    ANGEL_ONE_TOTP_SECRET,
  } = process.env;

  if (!ANGEL_ONE_API_KEY || !ANGEL_ONE_CLIENT_ID || !ANGEL_ONE_PASSWORD || !ANGEL_ONE_TOTP_SECRET) {
    throw new Error('Angel One credentials missing from .env — need ANGEL_ONE_{API_KEY,CLIENT_ID,PASSWORD,TOTP_SECRET}');
  }

  const smartApi = new SmartAPI({ api_key: ANGEL_ONE_API_KEY });
  const totp = generateTOTP(ANGEL_ONE_TOTP_SECRET);

  console.log(`[auth] generating session for client ${ANGEL_ONE_CLIENT_ID}...`);
  const session = await smartApi.generateSession(
    ANGEL_ONE_CLIENT_ID,
    ANGEL_ONE_PASSWORD,
    totp,
  );
  if (!session?.data?.jwtToken) {
    throw new Error(`Login failed: ${JSON.stringify(session)}`);
  }
  console.log('[auth] session established');
  return smartApi;
}

/**
 * Upsert the index instrument so the Candle FK has a valid row to point at.
 * Uses the compound unique (symbol, exchange, token) from the schema.
 */
async function upsertInstrument(sym) {
  return prisma.instrument.upsert({
    where: {
      symbol_exchange_token: {
        symbol: sym.symbol,
        exchange: sym.exchange,
        token: sym.token,
      },
    },
    create: {
      symbol: sym.symbol,
      name: sym.name,
      token: sym.token,
      exchange: sym.exchange,
      segment: 'INDEX',
      lotSize: 1,
      tickSize: 0.05,
      isActive: true,
    },
    update: { isActive: true },
  });
}

/**
 * Angel One expects date-time strings like "2024-01-15 09:15" (IST).
 * Returns the interpreted-as-IST representation of a JS Date, because
 * their API doesn't accept offsets — it assumes IST regardless.
 */
function formatAngelDateTime(d) {
  // Convert UTC → IST by adding 5:30, then format.
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const Y = ist.getUTCFullYear();
  const M = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const D = String(ist.getUTCDate()).padStart(2, '0');
  const h = String(ist.getUTCHours()).padStart(2, '0');
  const m = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}`;
}

async function fetchChunk(smartApi, token, exchange, interval, from, to) {
  try {
    const res = await smartApi.getCandleData({
      exchange,
      symboltoken: token,
      interval,
      fromdate: formatAngelDateTime(from),
      todate: formatAngelDateTime(to),
    });
    if (!res || !res.data || !Array.isArray(res.data)) return [];
    // SmartAPI returns candles as [timestamp, open, high, low, close, volume]
    return res.data.map((row) => ({
      timestamp: new Date(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: BigInt(Math.trunc(Number(row[5]) || 0)),
    }));
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.warn(`  [fetch-error] ${msg}`);
    return [];
  }
}

async function insertCandles(instrumentId, timeframe, candles) {
  if (candles.length === 0) return 0;
  const res = await prisma.candle.createMany({
    data: candles.map((c) => ({
      instrumentId,
      timeframe,
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

async function backfillSymbolTimeframe(smartApi, instrument, sym, tf) {
  const endAll = new Date();
  const startAll = new Date(endAll);
  startAll.setFullYear(startAll.getFullYear() - YEARS_BACK);

  console.log(`\n[${sym.symbol}/${tf.name}] backfilling ${iso(startAll)} → ${iso(endAll)}`);

  let chunkEnd = new Date(endAll);
  let totalFetched = 0;
  let totalInserted = 0;
  let emptyStreak = 0;
  const EMPTY_STREAK_LIMIT = 3;

  while (chunkEnd > startAll) {
    const chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() - tf.chunkDays);
    const effStart = chunkStart < startAll ? startAll : chunkStart;

    const candles = await fetchChunk(smartApi, sym.token, sym.exchange, tf.interval, effStart, chunkEnd);

    if (candles.length === 0) {
      emptyStreak += 1;
      console.log(`  ${iso(effStart)}..${iso(chunkEnd)}  empty  (streak ${emptyStreak})`);
      if (emptyStreak >= EMPTY_STREAK_LIMIT) {
        console.log(`  [${sym.symbol}/${tf.name}] ${EMPTY_STREAK_LIMIT} empty chunks in a row — Angel One retention cutoff reached, stopping`);
        break;
      }
    } else {
      emptyStreak = 0;
      const inserted = await insertCandles(instrument.id, tf.name, candles);
      totalFetched += candles.length;
      totalInserted += inserted;
      console.log(`  ${iso(effStart)}..${iso(chunkEnd)}  fetched=${candles.length} inserted=${inserted}`);
    }

    chunkEnd = new Date(effStart);
    // Stop when we've moved past the start boundary.
    if (effStart <= startAll) break;
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`[${sym.symbol}/${tf.name}] done  total_fetched=${totalFetched}  total_inserted=${totalInserted}`);
  return { totalFetched, totalInserted };
}

async function main() {
  const startedAt = Date.now();
  console.log(`=== Angel One candle backfill — ${YEARS_BACK} years ===`);

  const smartApi = await login();

  let grandTotal = 0;
  for (const sym of SYMBOLS) {
    console.log(`\n>>> ${sym.symbol} (token ${sym.token}, ${sym.exchange})`);
    const instrument = await upsertInstrument(sym);
    console.log(`    instrument row id=${instrument.id}`);

    for (const tf of TIMEFRAMES) {
      if (FILTER_TIMEFRAMES && !FILTER_TIMEFRAMES.has(tf.name)) {
        console.log(`    [${tf.name}] skipped (not in TIMEFRAMES filter)`);
        continue;
      }
      const { totalInserted } = await backfillSymbolTimeframe(smartApi, instrument, sym, tf);
      grandTotal += totalInserted;
      await sleep(RATE_LIMIT_MS);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== Backfill complete: ${grandTotal} new rows in ${elapsed}s ===`);

  // Per-symbol/timeframe summary from the DB.
  const summary = await prisma.$queryRaw`
    SELECT i.symbol, c.timeframe, COUNT(*)::int AS rows,
           MIN(c.timestamp) AS earliest, MAX(c.timestamp) AS latest
    FROM candles c
    JOIN instruments i ON i.id = c."instrumentId"
    WHERE i.symbol IN ('NIFTY', 'BANKNIFTY')
    GROUP BY i.symbol, c.timeframe
    ORDER BY i.symbol, c.timeframe
  `;
  console.log('\nDB coverage:');
  for (const row of summary) {
    console.log(`  ${row.symbol.padEnd(10)} ${row.timeframe.padEnd(5)}  ${row.rows.toString().padStart(7)} rows  ${iso(row.earliest)} → ${iso(row.latest)}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('fatal:', err);
  await prisma.$disconnect();
  process.exit(1);
});
