/**
 * GOLDEN CHARACTERISATION FIXTURES for the trade sentinel's LLM seam (SP3 §4.7).
 *
 * WHAT THIS IS. A fixed set of scenarios that drive the REAL `SentinelAgentService`
 * and `ThesisService` (and, separately, the real `ClaudeCliTransport`) and record
 * exactly what crosses the transport boundary and what comes back out:
 *  - the request object handed to `messages.create` (deep copy, one argument only),
 *  - the resolved verdict / thesis, or the thrown error's class, name and message,
 *  - the log lines the sentinel's own loggers emitted,
 *  - for the CLI transport: the spawn command line, spawn options, the child env
 *    contract, stdin, and the system-prompt FILE content.
 *
 * WHY. The sentinel is live in production. Later SP3 tasks move it onto the AI
 * gateway; they must pass these same snapshots unchanged. The baseline was
 * recorded against the pre-gateway code, so a diff here IS a behaviour change.
 *
 * THE ONLY THING THAT VARIES between the baseline run and the gateway run is the
 * client factory handed to `runGoldenScenarios`. Everything else — packets, config,
 * replies, normalisation — lives here and must not be edited to make a later run
 * pass. Non-deterministic values (the temp dir) are normalised HERE, never in the
 * services.
 */
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { APIConnectionError, APIError, RateLimitError } from '@anthropic-ai/sdk';
import { SentinelAgentService, type OvernightVerdict, type Verdict } from '../services/sentinel-agent.service';
import { ThesisService } from '../services/thesis.service';
import {
  absent,
  present,
  type ChartContextShim,
  type ContextPacket,
  type TickSnapshot,
} from '../services/context-packet.service';
import type { MessagesTransport, TransportRequest } from '../services/llm-transport';
import type { WakeTrigger } from '../services/tripwire.service';
import type { RosterEntry } from '../services/roster.service';
import type { ThesisDraft } from '../repositories/sentinel-thesis.repository';
import type { OvernightPacket, OvernightSection } from '../overnight/overnight-packet.types';
import { ClaudeCliTransport, CLI_TIMEOUT_MS, quoteArg } from '../adapters/claude-cli.transport';

// ─────────────────────────────────────────────────────────────────────────────
// Public contract (A6 relies on these exact names)
// ─────────────────────────────────────────────────────────────────────────────

/** One scenario's fake provider: what it was asked, and how it answers. */
export interface Recorder {
  /** Every request the client received, deep-copied, in call order. */
  requests: unknown[];
  /** The scripted reply. May THROW to simulate a transport failure. */
  reply: (req: unknown) => { content: { type: string; text?: string }[]; stop_reason: string | null };
}

/** One scenario's observable behaviour. */
export interface GoldenRecord {
  scenario: string;
  request: unknown;
  result: unknown;
  logs: string[];
}

/** The service-level scenarios `runGoldenScenarios` produces, one record each. */
export const SCENARIO_NAMES = [
  'judge-fire-cues-on',
  'judge-heartbeat-cues-off',
  'judge-env-overrides',
  'judge-fenced-json',
  'judge-refusal',
  'judge-max-tokens',
  'judge-context-exceeded',
  // Exit discipline (Task 12) and the price-trigger prompt switch: every prompt
  // variant other than the baseline (both off) gets its own scenario.
  'judge-fire-cues-on-triggers',
  'judge-heartbeat-cues-off-triggers',
  'judge-fire-cues-on-discipline',
  'judge-heartbeat-cues-off-discipline',
  'judge-fire-cues-on-discipline-triggers',
  'judge-heartbeat-cues-off-discipline-triggers',
  // News & events v2 (Task D3): every news-on prompt variant, plus observe (must equal off).
  'judge-fire-cues-on-news-discipline',
  'judge-heartbeat-cues-off-news-discipline',
  'judge-fire-cues-on-news',
  'judge-heartbeat-cues-off-news',
  'judge-fire-cues-on-news-triggers',
  'judge-heartbeat-cues-off-news-triggers',
  'judge-fire-cues-on-news-discipline-triggers',
  'judge-heartbeat-cues-off-news-discipline-triggers',
  'judge-heartbeat-cues-off-news-observe',
  'overnight',
  'thesis',
  'transport-throws',
  'transport-throws-plain-error',
  'transport-throws-api-error',
  'transport-throws-connection',
  'overnight-transport-throws',
  'thesis-transport-throws',
  'thesis-rate-limited',
] as const;

/**
 * The CLI scenarios `runCliGoldenScenarios` produces: the transport alone over a
 * mocked `spawn`, and (`*-end-to-end`) the real sentinel services driving it.
 */
export const CLI_SCENARIO_NAMES = [
  'cli-argv-and-env',
  'cli-envelope-ok',
  'cli-envelope-fenced',
  'cli-envelope-is-error-401',
  'cli-envelope-empty-result',
  'cli-nonzero-exit',
  'cli-timeout',
  'cli-envelope-unparseable',
  'cli-envelope-is-error-529',
  'cli-spawn-error',
  'cli-output-cap',
  'cli-judge-end-to-end',
  'cli-judge-fenced-end-to-end',
  'cli-judge-refusal-end-to-end',
  'cli-judge-nonzero-exit-end-to-end',
  'cli-overnight-end-to-end',
  'cli-thesis-end-to-end',
  'cli-thesis-nonzero-exit-end-to-end',
] as const;

/**
 * Logger contexts whose lines are part of the sentinel's observable behaviour.
 * Lines from any other context (e.g. a gateway's own audit logging) are not the
 * sentinel's output and are deliberately not compared.
 */
export const SENTINEL_LOG_CONTEXTS: readonly string[] = [
  SentinelAgentService.name,
  ThesisService.name,
  ClaudeCliTransport.name,
];

/**
 * The baseline client: a plain object whose `messages.create` records the request
 * and answers from the recorder. Asserts the single-argument call shape the
 * Anthropic SDK is invoked with.
 */
export function recordingClient(rec: Recorder): MessagesTransport {
  return {
    messages: {
      // `function`, not an arrow, so `arguments` is the real call's arguments.
      create: async function (this: unknown, ...args: unknown[]) {
        if (args.length !== 1) {
          throw new Error(`golden: messages.create called with ${args.length} arguments, expected exactly 1`);
        }
        rec.requests.push(JSON.parse(JSON.stringify(args[0])));
        return rec.reply(args[0]);
      } as MessagesTransport['messages']['create'],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — copied from the existing specs (see the note on each)
// ─────────────────────────────────────────────────────────────────────────────

const AT = '2026-08-14T04:30:00.000Z';

/** Verbatim `base` from services/sentinel-agent.service.spec.ts. */
export const GOLDEN_PACKET: ContextPacket = {
  position: {
    symbol: 'INFY',
    kind: 'POSITION',
    ownership: 'SENTINEL',
    segment: 'EQ_DELIVERY',
    side: 'LONG',
    qty: 100,
    entryPrice: 1400,
    ltp: 1462,
    underlyingLtp: present(1462, 'market-data (underlying spot)', AT),
    entryTime: '2026-08-13T04:15:00.000Z',
    expiry: null,
  },
  money: {
    grossPnl: 6200,
    charges: 120,
    netPnl: 6080,
    greenFloorPrice: 1441,
    greenFloorArmed: true,
    mfe: 1478,
    mae: 1396,
  },
  thesis: present(
    {
      direction: 'LONG',
      reason: 'breakout above the 1400 shelf',
      levelPrice: 1400,
      targetPrice: 1500,
      invalidation: 1380,
      source: 'AGENT',
    },
    'agent inference',
    AT,
  ),
  structure: {
    levelBook: present([{ price: 1450, kind: 'SUPPORT' }], 'chart-context.service (1d)', AT),
    nearestSupport: present(1450, 'level book (underlying scale)', AT),
    nearestResistance: present(1500, 'level book (underlying scale)', AT),
  },
  flow: {
    volumeRatio: present(1.8, 'market-data', AT),
    oiWalls: present(
      { now: { callWall: 1500, putWall: 1400 }, previous: { callWall: 1520, putWall: 1400 } },
      'oi-wall.service',
      AT,
    ),
  },
  macro: {
    fiiDii: absent('stub'),
    sector: absent('stub'),
    globalCues: absent('stub'),
    realFactors: present({ mtfTrend: 0.6 }, 'context-scoring', AT),
  },
  news: {
    headlines: absent('news aggregator returned nothing for this symbol'),
    freshCount: present(0, 'news-aggregator.service', AT),
  },
  session: {
    nowIst: '2026-08-14 10:00:00 IST',
    nowUtc: AT,
    minutesToClose: present(330, 'derived from IST wall clock', AT),
    expiry: null,
  },
  trigger: present([{ name: 'heartbeat', detail: 'scheduled review' }], 'tripwire.service', AT),
  memory: absent('no prior verdicts for this position — this is the first look'),
};

/**
 * {@link GOLDEN_PACKET} as the builder emits it with exit discipline ON: an armed
 * noise floor (money.floorBasis after greenFloorArmed) and flow.noiseUnit.
 */
export const GOLDEN_PACKET_DISCIPLINE: ContextPacket = {
  ...GOLDEN_PACKET,
  money: {
    grossPnl: 6200,
    charges: 120,
    netPnl: 6080,
    greenFloorPrice: 1452.5,
    greenFloorArmed: true,
    floorBasis: 'noise',
    mfe: 1478,
    mae: 1396,
  },
  flow: {
    ...GOLDEN_PACKET.flow,
    noiseUnit: present(
      {
        contract: { n: 4.5, method: 'atr14-1m', bars: 20, at: AT },
        underlying: { n: 4.5, method: 'atr14-1m', bars: 20, at: AT },
      },
      'exit-discipline noise unit (ATR14 of hub 1-minute bars; underlying falls back to the 15m level-book ATR14 / √15)',
      AT,
    ),
  },
};

/**
 * News & events v2 (Task D3): the blocks the builder emits with NEWS_EVENTS_V2_ENABLED=true
 * — layered headlines, the own-instrument fresh count, ingestion health (news.asOf) and
 * the events block. The cast is only because `ContextPacket` gains `news.asOf` and
 * `events` in Task D1.
 */
const NEWS_V2_BLOCKS = {
  news: {
    headlines: present(
      [
        { title: 'Crude jumps 3% as OPEC+ signals deeper cuts', source: 'ET Commodities', sentiment: 'bullish', publishedAt: '2026-10-16T13:40:00.000Z', layer: 'instrument', key: 'CRUDEOIL', ageMin: 20 },
        { title: 'Fed minutes show officials split on December cut', source: 'CNBC World', sentiment: 'neutral', publishedAt: '2026-10-16T11:05:00.000Z', layer: 'market', key: 'GLOBAL', ageMin: 175 },
      ] as never,
      'news-index (own → sector → index → market, published within 6h)',
      '2026-10-16T13:40:00.000Z',
    ),
    freshCount: present(1, 'news-index (own-instrument headlines in the last 30 minutes; inferred publish times excluded)', AT),
    asOf: present(
      { lastIngestAt: '2026-10-16T13:55:00.000Z', downSources: [], stale: false } as never,
      'news ingestion health (last successful fetch of any source; sources failing 6+ times in a row)',
      '2026-10-16T13:55:00.000Z',
    ),
  },
  events: {
    upcoming: present(
      [
        {
          kind: 'eia_petroleum',
          scope: 'commodity',
          title: 'EIA weekly petroleum status report',
          atIst: '2026-10-21 20:00 IST',
          minutesAway: 3420,
          impact: 'high',
          source: 'rule: EIA weekly petroleum status (Wed 10:30 ET)',
        },
      ] as never,
      'market-events (NSE event calendar and corporate actions, Yahoo estimates, config/market-events.json, EIA rules, contract expiry)',
      '2026-10-16T02:45:00.000Z',
    ),
    minutesToNextHighImpact: present(3420, 'market-events (timed high-impact events only)', AT),
  },
};
export const GOLDEN_PACKET_NEWS = { ...GOLDEN_PACKET, news: NEWS_V2_BLOCKS.news, events: NEWS_V2_BLOCKS.events } as ContextPacket;
export const GOLDEN_PACKET_NEWS_DISCIPLINE = {
  ...GOLDEN_PACKET_DISCIPLINE,
  news: NEWS_V2_BLOCKS.news,
  events: NEWS_V2_BLOCKS.events,
} as ContextPacket;

/** `validVerdict` from services/sentinel-agent.service.spec.ts — cites real packet paths. */
const VALID_VERDICT: Verdict = {
  verdict: 'HOLD',
  confidence: 'high',
  thesisStatus: 'INTACT',
  recoveryAvailable: true,
  reason: 'structure holding above the demand zone',
  evidence: ['structure.nearestSupport', 'money.netPnl'],
  invalidationPoint: 'close below 1450',
  reviewIn: 300,
};

const OAT = '2026-10-12T10:15:00.000Z';

/** Verbatim `live` + `overnight` from services/sentinel-agent.overnight.spec.ts. */
const OVERNIGHT_LIVE: ContextPacket = {
  position: {
    symbol: 'NIFTY13OCT2625000CE',
    kind: 'POSITION',
    ownership: 'SENTINEL',
    segment: 'OPT',
    side: 'LONG',
    qty: 75,
    entryPrice: 140,
    ltp: 120,
    underlyingLtp: present(25050, 'market-data (underlying spot — broker FULL-mode quote)', OAT),
    entryTime: '2026-10-12T04:00:00.000Z',
    expiry: '2026-10-13',
  },
  money: { grossPnl: -1500, charges: 90, netPnl: -1590, greenFloorPrice: 142.4, greenFloorArmed: false, mfe: 150, mae: 112 },
  thesis: present(
    { direction: 'LONG', reason: 'bought the 25000 retest', levelPrice: 25000, targetPrice: 25300, invalidation: 24900, source: 'INFERRED' },
    'agent inference',
    OAT,
  ),
  structure: {
    levelBook: present([{ price: 25000, kind: 'SUPPORT' }], 'chart-context.service (15m)', OAT),
    nearestSupport: present(25000, 'level book', OAT),
    nearestResistance: present(25200, 'level book', OAT),
  },
  flow: { volumeRatio: absent('n/a'), oiWalls: absent('no options chain for this symbol, so no OI walls') },
  macro: { fiiDii: absent('stub'), sector: absent('stub'), globalCues: absent('stub'), realFactors: absent('none') },
  news: { headlines: absent('none'), freshCount: absent('none') },
  session: {
    nowIst: '2026-10-12 15:45:00 IST',
    nowUtc: OAT,
    minutesToClose: absent('the NFO session has already closed (15:30 IST) — nothing left to run there today'),
    expiry: '2026-10-13',
  },
  trigger: present([{ name: 'OVERNIGHT_REVIEW', detail: 'scheduled after-close review' }], 'sentinel-overnight.service', OAT),
  memory: absent('no prior verdicts for this position — this is the first look'),
};

const OVERNIGHT_SECTION: OvernightSection = {
  review: {
    kind: 'OVERNIGHT_REVIEW',
    window: 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12',
    lastCloseAt: '2026-10-12T10:00:00.000Z',
    nextOpenAt: '2026-10-13T03:45:00.000Z',
    hoursUntilOpen: 17.5,
    lastPriceAt: '2026-10-12T09:59:30.000Z',
    lastPriceAtBasis: 'as of tracker update',
  },
  expiry: present({ expiry: '2026-10-13', calendarDays: 1, tradingSessionsLeft: 1 }, 'derived', OAT),
  decay: present(
    { thetaPerUnitPerDay: -24, nightDays: 0.7292, perUnitOvernight: -17.5, rupeesForPosition: -1312.5, method: 'options-chain greeks' },
    'options-chain.service greeks',
    OAT,
  ),
  greeks: present({ delta: 0.52, gamma: 0.001, theta: -24, vega: 9.1, iv: 13.2 }, 'options-chain.service greeks', OAT),
  preOpenPrice: absent('after-close review — the next pre-open has not happened'),
  preOpenGap: absent('only the 09:10 pre-open check reads an NSE pre-open IEP'),
  news: present({ items: [], stale: false }, 'news-aggregator.service', OAT),
  oi: present({ pcr: present(0.82, 'options-chain.service getPCR', OAT) }, 'options-chain.service', OAT),
  marketCues: {
    nasdaq: present({ value: 27366.17, change: 172.83, changePercent: 0.64, direction: 'UP', ageMinutes: 1100, basis: 'previous session close', status: 'ok' }, 'Yahoo', OAT),
    sp500: absent('not fetched yet'),
    dow: absent('not fetched yet'),
    nasdaqFutures: present({ value: 31108.75, change: -60, changePercent: -0.19, direction: 'DOWN', ageMinutes: 5, basis: 'quote time', status: 'ok' }, 'Yahoo', OAT),
    sp500Futures: absent('not fetched yet'),
    giftNifty: absent('GIFT Nifty is read in the 23:45 and 08:30 reviews'),
    fiiDerivatives: present({ session: '2026-10-09', indexFutures: { long: 1, short: 2, net: -1 } }, 'NSE participant OI', '2026-10-09'),
    crudeOil: present({ value: 5600, change: -84, changePercent: -1.5, direction: 'DOWN', ageMinutes: 5, basis: 'quote time' }, 'commodities', OAT),
    gold: absent('no quote'),
    fiiFlows: present({ session: '2026-10-09', fii: { buy: 1, sell: 2, net: -1 }, todaysFigure: 'not yet published (NSE publishes ~18:00–20:00 IST)' }, 'NSE fiidiiTradeReact', '2026-10-09'),
    indiaVix: present({ value: 13.4, change: 0.6, changePercent: 4.7, direction: 'UP', ageMinutes: 0, basis: 'previous session close' }, 'market-context.service', OAT),
    sectorStrength: absent('underlying is an index'),
    underlyingChange: absent('no previous close'),
  },
};

const OVERNIGHT_PACKET: OvernightPacket = { ...OVERNIGHT_LIVE, overnight: OVERNIGHT_SECTION };

/** A valid HOLD_OVERNIGHT verdict citing real overnight and live paths. */
const VALID_OVERNIGHT: OvernightVerdict = {
  verdict: 'HOLD_OVERNIGHT',
  confidence: 'medium',
  thesisStatus: 'WEAKENING',
  overnightRisk: 'one session to expiry and ₹1,312 of theta overnight against a long call',
  changeMindLevel: 'an open above 25150 on the spot',
  openPlan: 'if it gaps below 24950, exit; if it opens above 25150, hold with a stop at 25020',
  evidence: ['overnight.decay', 'overnight.expiry', 'structure.nearestSupport'],
};

/** `entry` and `tick` from services/thesis.service.spec.ts. */
const THESIS_ENTRY: RosterEntry = {
  userId: 'u1',
  trackerId: 't1',
  symbol: 'INFY',
  exchange: 'NSE',
  kind: 'POSITION',
  ownership: 'SENTINEL',
  watched: true,
  reason: 'unowned position — sentinel claims it',
};

const THESIS_TICK: TickSnapshot = {
  segment: 'EQ_DELIVERY',
  side: 'LONG',
  structureSymbol: 'INFY',
  entryPrice: 1455,
  qty: 10,
  ltp: 1470,
  underlyingLtp: 1470,
  underlyingLtpAt: null,
  underlyingLtpSource: 'market-data (underlying spot — live feed tick)',
  underlyingLtpReason: null,
  nearestSupport: 1450,
  nearestResistance: 1500,
  structureReason: null,
  structureAt: null,
  structureSource: 'signal-generator.analyze (15m level book)',
  holdingHigh: 1478,
  holdingLow: 1449,
  entryTime: new Date('2026-08-13T04:15:00.000Z'),
  expiry: null,
  volumeRatio: 1.4,
  freshNewsCount: 0,
  factorValues: {},
  factorsReason: null,
  oiWallNow: null,
  oiWallPrev: null,
  oiWallsAt: null,
  greenFloorArmedLatched: false,
};

/** `goodDraft` from services/thesis.service.spec.ts. */
const GOOD_THESIS = {
  direction: 'LONG',
  reason: 'bought the demand zone',
  levelPrice: 1450,
  targetPrice: 1520,
  invalidation: 1440,
};

/** The level book the chart shim returns — `at` fixed so nothing reads the clock. */
const THESIS_LEVELS = {
  value: [{ price: 1450, kind: 'SUPPORT' }],
  source: 'chart-context.service (15m)',
  at: AT,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type Reply = ReturnType<Recorder['reply']>;

const textReply = (text: string, stop_reason: string | null = 'end_turn'): Reply => ({
  stop_reason,
  content: [{ type: 'text', text }],
});
const jsonReply = (obj: unknown, stop_reason: string | null = 'end_turn'): Reply =>
  textReply(JSON.stringify(obj), stop_reason);

/** A fake `ConfigService`: only `get` is read by the sentinel. */
function fakeConfig(env: Record<string, string>) {
  return { get: (key: string) => env[key] } as never;
}

/** A thrown value, reduced to what is stable and meaningful. */
function describeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { class: err.constructor.name, name: err.name, message: err.message };
  }
  return { thrown: String(err) };
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

const LOG_LEVELS = ['error', 'warn', 'log', 'debug', 'verbose'] as const;

/**
 * Silences and captures every Nest `Logger` instance method for the duration of
 * `run`, keeping only lines from the sentinel's own contexts.
 */
async function withLogCapture<T>(run: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const spies = LOG_LEVELS.map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation(function (this: Logger, ...args: unknown[]) {
      const context = (this as unknown as { context?: string }).context ?? '';
      if (!SENTINEL_LOG_CONTEXTS.includes(context)) return;
      logs.push(`[${context}] ${level}: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' | ')}`);
    }),
  );
  try {
    const value = await run();
    return { value, logs };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

function onlyRequest(scenario: string, rec: Recorder): unknown {
  if (rec.requests.length !== 1) {
    throw new Error(`golden: scenario ${scenario} expected exactly 1 transport request, got ${rec.requests.length}`);
  }
  return rec.requests[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Service-level scenarios
// ─────────────────────────────────────────────────────────────────────────────

type ScenarioName = (typeof SCENARIO_NAMES)[number];

interface Scenario {
  name: ScenarioName;
  reply: Recorder['reply'];
  /** Drives the real service against `client`; resolves to the observable result. */
  run: (client: MessagesTransport) => Promise<unknown>;
}

/**
 * What every judge scenario runs under unless it says otherwise: exit discipline
 * OFF (and, by omission, price triggers off). That is the pre-feature sentinel,
 * so the baseline scenarios' recorded requests — prompt, packet and stamp —
 * prove both switches off change nothing.
 */
// SENTINEL_EQUITY_BLOCK off: the baseline predates the +e1 equity lines (pinned in sentinel-agent.service.spec.ts).
// SENTINEL_SQUARE_OFF_LOOK off: likewise it predates the +s1 squareOffDecision lines (same pin).
const BASELINE_ENV: Record<string, string> = { EXIT_DISCIPLINE_ENABLED: 'false', SENTINEL_EQUITY_BLOCK: 'false', SENTINEL_SQUARE_OFF_LOOK: 'false' };

/** The real judge, as configured by `env` (over BASELINE_ENV), over `client`. */
const runJudge = (
  client: MessagesTransport,
  env: Record<string, string>,
  trigger: WakeTrigger,
  packet: ContextPacket = GOLDEN_PACKET,
) => outcome(() => new SentinelAgentService(client, fakeConfig({ ...BASELINE_ENV, ...env })).judge(packet, trigger));

/** The real overnight judge over `client`. */
const runOvernight = (client: MessagesTransport) =>
  outcome(() => new SentinelAgentService(client, fakeConfig({})).judgeOvernight(OVERNIGHT_PACKET));

/**
 * The real `ThesisService.ensureFor` over `client`, with a repository that holds
 * no thesis yet. `repoCalls` pins the `sentinel_theses` row the service writes —
 * including the honest-unknown row on a transport failure, whose `reason` is
 * derived from the error.
 */
async function runThesis(client: MessagesTransport): Promise<unknown> {
  const repoCalls: unknown[] = [];
  const repo = {
    find: async (trackerId: string) => {
      repoCalls.push({ method: 'find', args: [trackerId] });
      return null;
    },
    upsertInferred: async (trackerId: string, draft: ThesisDraft) => {
      // The row as `sentinel_theses` would hold it.
      repoCalls.push({ method: 'upsertInferred', args: [trackerId, JSON.parse(JSON.stringify(draft))] });
      const { userId: _userId, ...rest } = draft;
      return { ...rest, source: 'INFERRED' };
    },
    overrideByUser: async () => {
      throw new Error('golden: overrideByUser must not be called while inferring');
    },
  };
  const levelsForCalls: unknown[] = [];
  const chart: ChartContextShim = {
    levelsFor: async (...args: unknown[]) => {
      levelsForCalls.push(args);
      return THESIS_LEVELS;
    },
  };
  const svc = new ThesisService(repo as never, client, chart);
  const result = await outcome(() => svc.ensureFor(THESIS_ENTRY, THESIS_TICK));
  return { ...(result as object), repoCalls, levelsForCalls };
}

function judgeScenario(
  name: ScenarioName,
  env: Record<string, string>,
  trigger: WakeTrigger,
  reply: Recorder['reply'],
  packet: ContextPacket = GOLDEN_PACKET,
): Scenario {
  return { name, reply, run: (client) => runJudge(client, env, trigger, packet) };
}

/** The plain `Error` the CLI transport throws on a failed subprocess — the prod failure shape under `cli`. */
const plainTransportError = () => new Error('claude CLI: exited with code 1: boom');

const SCENARIOS: Scenario[] = [
  judgeScenario('judge-fire-cues-on', { MARKET_CUES_ENABLED: 'true' }, 'FIRE', () => jsonReply(VALID_VERDICT)),
  judgeScenario('judge-heartbeat-cues-off', {}, 'HEARTBEAT', () => jsonReply(VALID_VERDICT)),
  judgeScenario(
    'judge-env-overrides',
    { SENTINEL_MODEL_TRIGGERED: 'x-model', SENTINEL_EFFORT_TRIGGERED: 'low' },
    'FIRE',
    () => jsonReply(VALID_VERDICT),
  ),
  judgeScenario('judge-fenced-json', {}, 'FIRE', () =>
    textReply('```json\n' + JSON.stringify(VALID_VERDICT) + '\n```'),
  ),
  judgeScenario('judge-refusal', {}, 'FIRE', () => jsonReply(VALID_VERDICT, 'refusal')),
  judgeScenario('judge-max-tokens', {}, 'FIRE', () => jsonReply(VALID_VERDICT, 'max_tokens')),
  judgeScenario('judge-context-exceeded', {}, 'FIRE', () => jsonReply(VALID_VERDICT, 'model_context_window_exceeded')),
  judgeScenario('judge-fire-cues-on-triggers', { MARKET_CUES_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true' }, 'FIRE', () =>
    jsonReply(VALID_VERDICT),
  ),
  judgeScenario('judge-heartbeat-cues-off-triggers', { SENTINEL_TRIGGERS_ENABLED: 'true' }, 'HEARTBEAT', () => jsonReply(VALID_VERDICT)),
  judgeScenario(
    'judge-fire-cues-on-discipline',
    { MARKET_CUES_ENABLED: 'true', EXIT_DISCIPLINE_ENABLED: 'true' },
    'FIRE',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_DISCIPLINE,
  ),
  judgeScenario(
    'judge-heartbeat-cues-off-discipline',
    { EXIT_DISCIPLINE_ENABLED: 'true' },
    'HEARTBEAT',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_DISCIPLINE,
  ),
  judgeScenario(
    'judge-fire-cues-on-discipline-triggers',
    { MARKET_CUES_ENABLED: 'true', EXIT_DISCIPLINE_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true' },
    'FIRE',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_DISCIPLINE,
  ),
  judgeScenario(
    'judge-heartbeat-cues-off-discipline-triggers',
    { EXIT_DISCIPLINE_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true' },
    'HEARTBEAT',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_DISCIPLINE,
  ),
  // News & events v2 (Task D3): every news-on prompt variant, and observe (= off).
  judgeScenario(
    'judge-fire-cues-on-news-discipline',
    { MARKET_CUES_ENABLED: 'true', EXIT_DISCIPLINE_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' },
    'FIRE',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_NEWS_DISCIPLINE,
  ),
  judgeScenario(
    'judge-heartbeat-cues-off-news-discipline',
    { EXIT_DISCIPLINE_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' },
    'HEARTBEAT',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_NEWS_DISCIPLINE,
  ),
  judgeScenario(
    'judge-fire-cues-on-news',
    { MARKET_CUES_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' },
    'FIRE',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_NEWS,
  ),
  judgeScenario('judge-heartbeat-cues-off-news', { NEWS_EVENTS_V2_ENABLED: 'true' }, 'HEARTBEAT', () => jsonReply(VALID_VERDICT), GOLDEN_PACKET_NEWS),
  judgeScenario(
    'judge-fire-cues-on-news-triggers',
    { MARKET_CUES_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' },
    'FIRE',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_NEWS,
  ),
  judgeScenario(
    'judge-heartbeat-cues-off-news-triggers',
    { SENTINEL_TRIGGERS_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' },
    'HEARTBEAT',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_NEWS,
  ),
  judgeScenario(
    'judge-fire-cues-on-news-discipline-triggers',
    { MARKET_CUES_ENABLED: 'true', EXIT_DISCIPLINE_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' },
    'FIRE',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_NEWS_DISCIPLINE,
  ),
  judgeScenario(
    'judge-heartbeat-cues-off-news-discipline-triggers',
    { EXIT_DISCIPLINE_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' },
    'HEARTBEAT',
    () => jsonReply(VALID_VERDICT),
    GOLDEN_PACKET_NEWS_DISCIPLINE,
  ),
  judgeScenario('judge-heartbeat-cues-off-news-observe', { NEWS_EVENTS_V2_ENABLED: 'observe' }, 'HEARTBEAT', () => jsonReply(VALID_VERDICT)),
  { name: 'overnight', reply: () => jsonReply(VALID_OVERNIGHT), run: runOvernight },
  { name: 'thesis', reply: () => jsonReply(GOOD_THESIS), run: runThesis },
  judgeScenario('transport-throws', {}, 'FIRE', () => {
    // Exactly as services/sentinel-agent.service.spec.ts constructs it.
    throw new RateLimitError(429, undefined, 'quota exhausted', new Headers());
  }),
  judgeScenario('transport-throws-plain-error', {}, 'FIRE', () => {
    throw plainTransportError();
  }),
  judgeScenario('transport-throws-api-error', {}, 'FIRE', () => {
    throw new APIError(529, undefined, 'overloaded', new Headers());
  }),
  judgeScenario('transport-throws-connection', {}, 'FIRE', () => {
    // Exactly as services/sentinel-agent.service.spec.ts constructs it.
    throw new APIConnectionError({ message: 'ECONNRESET' });
  }),
  {
    name: 'overnight-transport-throws',
    reply: () => {
      throw plainTransportError();
    },
    run: runOvernight,
  },
  {
    name: 'thesis-transport-throws',
    reply: () => {
      throw plainTransportError();
    },
    run: runThesis,
  },
  {
    name: 'thesis-rate-limited',
    reply: () => {
      throw new RateLimitError(429, undefined, 'quota exhausted', new Headers());
    },
    run: runThesis,
  },
];

/**
 * Runs every service-level scenario against a client built by `makeClient`, in a
 * fixed order. The factory is the ONLY input: the baseline passes
 * `recordingClient`; the gateway run passes a gateway-backed transport whose fake
 * provider records into, and replies from, the same recorder (a throw from
 * `rec.reply` must reach the sentinel unchanged).
 */
export async function runGoldenScenarios(
  makeClient: (rec: Recorder) => MessagesTransport,
): Promise<GoldenRecord[]> {
  const records: GoldenRecord[] = [];
  for (const scenario of SCENARIOS) {
    const rec: Recorder = { requests: [], reply: scenario.reply };
    const client = makeClient(rec);
    const { value: result, logs } = await withLogCapture(() => scenario.run(client));
    records.push({ scenario: scenario.name, request: onlyRequest(scenario.name, rec), result, logs });
  }
  return records;
}

/**
 * Asserts a candidate client produces EXACTLY the baseline's records.
 *
 * Use this — not `toMatchSnapshot` — from any other describe/test: jest snapshot
 * keys include the test title, so a snapshot call elsewhere would write new keys
 * instead of comparing. The baseline (`recordingClient`) is itself pinned by the
 * snapshots in `sentinel-golden.spec.ts`, so equality here is transitive.
 *
 * `toEqual` gives a readable diff; the `JSON.stringify` comparison additionally
 * pins KEY ORDER of every request (pretty-format sorts keys, `toEqual` ignores
 * order), i.e. the wire bytes.
 */
export async function expectSameAsBaseline(makeClient: (rec: Recorder) => MessagesTransport): Promise<void> {
  const baseline = await runGoldenScenarios((rec) => recordingClient(rec));
  const candidate = await runGoldenScenarios(makeClient);
  expect(candidate).toEqual(baseline);
  expect(JSON.stringify(candidate)).toBe(JSON.stringify(baseline));
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI transport scenarios (ClaudeCliTransport, or a candidate, with a mocked `spawn`)
// ─────────────────────────────────────────────────────────────────────────────

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: jest.Mock };
  kill: jest.Mock;
};

/**
 * A fake child process, as in adapters/claude-cli.transport.spec.ts: emits the
 * stdout chunks and closes. `hang` never closes; `spawnError` emits `'error'`.
 */
function fakeChild(
  envelope: unknown,
  opts: { code?: number; stderr?: string; hang?: boolean; spawnError?: Error; chunks?: Buffer[] } = {},
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { end: jest.Mock };
  stdin.end = jest.fn();
  child.stdin = stdin;
  child.kill = jest.fn();
  if (opts.hang) return child;
  setImmediate(() => {
    if (opts.spawnError) {
      child.emit('error', opts.spawnError);
      return;
    }
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    for (const chunk of opts.chunks ?? []) child.stdout.emit('data', chunk);
    if (envelope !== undefined) {
      child.stdout.emit('data', Buffer.from(typeof envelope === 'string' ? envelope : JSON.stringify(envelope)));
    }
    child.emit('close', opts.code ?? 0);
  });
  return child;
}

/** The small request from adapters/claude-cli.transport.spec.ts, for the envelope scenarios. */
const SMALL_REQUEST: TransportRequest = {
  model: 'claude-opus-5',
  max_tokens: 16000,
  output_config: {
    effort: 'high',
    format: { type: 'json_schema', schema: { type: 'object', required: ['verdict'] } },
  },
  system: [{ type: 'text', text: 'You are the sentinel.', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: '{"packet":1}' }],
};

const okEnvelope = (text: string) => ({ is_error: false, stop_reason: 'end_turn', result: text });

/** The production CLI transport — the default for every CLI runner. */
export const defaultCliTransport = (): MessagesTransport => new ClaudeCliTransport();

/**
 * The exact request object `judge-fire-cues-on` sends, captured from the real
 * service. The RAW object is returned (not a copy), so anything downstream that
 * keys on schema object identity sees the real `VERDICT_SCHEMA`.
 */
async function judgeFireCuesOnRequest(): Promise<TransportRequest> {
  let raw: TransportRequest | undefined;
  const client: MessagesTransport = {
    messages: {
      create: async (params) => {
        raw = params;
        return jsonReply(VALID_VERDICT);
      },
    },
  };
  await withLogCapture(() =>
    new SentinelAgentService(client, fakeConfig({ ...BASELINE_ENV, MARKET_CUES_ENABLED: 'true' })).judge(GOLDEN_PACKET, 'FIRE'),
  );
  if (!raw) throw new Error('golden: judge-fire-cues-on sent no request');
  return raw;
}

const PROMPT_FILE_ARG = /"--system-prompt-file" "((?:[^"\\]|\\.)*)"/;

/** Undoes `quoteArg`'s escaping of `"` and `\`. */
function unquote(escaped: string): string {
  return escaped.replace(/\\(["\\])/g, '$1');
}

/** Every temp dir a CLI scenario's transport wrote a prompt file into. */
const cliTempDirs = new Set<string>();

/**
 * Removes every temp dir the CLI scenarios created. Call from `afterAll` — not
 * per scenario, because a candidate transport may keep one dir across calls.
 */
export function cleanupCliTempDirs(): void {
  for (const dir of cliTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp dir must not fail the suite.
    }
  }
  cliTempDirs.clear();
}

/** Notes the prompt dir of every spawn so far, for `cleanupCliTempDirs`. */
function noteTempDirs(spawnMock: jest.Mock): void {
  for (const [commandLine] of spawnMock.mock.calls as [string][]) {
    const match = PROMPT_FILE_ARG.exec(commandLine);
    if (match) cliTempDirs.add(dirname(unquote(match[1])));
  }
}

/**
 * The single spawn, reduced to what is stable: the command line with the prompt
 * path normalised to `<TMP>/<file>`, the prompt file's path facts and CONTENT,
 * the spawn options and stdin.
 */
function inspectSpawn(spawnMock: jest.Mock, child: FakeChild | undefined) {
  if (spawnMock.mock.calls.length !== 1) {
    throw new Error(`golden: expected exactly 1 spawn, got ${spawnMock.mock.calls.length}`);
  }
  const [commandLine, options] = spawnMock.mock.calls[0] as [string, Record<string, unknown>];
  const match = PROMPT_FILE_ARG.exec(commandLine);
  if (!match) throw new Error('golden: no --system-prompt-file argument in the spawn command line');
  const promptPath = unquote(match[1]);
  const promptDir = dirname(promptPath);
  cliTempDirs.add(promptDir);
  const normalisedPath = `<TMP>/${basename(promptPath)}`;
  return {
    options,
    commandLine: commandLine.replace(match[0], `"--system-prompt-file" ${quoteArg(normalisedPath)}`),
    promptFile: {
      path: normalisedPath,
      dirIsUnderOsTmpdir: promptDir.startsWith(tmpdir()),
      dirName: basename(promptDir).replace(/^(sentinel-cli-).+$/, '$1<RANDOM>'),
      content: readFileSync(promptPath, 'utf8'),
    },
    stdin: child ? child.stdin.end.mock.calls : null,
  };
}

const deepEqualEnv = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && a[k] === b[k]);
};

async function cliArgvAndEnv(spawnMock: jest.Mock, makeTransport: () => MessagesTransport): Promise<GoldenRecord> {
  const request = await judgeFireCuesOnRequest();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-golden-should-not-reach-the-child';
  process.env.ANTHROPIC_AUTH_TOKEN = 'tok-golden-should-not-reach-the-child';
  try {
    const expectedEnv: Record<string, unknown> = { ...process.env };
    delete expectedEnv.ANTHROPIC_API_KEY;
    delete expectedEnv.ANTHROPIC_AUTH_TOKEN;

    spawnMock.mockReset();
    let child: FakeChild | undefined;
    spawnMock.mockImplementation(() => {
      child = fakeChild(okEnvelope(JSON.stringify(VALID_VERDICT)));
      return child;
    });

    const transport = makeTransport();
    const { value: result, logs } = await withLogCapture(() =>
      outcome(() => transport.messages.create(request)),
    );

    const spawned = inspectSpawn(spawnMock, child);
    const env = spawned.options.env as Record<string, unknown>;

    return {
      scenario: 'cli-argv-and-env',
      request: JSON.parse(JSON.stringify(request)),
      result: {
        outcome: result,
        spawnCalls: spawnMock.mock.calls.length,
        commandLine: spawned.commandLine,
        options: {
          keys: Object.keys(spawned.options).sort(),
          shell: spawned.options.shell,
          windowsHide: spawned.options.windowsHide,
        },
        promptFile: spawned.promptFile,
        env: {
          isCopyNotProcessEnv: env !== (process.env as unknown),
          anthropicApiKeyAbsent: !('ANTHROPIC_API_KEY' in env),
          anthropicAuthTokenAbsent: !('ANTHROPIC_AUTH_TOKEN' in env),
          everyOtherKeyPassedThroughUnchanged: deepEqualEnv(env, expectedEnv),
        },
        stdin: spawned.stdin,
      },
      logs,
    };
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
  }
}

async function cliEnvelope(
  spawnMock: jest.Mock,
  makeTransport: () => MessagesTransport,
  scenario: CliScenarioName,
  envelope: unknown,
  opts: { code?: number; stderr?: string; spawnError?: Error; chunks?: Buffer[] } = {},
): Promise<GoldenRecord> {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild(envelope, opts));
  const transport = makeTransport();
  const { value: result, logs } = await withLogCapture(() =>
    outcome(() => transport.messages.create(SMALL_REQUEST)),
  );
  noteTempDirs(spawnMock);
  return {
    scenario,
    request: JSON.parse(JSON.stringify(SMALL_REQUEST)),
    result: { outcome: result, spawnCalls: spawnMock.mock.calls.length },
    logs,
  };
}

async function cliTimeout(spawnMock: jest.Mock, makeTransport: () => MessagesTransport): Promise<GoldenRecord> {
  spawnMock.mockReset();
  let child: FakeChild | undefined;
  spawnMock.mockImplementation(() => {
    child = fakeChild(undefined, { hang: true });
    return child;
  });
  const transport = makeTransport();
  jest.useFakeTimers();
  try {
    const { value: result, logs } = await withLogCapture(async () => {
      let settled = false;
      const pending = outcome(() => transport.messages.create(SMALL_REQUEST)).finally(() => {
        settled = true;
      });
      const flush = async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
      };
      await flush();
      jest.advanceTimersByTime(CLI_TIMEOUT_MS - 1);
      await flush();
      const settledBeforeDeadline = settled;
      jest.advanceTimersByTime(1);
      const out = await pending;
      return {
        outcome: out,
        timeoutMs: CLI_TIMEOUT_MS,
        settledBeforeDeadline,
        killCalls: child ? child.kill.mock.calls.length : null,
      };
    });
    noteTempDirs(spawnMock);
    return {
      scenario: 'cli-timeout',
      request: JSON.parse(JSON.stringify(SMALL_REQUEST)),
      result: { ...result, spawnCalls: spawnMock.mock.calls.length },
      logs,
    };
  } finally {
    jest.useRealTimers();
  }
}

/**
 * END TO END: the real sentinel service → the transport from `makeTransport` →
 * the mocked `spawn`. Pins what the production `SENTINEL_JUDGE=cli` chain spawns
 * (command line, prompt-file content, stdin) and what the sentinel makes of the
 * reply (verdict / thesis / error, logs, persisted thesis row).
 *
 * `request` is what the SENTINEL handed its client, captured by a pass-through
 * proxy that forwards the original object untouched (schema identity intact).
 */
async function cliEndToEnd(
  spawnMock: jest.Mock,
  makeTransport: () => MessagesTransport,
  scenario: CliScenarioName,
  drive: (client: MessagesTransport) => Promise<unknown>,
  envelope: unknown,
  opts: { code?: number; stderr?: string } = {},
): Promise<GoldenRecord> {
  spawnMock.mockReset();
  let child: FakeChild | undefined;
  spawnMock.mockImplementation(() => {
    child = fakeChild(envelope, opts);
    return child;
  });
  const transport = makeTransport();
  const sent: unknown[] = [];
  const proxy: MessagesTransport = {
    messages: {
      create: (params) => {
        sent.push(JSON.parse(JSON.stringify(params)));
        return transport.messages.create(params);
      },
    },
  };
  const { value: result, logs } = await withLogCapture(() => drive(proxy));
  if (sent.length !== 1) throw new Error(`golden: ${scenario} expected exactly 1 request, got ${sent.length}`);
  const spawned = inspectSpawn(spawnMock, child);
  return {
    scenario,
    request: sent[0],
    result: {
      outcome: result,
      spawnCalls: spawnMock.mock.calls.length,
      commandLine: spawned.commandLine,
      options: { shell: spawned.options.shell, windowsHide: spawned.options.windowsHide },
      promptFile: spawned.promptFile,
      stdin: spawned.stdin,
    },
    logs,
  };
}

type CliScenarioName = (typeof CLI_SCENARIO_NAMES)[number];

/**
 * Runs every CLI scenario. `spawnMock` is the `jest.mock('node:child_process')`
 * spawn from the calling spec (a module mock must be declared in the test file
 * to be hoisted reliably). `makeTransport` is the ONLY other input: the baseline
 * uses the production `ClaudeCliTransport`; a candidate (e.g. a gateway-backed
 * transport over the gateway's CLI provider) is passed in its place. It is
 * called once per scenario.
 */
export async function runCliGoldenScenarios(
  spawnMock: jest.Mock,
  makeTransport: () => MessagesTransport = defaultCliTransport,
): Promise<GoldenRecord[]> {
  const verdictText = JSON.stringify(VALID_VERDICT);
  const cuesOn = { MARKET_CUES_ENABLED: 'true' };
  return [
    await cliArgvAndEnv(spawnMock, makeTransport),
    await cliEnvelope(spawnMock, makeTransport, 'cli-envelope-ok', okEnvelope(verdictText)),
    await cliEnvelope(spawnMock, makeTransport, 'cli-envelope-fenced', okEnvelope('```json\n' + verdictText + '\n```')),
    await cliEnvelope(spawnMock, makeTransport, 'cli-envelope-is-error-401', {
      is_error: true,
      api_error_status: 401,
      subtype: 'success',
      result: 'Invalid API key · Please run /login',
    }),
    await cliEnvelope(spawnMock, makeTransport, 'cli-envelope-empty-result', {
      is_error: false,
      stop_reason: 'end_turn',
      result: '   ',
    }),
    await cliEnvelope(spawnMock, makeTransport, 'cli-nonzero-exit', undefined, {
      code: 1,
      stderr: 'error: unknown option --frobnicate',
    }),
    await cliTimeout(spawnMock, makeTransport),
    await cliEnvelope(spawnMock, makeTransport, 'cli-envelope-unparseable', 'not json at all'),
    await cliEnvelope(spawnMock, makeTransport, 'cli-envelope-is-error-529', {
      is_error: true,
      api_error_status: 529,
      subtype: 'success',
      result: 'Overloaded',
    }),
    await cliEnvelope(spawnMock, makeTransport, 'cli-spawn-error', undefined, {
      spawnError: new Error('spawn claude ENOENT'),
    }),
    await cliEnvelope(spawnMock, makeTransport, 'cli-output-cap', undefined, {
      // One chunk past the 8 MiB capture limit, then one more to trip it.
      chunks: [Buffer.alloc(8 * 1024 * 1024 + 1, 0x61), Buffer.from('b')],
    }),
    await cliEndToEnd(
      spawnMock,
      makeTransport,
      'cli-judge-end-to-end',
      (client) => runJudge(client, cuesOn, 'FIRE'),
      okEnvelope(verdictText),
    ),
    await cliEndToEnd(
      spawnMock,
      makeTransport,
      'cli-judge-fenced-end-to-end',
      (client) => runJudge(client, cuesOn, 'FIRE'),
      okEnvelope('```json\n' + verdictText + '\n```'),
    ),
    await cliEndToEnd(
      spawnMock,
      makeTransport,
      'cli-judge-refusal-end-to-end',
      (client) => runJudge(client, cuesOn, 'FIRE'),
      { is_error: false, stop_reason: 'refusal', result: verdictText },
    ),
    await cliEndToEnd(
      spawnMock,
      makeTransport,
      'cli-judge-nonzero-exit-end-to-end',
      (client) => runJudge(client, cuesOn, 'FIRE'),
      undefined,
      { code: 1, stderr: 'boom' },
    ),
    await cliEndToEnd(
      spawnMock,
      makeTransport,
      'cli-overnight-end-to-end',
      runOvernight,
      okEnvelope(JSON.stringify(VALID_OVERNIGHT)),
    ),
    await cliEndToEnd(
      spawnMock,
      makeTransport,
      'cli-thesis-end-to-end',
      runThesis,
      okEnvelope(JSON.stringify(GOOD_THESIS)),
    ),
    await cliEndToEnd(
      spawnMock,
      makeTransport,
      'cli-thesis-nonzero-exit-end-to-end',
      runThesis,
      undefined,
      { code: 1, stderr: 'boom' },
    ),
  ];
}

/**
 * Asserts a candidate CLI transport produces EXACTLY the production
 * `ClaudeCliTransport`'s records — same reasoning as `expectSameAsBaseline`.
 */
export async function expectCliSameAsBaseline(
  spawnMock: jest.Mock,
  makeTransport: () => MessagesTransport,
): Promise<void> {
  const baseline = await runCliGoldenScenarios(spawnMock, defaultCliTransport);
  const candidate = await runCliGoldenScenarios(spawnMock, makeTransport);
  expect(candidate).toEqual(baseline);
  expect(JSON.stringify(candidate)).toBe(JSON.stringify(baseline));
}
