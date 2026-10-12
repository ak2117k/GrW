import * as fs from 'node:fs';
import * as path from 'node:path';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { AI_JOBS, isAiJob, type AiJob } from '../ai-job';
import type { ProviderName } from '../providers/provider.types';

const PROVIDERS: readonly ProviderName[] = ['anthropic-api', 'claude-cli'];

/** Where one job's calls go. `model: null` means "use the request's model untouched". */
export interface AiRoute {
  provider: ProviderName;
  model: string | null;
  fallback: ProviderName[];
  maxWaitMs: number;
}

/**
 * How long a sentinel call may wait for a provider slot. The sentinel is the
 * top priority and today's only caller, so in practice it never waits; this is
 * a ceiling, not a target. It is longer than the CLI's own 180 s timeout so a
 * queued sentinel call is never failed by the queue before it could have been
 * failed by the transport.
 */
const SENTINEL_MAX_WAIT_MS = 300_000;

const SENTINEL_JOBS: readonly AiJob[] = AI_JOBS.filter((j) => j.startsWith('sentinel.'));

function fail(msg: string): never {
  throw new Error(`ai-routes: ${msg}`);
}

function provider(value: unknown, where: string): ProviderName {
  if (typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)) {
    return value as ProviderName;
  }
  return fail(`unknown provider ${JSON.stringify(value)} for ${where}`);
}

/** `decision.judge` → `DECISION_JUDGE`, `picks.next-day` → `PICKS_NEXT_DAY`. */
function envKey(job: AiJob): string {
  return job.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Resolve every job's route.
 *
 * SENTINEL ROUTES ARE DERIVED, NOT CONFIGURED (spec §4.3). They take their
 * provider from `SENTINEL_JUDGE` through the very function the sentinel module
 * already uses, keep the request's own model (`model: null`) and have no
 * fallback. Neither the JSON file nor `AI_ROUTE_SENTINEL_*` can change them —
 * moving the sentinel onto the gateway must not open a second way to reroute
 * it. Enabling a sentinel fallback is a later, explicit owner change here.
 *
 * Every other job comes from the JSON, overridden per job by
 * `AI_ROUTE_<JOB>_PROVIDER` / `AI_ROUTE_<JOB>_MODEL`. Anything malformed throws
 * — a typo in routing config must fail boot, not silently send a job somewhere
 * else.
 */
export function loadRoutes(json: unknown, env: NodeJS.ProcessEnv): Record<AiJob, AiRoute> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    fail('config must be a JSON object keyed by job');
  }
  const cfg = json as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (key.startsWith('_')) continue;
    if (!isAiJob(key)) fail(`unknown job key "${key}"`);
  }

  const sentinelProvider: ProviderName =
    judgeTransportFrom(env.SENTINEL_JUDGE) === 'cli' ? 'claude-cli' : 'anthropic-api';

  const routes = {} as Record<AiJob, AiRoute>;
  for (const job of AI_JOBS) {
    if (SENTINEL_JOBS.includes(job)) {
      routes[job] = {
        provider: sentinelProvider,
        model: null,
        fallback: [],
        maxWaitMs: SENTINEL_MAX_WAIT_MS,
      };
      continue;
    }
    const raw = cfg[job];
    if (raw === undefined) fail(`missing route for job "${job}"`);
    if (typeof raw !== 'object' || raw === null) fail(`route for "${job}" must be an object`);
    const r = raw as Record<string, unknown>;
    if (!(r.model === null || typeof r.model === 'string')) fail(`route "${job}".model must be a string or null`);
    if (!Array.isArray(r.fallback)) fail(`route "${job}".fallback must be an array`);
    if (typeof r.maxWaitMs !== 'number' || !Number.isFinite(r.maxWaitMs) || r.maxWaitMs < 0) {
      fail(`route "${job}".maxWaitMs must be a non-negative number`);
    }
    const k = envKey(job);
    const envProvider = env[`AI_ROUTE_${k}_PROVIDER`]?.trim();
    const envModel = env[`AI_ROUTE_${k}_MODEL`]?.trim();
    routes[job] = {
      provider: provider(envProvider || r.provider, `job "${job}"`),
      model: envModel || (r.model as string | null),
      fallback: (r.fallback as unknown[]).map((f) => provider(f, `job "${job}" fallback`)),
      maxWaitMs: r.maxWaitMs,
    };
  }
  return routes;
}

/**
 * Locate a gateway config file (`config/<file>` at the repo root).
 *
 * `AI_CONFIG_DIR` wins when set. Otherwise walk up from this module until a
 * directory containing `config/<file>` is found — which works from `src` under
 * jest, from `apps/api/dist` at runtime, and in the image where the repo is
 * copied to `/app`. Not found → throw: the gateway cannot route or price
 * without its config, and a boot that fails loudly beats one that routes
 * nowhere.
 */
export function resolveAiConfig(file: string): string {
  const fromEnv = process.env.AI_CONFIG_DIR?.trim();
  if (fromEnv) {
    const p = path.join(fromEnv, file);
    if (fs.existsSync(p)) return p;
    throw new Error(`ai-gateway: ${file} not found in AI_CONFIG_DIR=${fromEnv}`);
  }
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, 'config', file);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`ai-gateway: config/${file} not found above ${__dirname} (set AI_CONFIG_DIR)`);
}

/** Read and parse a gateway config file located by {@link resolveAiConfig}. */
export function readAiConfig(file: string): unknown {
  return JSON.parse(fs.readFileSync(resolveAiConfig(file), 'utf8'));
}
