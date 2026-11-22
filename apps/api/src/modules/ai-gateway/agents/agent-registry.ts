import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { readAiConfig } from '../routes/route-config';

/**
 * The AI agent registry (design 2026-11-22-ai-agents-design.md §4.2 / §4.4): for every AI job label,
 * which agent container serves it and with what settings. Read by the API (routing, overrides, the
 * sentinel cap, the global limiter) and by the agent containers (per-job semaphores).
 *
 * DELIBERATELY LIGHT: no NestJS, no Prisma — the agent container (`apps/api/src/agents/main.ts`)
 * imports this file and must stay small.
 */

/** The three agent containers on the VPS. */
export type AgentGroup = 'trading' | 'reading' | 'background';

export const AGENT_GROUPS: readonly AgentGroup[] = ['trading', 'reading', 'background'];

/** Port every agent container listens on (internal Docker network only). */
export const AGENT_PORT = 5300;

/**
 * One job's settings. `model` / `effort` / `maxTokens` `null` = keep what the caller sets today; a
 * non-null value overrides the caller. `agent: 'in-process'` = the API calls Vertex itself (rollout
 * steps route groups one at a time).
 */
export interface AgentProfile {
  agent: AgentGroup | 'in-process';
  concurrency: number;
  timeoutMs: number;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | null;
  maxTokens: number | null;
}

export interface AgentRegistry {
  /** The job's profile; an unknown job gets the background default (logged once). */
  profile(job: string): AgentProfile;
  /**
   * The registry entry a job is served under: the job itself when it has its own key or its own env
   * override, else the matching `.*` key (so every `backtest.*` job shares ONE semaphore of that
   * entry's concurrency on the agent), else the job (unknown jobs: one default semaphore each).
   */
  keyOf(job: string): string;
  /** The registry keys (as written, e.g. `backtest.*`) whose agent is `group`. */
  jobsOf(group: AgentGroup): string[];
}

/**
 * The only jobs that keep the `SentinelCycleService` slot gate when agents are on (§4.5): they share
 * the one-in-flight-per-position rule and the live reservation.
 */
export const SENTINEL_GATED_JOBS: readonly string[] = ['sentinel.judge', 'sentinel.thesis', 'sentinel.overnight'];

/** The design's trading-group jobs (§4.2); the global limiter's trading reserve is theirs (§4.5a). */
export const TRADING_JOBS: readonly string[] = ['sentinel.judge', 'sentinel.thesis', 'entry.judge', 'signal.judge'];

/** The sentinel judge cap with agents off (today's hard-coded `JUDGE_CONCURRENCY`). */
const SENTINEL_JUDGE_CONCURRENCY_OFF = 2;

/** A job the registry does not list: background, 2 at once, today's shared-slot timeout. */
export const DEFAULT_PROFILE: Readonly<AgentProfile> = Object.freeze({
  agent: 'background',
  concurrency: 2,
  timeoutMs: 240_000,
  model: null,
  effort: null,
  maxTokens: null,
});

/** The SDK's non-streaming ceiling is ~21k; every profile stays at or under 16k (§3). */
export const MAX_PROFILE_TOKENS = 16_000;

export const AGENTS_CONFIG_FILE = 'ai-agents.json';

const AGENT_VALUES: readonly AgentProfile['agent'][] = ['trading', 'reading', 'background', 'in-process'];
const EFFORTS: readonly NonNullable<AgentProfile['effort']>[] = ['low', 'medium', 'high'];

function fail(msg: string): never {
  throw new Error(`ai-agents: ${msg}`);
}

/** `sentinel.judge` → `SENTINEL_JUDGE`, `self-review.diagnose` → `SELF_REVIEW_DIAGNOSE`. */
export function jobEnvKey(job: string): string {
  return job.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function agentValue(v: unknown, where: string): AgentProfile['agent'] {
  if (typeof v === 'string' && (AGENT_VALUES as readonly string[]).includes(v)) return v as AgentProfile['agent'];
  return fail(`${where}.agent must be one of ${AGENT_VALUES.join('|')}, got ${JSON.stringify(v)}`);
}

function positiveInt(v: unknown, where: string): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
  return fail(`${where} must be a positive integer, got ${JSON.stringify(v)}`);
}

function nullableString(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return fail(`${where} must be a non-empty string or null, got ${JSON.stringify(v)}`);
}

function nullableEffort(v: unknown, where: string): AgentProfile['effort'] {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)) return v as AgentProfile['effort'];
  return fail(`${where} must be low|medium|high or null, got ${JSON.stringify(v)}`);
}

function nullableMaxTokens(v: unknown, where: string): number | null {
  if (v === null || v === undefined) return null;
  const n = positiveInt(v, where);
  if (n > MAX_PROFILE_TOKENS) fail(`${where} must be <= ${MAX_PROFILE_TOKENS}, got ${n}`);
  return n;
}

function parseProfile(raw: unknown, where: string): AgentProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`${where} must be an object`);
  const r = raw as Record<string, unknown>;
  return {
    agent: agentValue(r.agent ?? DEFAULT_PROFILE.agent, where),
    concurrency: positiveInt(r.concurrency ?? DEFAULT_PROFILE.concurrency, `${where}.concurrency`),
    timeoutMs: positiveInt(r.timeoutMs ?? DEFAULT_PROFILE.timeoutMs, `${where}.timeoutMs`),
    model: nullableString(r.model, `${where}.model`),
    effort: nullableEffort(r.effort, `${where}.effort`),
    maxTokens: nullableMaxTokens(r.maxTokens, `${where}.maxTokens`),
  };
}

/** An env value as JSON-ish: `null` → null, a number string → number, anything else the trimmed text. */
function envValue(raw: string): unknown {
  const v = raw.trim();
  if (v.toLowerCase() === 'null') return null;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/** `AGENT_<JOB>_<FIELD>` applied over a profile. Env beats file. Empty values are ignored. */
function withEnv(job: string, base: AgentProfile, env: NodeJS.ProcessEnv): AgentProfile {
  const k = `AGENT_${jobEnvKey(job)}_`;
  const fields: Array<[keyof AgentProfile, string]> = [
    ['agent', 'AGENT'],
    ['concurrency', 'CONCURRENCY'],
    ['timeoutMs', 'TIMEOUT_MS'],
    ['model', 'MODEL'],
    ['effort', 'EFFORT'],
    ['maxTokens', 'MAX_TOKENS'],
  ];
  const over: Record<string, unknown> = {};
  for (const [field, suffix] of fields) {
    const raw = env[k + suffix];
    if (raw !== undefined && raw.trim() !== '') over[field] = envValue(raw);
  }
  if (Object.keys(over).length === 0) return base;
  return parseProfile({ ...base, ...over }, `env AGENT_${jobEnvKey(job)}`);
}

/**
 * Parse a registry object (the JSON file's content). Keys starting with `_` are comments. A key
 * ending in `.*` matches every job with that prefix (longest prefix wins; an exact key beats any).
 * Malformed values throw — a typo must fail loudly, not send a job somewhere else.
 */
export function parseAgentRegistry(
  json: unknown,
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (m) => console.warn(m),
): AgentRegistry {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) fail('config must be a JSON object keyed by job');
  const entries = new Map<string, AgentProfile>();
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    if (key.startsWith('_')) continue;
    entries.set(key, parseProfile(raw, `"${key}"`));
  }
  const prefixes = [...entries.keys()]
    .filter((k) => k.endsWith('.*'))
    .map((k) => ({ key: k, prefix: k.slice(0, -1) }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const unknownLogged = new Set<string>();
  const cache = new Map<string, AgentProfile>();

  const fileProfile = (job: string): AgentProfile => {
    const exact = entries.get(job);
    if (exact) return exact;
    const p = prefixes.find((x) => job.startsWith(x.prefix));
    if (p) return entries.get(p.key)!;
    if (!unknownLogged.has(job)) {
      unknownLogged.add(job);
      warn(`ai-agents: job "${job}" is not in the registry — served by the background agent with the default profile`);
    }
    return { ...DEFAULT_PROFILE };
  };

  return {
    profile(job: string): AgentProfile {
      const hit = cache.get(job);
      if (hit) return { ...hit };
      const p = withEnv(job, fileProfile(job), env);
      cache.set(job, p);
      return { ...p };
    },
    keyOf(job: string): string {
      if (entries.has(job)) return job;
      const envPrefix = `AGENT_${jobEnvKey(job)}_`;
      if (Object.keys(env).some((k) => k.startsWith(envPrefix) && (env[k] ?? '').trim() !== '')) return job;
      return prefixes.find((x) => job.startsWith(x.prefix))?.key ?? job;
    },
    jobsOf(group: AgentGroup): string[] {
      return [...entries.keys()].filter((k) => withEnv(k, entries.get(k)!, env).agent === group);
    },
  };
}

/** The registry from `config/ai-agents.json` (via `readAiConfig`) plus `AGENT_<JOB>_<FIELD>` env overrides. */
export function loadAgentRegistry(env: NodeJS.ProcessEnv = process.env): AgentRegistry {
  return parseAgentRegistry(readAiConfig(AGENTS_CONFIG_FILE), env);
}

/** Agents are on only with `AI_AGENTS=on` AND `SENTINEL_JUDGE=vertex` (with `cli`, one local process). */
export function agentsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_AGENTS?.trim().toLowerCase() === 'on' && judgeTransportFrom(env.SENTINEL_JUDGE) === 'vertex';
}

/** `AGENT_URL_<GROUP>` (trailing `/` dropped), else `http://grw-agents-<group>:5300`. */
export function agentUrl(group: AgentGroup, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[`AGENT_URL_${group.toUpperCase()}`]?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  return `http://grw-agents-${group}:${AGENT_PORT}`;
}

/**
 * The sentinel's live judgement cap: the registry's `sentinel.judge` concurrency when agents are on
 * AND `sentinel.judge` is routed to an agent, else today's 2. While the trading jobs are still routed
 * `in-process` (rollout steps 4–5) the cap stays 2 — the design raises it to 6 only at step 6, when the
 * trading agent takes them. A registry that cannot be read keeps 2 (logged) — never a crashed sentinel.
 */
export function sentinelJudgeConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  if (!agentsOn(env)) return SENTINEL_JUDGE_CONCURRENCY_OFF;
  try {
    const p = loadAgentRegistry(env).profile('sentinel.judge');
    return p.agent === 'in-process' ? SENTINEL_JUDGE_CONCURRENCY_OFF : p.concurrency;
  } catch (err) {
    console.error(`ai-agents: registry unreadable, sentinel judge cap stays ${SENTINEL_JUDGE_CONCURRENCY_OFF}: ${(err as Error)?.message ?? String(err)}`);
    return SENTINEL_JUDGE_CONCURRENCY_OFF;
  }
}

/** Trading-class for the global limiter's reserve: routed to the trading agent, or a design trading job. */
export function isTradingJob(job: string, profile: AgentProfile): boolean {
  return profile.agent === 'trading' || TRADING_JOBS.includes(job);
}
