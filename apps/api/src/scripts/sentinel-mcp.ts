/**
 * MCP server exposing this platform's market data as TOOLS an agent can call.
 *
 * WHY THIS EXISTS. The sentinel's first design handed the model a PRE-BUILT
 * packet: we chose the fields, assembled them, and asked for a verdict. On a
 * real position that failed in the worst way — fourteen of seventeen evidence
 * blocks came back absent because one lookup (option token → underlying name)
 * returned null, and the agent, seeing nothing alarming, said HOLD on a trade
 * that was bleeding. It had no way to go and look.
 *
 * A tool-using agent does not have that failure mode. When `HAL25AUG265050CE`
 * resolves to nothing it can SEARCH for `HAL`, find the cash token, and pull the
 * chart itself. The blindness becomes a step it works around rather than a wall
 * it reports back from.
 *
 * These tools are thin wrappers over services that already exist and are already
 * tested. Nothing here computes anything new — the value is that the AGENT, not
 * this file, decides what to look at and when to stop.
 *
 * READ-ONLY BY CONSTRUCTION. Every tool below is a query. There is no order
 * placement, no position mutation, no writes of any kind — the same Stage-0
 * property the packet pipeline has, held here by the same means: the capability
 * is simply not present.
 *
 * Usage:
 *   DATABASE_URL='…' BOOT_JOBS=false node apps/api/dist/scripts/sentinel-mcp.js
 * It speaks MCP over stdio, so it is normally spawned by the agent rather than
 * run by hand.
 */
import { NestFactory } from '@nestjs/core';
import { wakeDatabase } from '../common/utils/wake-database';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AppModule } from '../app.module';
import { MarketDataRepository } from '../modules/market-data/repositories/market-data.repository';
import { UserFeedManager } from '../modules/market-data/services/user-feed-manager.service';
import { SrEvidenceService } from '../modules/signal-generator/services/sr-evidence.service';
import { SignalGeneratorService } from '../modules/signal-generator/services/signal-generator.service';
import { OiWallService } from '../modules/signal-generator/services/oi-wall.service';
import { NewsAggregatorService } from '../modules/news/services/news-aggregator.service';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * The tenant every tool reads as. Market data is not tenant-scoped, but the
 * BROKER SESSION that fetches it is: this platform has no shared feed account,
 * so a candle fetch with no user has nothing to authenticate with.
 */
const USER_ID = process.env.SENTINEL_USER_ID ?? '';

/** Wrap a tool result in the MCP content shape, JSON-encoded. */
function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Errors are RETURNED, not thrown.
 *
 * A thrown tool error reaches the agent as a protocol failure it cannot reason
 * about. Returned as text it becomes evidence — "this lookup failed, try
 * another route" — which is precisely the recovery the packet design could not
 * express.
 */
function failed(what: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return ok({ ok: false, error: `${what} failed: ${message}` });
}

/**
 * Run a tool body, retrying once per attempt on a CONNECTION failure only.
 *
 * Serverless Postgres suspends its compute when idle and the first query after
 * a pause fails while it wakes. During one session that produced three separate
 * "bugs" in three different services, all of them this. A retry costs a second;
 * the alternative is the agent being told a lookup is unavailable when it is
 * merely asleep — and this whole server exists because evidence that goes
 * quietly missing is the failure mode that hurt us.
 *
 * ONLY connection errors are retried. A genuine failure — bad token, no chain
 * for that symbol — must reach the agent on the first attempt so it can route
 * around it rather than sit through a pointless backoff.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      const transient = /reach database server|Connection|ECONNRESET|ETIMEDOUT|socket/i.test(message);
      if (!transient || i === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500 * i));
    }
  }
  throw last;
}

/** Everything the tools need, resolved once the application context is up. */
interface Services {
  feed: UserFeedManager;
  sr: SrEvidenceService;
  signals: SignalGeneratorService;
  oi: OiWallService;
  news: NewsAggregatorService;
  prisma: PrismaService;
  candleSource?: {
    getCandles: (
      token: string,
      exchange: string,
      interval: string,
      from: Date,
      to: Date,
    ) => Promise<unknown[]>;
  };
}

/**
 * Boot the application context and hand back the services the tools use.
 *
 * DELIBERATELY NOT AWAITED BEFORE THE TRANSPORT CONNECTS — see {@link main}.
 */
async function bootServices(): Promise<Services> {
  await wakeDatabase(5, (m) => process.stderr.write(`${m}\n`));
  // Warn-level only, and NestJS logs to stderr — stdout is the MCP protocol
  // channel and any stray byte on it corrupts the session.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const feed = app.get(UserFeedManager);
  return {
    feed,
    sr: app.get(SrEvidenceService),
    signals: app.get(SignalGeneratorService),
    oi: app.get(OiWallService),
    news: app.get(NewsAggregatorService),
    prisma: app.get(PrismaService),
    // Bound to the configured user's own Angel session: this platform has no
    // shared feed account, so a candle fetch with no user cannot authenticate.
    candleSource: USER_ID
      ? {
          getCandles: (token, exchange, interval, from, to) =>
            feed.fetchCandles(USER_ID, token, exchange, interval, from, to) as Promise<unknown[]>,
        }
      : undefined,
  };
}

async function main(): Promise<void> {
  /**
   * THE HANDSHAKE MUST NOT WAIT FOR THE APPLICATION.
   *
   * Booting Nest and waking a suspended database took 27.3 SECONDS measured
   * warm, and longer cold. MCP clients give a stdio server on the order of 30s
   * to answer `initialize` before giving up — so the server that took 27s was
   * winning that race by three seconds on a good day and losing it on a bad one.
   *
   * When it lost, the agent did not see an error. It simply had no tools, and
   * went off to answer the question with a web search instead. A dependency that
   * fails by SILENTLY VANISHING is far worse than one that fails loudly, and it
   * is the same failure mode — evidence quietly absent — that this whole server
   * was built to remove.
   *
   * So: connect the transport first, boot in the background, and let each TOOL
   * await readiness. The handshake answers in milliseconds; the first tool call
   * pays whatever boot time is left, by which point it is usually zero.
   */
  const ready = bootServices();
  // Without this, a boot failure before the first tool call is an unhandled
  // rejection that kills the process mid-handshake.
  ready.catch((err) => process.stderr.write(`sentinel-mcp boot failed: ${String(err)}\n`));

  const server = new McpServer({ name: 'sentinel-market-data', version: '1.0.0' });

  server.tool(
    'resolve_symbol',
    'Find an instrument by name or partial symbol. USE THIS FIRST for a derivative: an ' +
      'option tradingsymbol like HAL25AUG265050CE is NOT in the instrument table, but its ' +
      'UNDERLYING (HAL, as HAL-EQ on NSE) is. Everything else — levels, candles, news — is ' +
      'keyed by the underlying, so resolve it before asking for structure.',
    { query: z.string().describe('Symbol or partial name, e.g. "HAL" or "RELIANCE"') },
    async ({ query }) => {
      try {
        const { prisma } = await ready;
        const rows = await withRetry(() => prisma.instrument.findMany({
          where: { OR: [{ symbol: { contains: query, mode: 'insensitive' } }, { name: { contains: query, mode: 'insensitive' } }] },
          select: { symbol: true, name: true, token: true, exchange: true },
          take: 15,
        }));
        return ok({ ok: true, count: rows.length, instruments: rows });
      } catch (err) {
        return failed('resolve_symbol', err);
      }
    },
  );

  server.tool(
    'get_quote',
    'Live quote for one instrument token: last price, open/high/low/close, volume. Works for ' +
      'cash, F&O and commodities. Fetched over the user\'s own broker session.',
    { token: z.string(), exchange: z.string().default('NSE') },
    async ({ token, exchange }) => {
      try {
        const { feed } = await ready;
        const q = await withRetry(() => feed.fetchQuote(USER_ID, token, exchange));
        return ok({ ok: true, quote: q });
      } catch (err) {
        return failed('get_quote', err);
      }
    },
  );

  server.tool(
    'get_candles',
    'OHLCV candles for an instrument. Use this to see what price actually DID — the shape of ' +
      'the move, where it stalled, whether a level held. Intervals: 1m, 5m, 15m, 1h, 1d.',
    {
      token: z.string(),
      exchange: z.string().default('NSE'),
      interval: z.string().default('15m'),
      lookbackDays: z.number().default(5),
    },
    async ({ token, exchange, interval, lookbackDays }) => {
      try {
        const to = new Date();
        const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
        const { feed } = await ready;
        const rows = await withRetry(() => feed.fetchCandles(USER_ID, token, exchange, interval, from, to));
        // Tail only: a long series is mostly context the agent will not read, and
        // it crowds out the reasoning budget that produced the verdict.
        const tail = rows.slice(-120);
        return ok({ ok: true, interval, returned: tail.length, of: rows.length, candles: tail });
      } catch (err) {
        return failed('get_candles', err);
      }
    },
  );

  server.tool(
    'get_levels',
    'Scored support/resistance for an instrument — volume nodes, round numbers, prior pivots, ' +
      'VWAP, moving averages, gaps, fibs, and OI walls on intraday timeframes. THIS IS THE ' +
      'STRUCTURE a thesis stands or falls on. Pass the UNDERLYING, never an option tradingsymbol.',
    {
      token: z.string(),
      exchange: z.string().default('NSE'),
      symbol: z.string(),
      interval: z.string().default('15m'),
    },
    async ({ token, exchange, symbol, interval }) => {
      try {
        const { sr, candleSource } = await ready;
        const levels = await withRetry(() => sr.levelsFor(token, exchange, symbol, interval, candleSource as never));
        return ok({ ok: true, interval, count: levels.length, levels });
      } catch (err) {
        return failed('get_levels', err);
      }
    },
  );

  server.tool(
    'get_setup',
    'The level engine\'s full read on an instrument: whether there is an active setup, its ' +
      'direction, entry/stop/target, the level type, higher-timeframe trend, market regime, ' +
      'volume ratio and the context-scoring factors. Pass the UNDERLYING.',
    { token: z.string(), exchange: z.string().default('NSE'), symbol: z.string(), interval: z.string().default('15m') },
    async ({ token, exchange, symbol, interval }) => {
      try {
        const { signals, candleSource } = await ready;
        const result = await withRetry(() => signals.analyze(token, exchange, symbol, interval, candleSource as never));
        return ok({ ok: true, setup: result });
      } catch (err) {
        return failed('get_setup', err);
      }
    },
  );

  server.tool(
    'get_option_chain',
    'Open-interest walls, max pain and OI build-up for an underlying — where the option ' +
      'writers are positioned, i.e. the prices the market is being pinned toward or defended at.',
    { symbol: z.string().describe('UNDERLYING name, e.g. HAL or NIFTY'), spot: z.number() },
    async ({ symbol, spot }) => {
      try {
        const { oi } = await ready;
        const walls = await withRetry(() => oi.wallsExtended(symbol, spot));
        return ok({ ok: true, count: walls.length, walls });
      } catch (err) {
        return failed('get_option_chain', err);
      }
    },
  );

  server.tool(
    'get_news',
    'Recent headlines for an underlying, newest first. Use it to explain a move you can see ' +
      'in the candles but not in the structure.',
    { symbol: z.string(), limit: z.number().default(10) },
    async ({ symbol, limit }) => {
      try {
        const { news } = await ready;
        const all = await withRetry(() => news.getNewsForSymbol(symbol));
        const items = all.slice(0, limit);
        return ok({ ok: true, count: items.length, headlines: items });
      } catch (err) {
        return failed('get_news', err);
      }
    },
  );

  server.tool(
    'get_position',
    'The full tracker row for one open position: entry price and time, quantity, live LTP, ' +
      'running P&L, and the high/low it has traded since entry (its best and worst excursion).',
    { trackerId: z.string() },
    async ({ trackerId }) => {
      try {
        const { prisma } = await ready;
        const row = await withRetry(() => prisma.tradeTracker.findUnique({ where: { id: trackerId } }));
        return ok({ ok: true, position: row });
      } catch (err) {
        return failed('get_position', err);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stderr, never stdout — stdout IS the MCP protocol channel and any stray
  // byte on it corrupts the session.
  process.stderr.write(`sentinel-mcp failed to start: ${String(err)}\n`);
  process.exit(1);
});
