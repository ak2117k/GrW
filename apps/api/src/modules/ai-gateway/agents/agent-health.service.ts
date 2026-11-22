import type { EventEmitter } from 'node:events';
import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { isAnyMarketOpen } from '../../trade-sentinel/market-sessions';
import { istDayKey } from '../budget/budget-meter';
import { agentEvents, type AgentFallbackEvent, type AgentQuotaEvent } from './agent-events';
import { AGENT_PROTOCOL, type AgentHealth } from './agent-protocol';
import { sharedAgentLinks, type AgentLinkState } from './agent-provider';
import { AGENT_GROUPS, agentsOn, agentUrl, type AgentGroup } from './agent-registry';

/** How often each agent's `/health` is polled (design §4.6). */
export const AGENT_HEALTH_INTERVAL_MS = 60_000;
/** Per-poll timeout. */
export const AGENT_HEALTH_TIMEOUT_MS = 5_000;
/** Consecutive failed polls before the owner hears that an agent is down. */
export const AGENT_HEALTH_FAILS_TO_ALERT = 3;
/** Above this RSS an agent gets one warning per IST day (compose `mem_limit` is 160m). */
export const AGENT_RSS_WARN_MB = 140;
/**
 * How long one failed poll keeps a group marked down (its calls served in-process): past the next poll,
 * so a group that stays unhealthy is re-marked before the mark lapses.
 */
export const AGENT_HEALTH_DOWN_MS = AGENT_HEALTH_INTERVAL_MS + AGENT_HEALTH_TIMEOUT_MS + 15_000;

export type HealthFetch = (
  url: string,
  init: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type Send = (key: string, text: string) => Promise<unknown> | unknown;

export interface AgentHealthDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: HealthFetch;
  /** Defaults to the owner's Telegram ops bot (`sendOpsAlert`, the transport under `owner-alert.telegram.adapter.ts`). */
  send?: Send;
  now?: () => number;
  events?: EventEmitter;
  log?: { log(msg: string): void; warn(msg: string): void };
  /** The link state the AgentProviders read (process-wide by default). */
  links?: AgentLinkState;
}

interface GroupState {
  fails: number;
  lastError: string;
  /** Sequence of the open outage alert, or null when none was sent. */
  downSeq: number | null;
  rssWarnedDay: string | null;
}

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err).slice(0, 300);

/**
 * Watches the AI agent containers (design 2026-11-22-ai-agents-design.md §4.6) so an agent can never
 * die silently ([[silent-absence-failure-pattern]]). Only when `agentsOn()`; otherwise it does
 * nothing at all — no polls, no listeners, no alerts.
 *
 * - polls `agentUrl(group)/health` for every group every 60 s (5 s timeout); 3 failures in a row → one
 *   "down" alert, then one "recovered" alert. A reply with another `protocol` counts as a failure
 *   (the API treats it as unreachable too);
 * - RSS > 140 MB → one warning per group per IST day;
 * - `agentEvents` `fallback` (a call served in-process) → one alert per group per IST session, only
 *   while a market is open (09:00–23:30 IST, weekdays: `isAnyMarketOpen`);
 * - `agentEvents` `quota` (a Vertex 429) → one alert per IST session.
 *
 * Alerts go through `sendOpsAlert` directly: the owner-alert PORT is shaped for positions, its
 * Telegram adapter is a thin wrapper over this same function. Never throws into a caller.
 */
export class AgentHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetch: HealthFetch;
  private readonly send: Send;
  private readonly now: () => number;
  private readonly events: EventEmitter;
  private readonly log: { log(msg: string): void; warn(msg: string): void };
  private readonly links: AgentLinkState;
  private readonly state = new Map<AgentGroup, GroupState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private seq = 0;
  private readonly fallbackSent = new Set<string>();
  private quotaSentDay: string | null = null;
  private subscribed = false;

  private readonly onFallback = (e: AgentFallbackEvent): void => {
    try {
      if (!this.on() || !e || typeof e.group !== 'string') return;
      const at = new Date(this.now());
      if (!isAnyMarketOpen(at)) return;
      const key = `${e.group}:${istDayKey(at)}`;
      if (this.fallbackSent.has(key)) return;
      this.fallbackSent.add(key);
      this.fire(
        `AGENT_FALLBACK:${key}`,
        `GrW AI agents — grw-agents-${e.group} could not take a call (job ${e.job}: ${String(e.reason).slice(0, 200)}). ` +
          'The API served it in-process, so nothing was skipped, but that agent is not doing its job. ' +
          'Further fallbacks for this agent today are not announced.',
      );
    } catch {
      /* an alert must never reach the AI call path */
    }
  };

  private readonly onQuota = (e: AgentQuotaEvent): void => {
    try {
      if (!this.on() || !e) return;
      const day = istDayKey(new Date(this.now()));
      if (this.quotaSentDay === day) return;
      this.quotaSentDay = day;
      this.fire(
        `AGENT_QUOTA:${day}`,
        `GrW AI agents — Vertex answered "quota exceeded" (429), first on job ${e.job}. ` +
          'Non-trading AI calls are throttled for 60 s at a time; trading calls keep their reserve. ' +
          'Check ai_calls errors. Further quota hits today are not announced.',
      );
    } catch {
      /* never throw from a listener */
    }
  };

  constructor(deps: AgentHealthDeps = {}) {
    this.env = deps.env ?? process.env;
    this.fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.send = deps.send ?? sendOpsAlert;
    this.now = deps.now ?? Date.now;
    this.events = deps.events ?? agentEvents;
    this.log = deps.log ?? new Logger(AgentHealthService.name);
    this.links = deps.links ?? sharedAgentLinks();
  }

  private on(): boolean {
    return agentsOn(this.env);
  }

  onModuleInit(): void {
    if (!this.on()) return;
    if (this.env === process.env && !bootJobsEnabled()) return;
    this.events.on('fallback', this.onFallback);
    this.events.on('quota', this.onQuota);
    this.subscribed = true;
    this.timer = setInterval(() => void this.checkAll(), AGENT_HEALTH_INTERVAL_MS);
    this.timer.unref?.();
    this.log.log(`[agents] health checks on for ${AGENT_GROUPS.join(', ')} every ${AGENT_HEALTH_INTERVAL_MS / 1000}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.subscribed) {
      this.events.off('fallback', this.onFallback);
      this.events.off('quota', this.onQuota);
      this.subscribed = false;
    }
  }

  /** One poll of every group. Public for tests; overlapping ticks are skipped. Never rejects. */
  async checkAll(): Promise<void> {
    if (!this.on() || this.checking) return;
    this.checking = true;
    try {
      await Promise.all(AGENT_GROUPS.map((g) => this.checkOne(g)));
    } catch {
      /* checkOne guards itself; belt and braces */
    } finally {
      this.checking = false;
    }
  }

  private st(group: AgentGroup): GroupState {
    let s = this.state.get(group);
    if (!s) {
      s = { fails: 0, lastError: '', downSeq: null, rssWarnedDay: null };
      this.state.set(group, s);
    }
    return s;
  }

  private async checkOne(group: AgentGroup): Promise<void> {
    const s = this.st(group);
    let health: AgentHealth;
    try {
      const res = await this.fetch(`${agentUrl(group, this.env)}/health`, {
        signal: AbortSignal.timeout(AGENT_HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      health = (await res.json()) as AgentHealth;
      if (!health || health.protocol !== AGENT_PROTOCOL) {
        throw new Error(`protocol ${String(health?.protocol)} answered, API speaks protocol ${AGENT_PROTOCOL}`);
      }
    } catch (err) {
      this.failed(group, s, errText(err));
      return;
    }
    this.succeeded(group, s, health);
  }

  private failed(group: AgentGroup, s: GroupState, reason: string): void {
    s.fails += 1;
    s.lastError = reason;
    // From the FIRST failed poll: the group's calls go in-process, and calls already in flight to it
    // (which would wait their whole timeout on a stalled socket) are cut off and re-served in-process.
    // Re-marked on every failed poll while it stays unhealthy.
    try {
      this.links.markDead(group, this.now(), AGENT_HEALTH_DOWN_MS);
    } catch {
      /* never break the watcher */
    }
    this.log.warn(`[agents] grw-agents-${group} /health failed (${s.fails} in a row): ${reason}`);
    if (s.fails < AGENT_HEALTH_FAILS_TO_ALERT || s.downSeq !== null) return;
    s.downSeq = ++this.seq;
    this.fire(
      `AGENT_DOWN:${group}:${s.downSeq}`,
      `GrW AI agents — grw-agents-${group} is DOWN: ${s.fails} health checks in a row failed (${reason}). ` +
        'Since its first failed check its AI calls go to the API in-process (calls already sent to it were cut off and re-served in-process), so nothing is skipped. ' +
        'Restart it, or set AI_AGENTS=off and recreate the api.',
    );
  }

  private succeeded(group: AgentGroup, s: GroupState, health: AgentHealth): void {
    const failed = s.fails;
    s.fails = 0;
    if (failed > 0) this.links.markUp(group);
    if (s.downSeq !== null) {
      const seq = s.downSeq;
      s.downSeq = null;
      this.fire(
        `AGENT_RECOVERED:${group}:${seq}`,
        `GrW AI agents — grw-agents-${group} is back (health OK after ${failed} failed checks; last error: ${s.lastError}).`,
      );
    }
    const rss = Number(health.rssMb);
    if (Number.isFinite(rss) && rss > AGENT_RSS_WARN_MB) {
      const day = istDayKey(new Date(this.now()));
      if (s.rssWarnedDay !== day) {
        s.rssWarnedDay = day;
        this.fire(
          `AGENT_RSS:${group}:${day}`,
          `GrW AI agents — grw-agents-${group} is using ${Math.round(rss)} MB RSS (warn above ${AGENT_RSS_WARN_MB} MB, ` +
            'container limit 160 MB). If it is killed, its calls fall back in-process.',
        );
      }
    }
  }

  private fire(key: string, text: string): void {
    try {
      void Promise.resolve(this.send(key, text)).catch(() => undefined);
    } catch {
      /* an alert must never break the watcher */
    }
  }
}
