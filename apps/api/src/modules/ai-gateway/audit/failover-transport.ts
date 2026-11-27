import { Logger } from '@nestjs/common';
import type { JudgeTransportName } from '../../trade-sentinel/services/llm-transport';
import { parseAuthorityMode } from '../../exit-authority/exit-authority.config';
import type { MessagesTransport, TransportMessage, TransportRequest } from '../transport.types';
import { directRecordedTransport } from './recorded-transport';

/**
 * AI ROUTE FAILOVER (trade agent exit authority, Task 2 — 2026-11-27).
 *
 * Once the trade agent holds exit authority, an AI outage is no longer "no verdict, the hard rules
 * act": the agent IS the exit. So one call is tried on each route in order (default Vertex, then the
 * server's `claude` CLI, then the API when a key is configured) and the first ANSWER wins.
 *
 * - Only a THROW fails over. Any reply — including `stop_reason: 'refusal'` or `max_tokens` — is an
 *   answer and is returned as is; the caller already classifies those.
 * - A route that throws `failuresToSkip` times in a row is skipped for `skipMs`, so a dead route does
 *   not add its timeout to every call. After the window it is tried again; a success resets it.
 * - If every route is inside its skip window, all are tried anyway: never fail without a call.
 * - When every route fails: `AllRoutesFailedError` (each route's error), `onAllFailed`, and
 *   `allDownSince()` holds the FIRST all-fail time until any success resets it to null — the
 *   exit-authority layer reads it (AI_HEALTH) to fall back to its backstop.
 *
 * Each route is an ordinary `directRecordedTransport`, so ai_calls recording and the agent
 * containers are unchanged per route.
 */

export interface RouteHealth {
  failures: number;
  skipUntil: number;
}

export const AI_HEALTH = Symbol('AI_HEALTH');
export interface AiHealthPort {
  allDownSince(): number | null;
}

export class AllRoutesFailedError extends Error {
  constructor(readonly errors: string[]) {
    super(`all AI routes failed: ${errors.join(' | ')}`);
    this.name = 'AllRoutesFailedError';
  }
}

export const DEFAULT_FAILURES_TO_SKIP = 3;
export const DEFAULT_SKIP_MS = 180_000;

const ERROR_MAX = 500;

function messageOf(err: unknown): string {
  const msg = err && typeof err === 'object' && 'message' in err ? (err as Error).message : err;
  return String(msg).slice(0, ERROR_MAX);
}

export function failoverTransport(
  routes: Array<{ name: string; transport: MessagesTransport }>,
  opts: {
    failuresToSkip?: number;
    skipMs?: number;
    clock?: () => number;
    onAllFailed?: (errors: string[]) => void;
  } = {},
): MessagesTransport & { allDownSince(): number | null; health(): Record<string, RouteHealth> } {
  if (routes.length === 0) throw new Error('failoverTransport needs at least one route');
  const failuresToSkip = Math.max(1, opts.failuresToSkip ?? DEFAULT_FAILURES_TO_SKIP);
  const skipMs = Math.max(0, opts.skipMs ?? DEFAULT_SKIP_MS);
  const clock = opts.clock ?? Date.now;
  const logger = new Logger('AiFailover');
  const health = routes.map((): RouteHealth => ({ failures: 0, skipUntil: 0 }));
  let downSince: number | null = null;

  async function create(params: TransportRequest): Promise<TransportMessage> {
    const start = clock();
    const anyEligible = health.some((h) => h.skipUntil <= start);
    const errors: string[] = [];
    for (let i = 0; i < routes.length; i++) {
      const { name, transport } = routes[i];
      const h = health[i];
      if (anyEligible && h.skipUntil > start) {
        errors.push(`${name}: skipped until ${new Date(h.skipUntil).toISOString()} (${h.failures} failures in a row)`);
        continue;
      }
      try {
        const reply = await transport.messages.create(params);
        h.failures = 0;
        h.skipUntil = 0;
        downSince = null;
        return reply;
      } catch (err) {
        const msg = messageOf(err);
        errors.push(`${name}: ${msg}`);
        h.failures += 1;
        // Kept (not reset) when the skip starts, so one more failure after the window re-skips at once.
        if (h.failures >= failuresToSkip) h.skipUntil = clock() + skipMs;
        logger.warn(
          `route ${name} failed (${h.failures} in a row${h.skipUntil > clock() ? `, skipped for ${skipMs} ms` : ''}): ${msg}`,
        );
      }
    }
    if (downSince === null) downSince = start;
    try {
      opts.onAllFailed?.(errors);
    } catch (err) {
      logger.error(`onAllFailed threw: ${messageOf(err)}`);
    }
    throw new AllRoutesFailedError(errors);
  }

  return {
    messages: { create },
    allDownSince: () => downSince,
    health: () => Object.fromEntries(routes.map((r, i) => [r.name, { ...health[i] }])),
  };
}

const TRANSPORT_NAMES: readonly JudgeTransportName[] = ['api', 'cli', 'bedrock', 'vertex'];
const DEFAULT_CHAIN: readonly JudgeTransportName[] = ['vertex', 'cli'];

/**
 * The route order, from `AI_FAILOVER_CHAIN` (comma list of api|cli|bedrock|vertex; unknown names and
 * repeats dropped). Default `vertex,cli` — prod has no ANTHROPIC_API_KEY. `api` is appended when
 * ANTHROPIC_API_KEY is set and the chain does not already list it.
 */
export function failoverChainFrom(env: Record<string, string | undefined>): JudgeTransportName[] {
  const chain: JudgeTransportName[] = [];
  for (const raw of (env.AI_FAILOVER_CHAIN ?? '').split(',')) {
    const name = raw.trim().toLowerCase() as JudgeTransportName;
    if (TRANSPORT_NAMES.includes(name) && !chain.includes(name)) chain.push(name);
  }
  if (chain.length === 0) chain.push(...DEFAULT_CHAIN);
  if ((env.ANTHROPIC_API_KEY ?? '').trim() !== '' && !chain.includes('api')) chain.push('api');
  return chain;
}

/**
 * `AI_FAILOVER=on|off`. Unset or unrecognised: on when `TRADE_AGENT_AUTHORITY=live`, else off — so with
 * the authority off nothing changes.
 */
export function aiFailoverOn(env: Record<string, string | undefined>): boolean {
  const v = (env.AI_FAILOVER ?? '').trim().toLowerCase();
  if (v === 'on') return true;
  if (v === 'off') return false;
  return parseAuthorityMode(env) === 'live';
}

/**
 * The direct (gateway-off) transport for one LLM caller, with failover when `aiFailoverOn(env)`.
 * Off: EXACTLY `directRecordedTransport({ judge, ... })`, as before. On: one `directRecordedTransport`
 * per `failoverChainFrom(env)` route (the caller's `judge` is then superseded by the chain), wrapped in
 * {@link failoverTransport}; an all-routes failure is logged at ERROR.
 */
export function directOrFailoverTransport(
  opts: Parameters<typeof directRecordedTransport>[0] & {
    env: Record<string, string | undefined>;
    caller: string;
  },
): MessagesTransport {
  const { env, caller, ...direct } = opts;
  if (!aiFailoverOn(env)) return directRecordedTransport(direct);
  const chain = failoverChainFrom(env);
  const logger = new Logger('AiFailover');
  logger.log(`${caller}: AI failover on, routes ${chain.join(' → ')}`);
  return failoverTransport(
    chain.map((name) => ({ name, transport: directRecordedTransport({ ...direct, judge: name }) })),
    { onAllFailed: (errors) => logger.error(`${caller}: every AI route failed — ${errors.join(' | ')}`) },
  );
}

/** AI_HEALTH when failover is off (or the transport is not a failover one): never "all down". */
export const NO_AI_HEALTH: AiHealthPort = { allDownSince: () => null };

/** The AI_HEALTH view of a transport: its own `allDownSince` when it is a failover transport. */
export function aiHealthOf(transport: unknown): AiHealthPort {
  const t = transport as Partial<AiHealthPort> | null | undefined;
  return t && typeof t.allDownSince === 'function' ? { allDownSince: () => t.allDownSince!() } : NO_AI_HEALTH;
}
