import type { ModuleRef } from '@nestjs/core';
import { AGENT_PROTOCOL, type AgentHealth } from '../../ai-gateway/agents/agent-protocol';
import { sharedAgentLinks } from '../../ai-gateway/agents/agent-provider';
import { AGENT_GROUPS, agentsOn, agentUrl } from '../../ai-gateway/agents/agent-registry';
import { MarketHubService } from '../../market-hub/market-hub.service';
import type { DeskStatusPort } from '../services/desk-state.service';

/** The part of the hub's status() the health block reads. */
export interface HubStatusLike {
  socketUp: boolean;
  slots: { live: number; cap: number };
  prices: { fresh: number; stale: number; marketClosed: number; unavailable: number; oldestP0AgeMs: number | null; unpricedP0: number };
  lastError: string | null;
  candles: { lastTickWriteAt: number | null; lines?: { stale: string[] } } | null;
}

interface HubLike {
  status(): HubStatusLike | null;
  disabledReason(): string | null;
}

type Fetch = (url: string, init: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DeskStatusDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  now?: () => number;
  /** The market hub (default: MarketHubService through the ModuleRef, resolved lazily). */
  hub?: () => HubLike | null;
}

/** One agent /health poll's timeout (the health block's own 3 s box is the outer limit). */
const AGENT_POLL_MS = 2_000;

const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 160);

/** The feed line of the health block: socket, slots, price freshness and the last tick age. */
export function feedText(s: HubStatusLike | null, disabledReason: string | null, now: number): string {
  if (!s) return `hub not running: ${disabledReason ?? 'no engine'}`;
  const p = s.prices;
  const parts = [
    `hub socket ${s.socketUp ? 'UP' : 'DOWN'}`,
    `slots ${s.slots.live}/${s.slots.cap}`,
    `prices fresh ${p.fresh}, stale ${p.stale}, unavailable ${p.unavailable}${p.marketClosed ? `, market closed ${p.marketClosed}` : ''}`,
  ];
  if (p.oldestP0AgeMs != null) parts.push(`oldest P0 price ${secs(p.oldestP0AgeMs)}`);
  if (p.unpricedP0) parts.push(`unpriced P0 ${p.unpricedP0}`);
  const last = s.candles?.lastTickWriteAt;
  parts.push(last != null ? `last tick ${secs(now - last)} ago` : 'last tick: none since boot');
  const stale = s.candles?.lines?.stale ?? [];
  if (stale.length) parts.push(`stale lines ${stale.slice(0, 6).join(', ')}${stale.length > 6 ? ` (+${stale.length - 6})` : ''}`);
  if (s.lastError) parts.push(`last error: ${s.lastError.slice(0, 160)}`);
  return parts.join('; ');
}

function agentText(h: AgentHealth): string {
  const rows = Object.values(h.agents ?? {});
  const sum = (k: 'inFlight' | 'limit' | 'okLast5m' | 'errLast5m' | 'queued') => rows.reduce((n, r) => n + (Number(r?.[k]) || 0), 0);
  const queued = sum('queued');
  return `up: rss ${Math.round(Number(h.rssMb) || 0)} MB, in flight ${sum('inFlight')}/${sum('limit')}, ok ${sum('okLast5m')} / err ${sum('errLast5m')} in 5 min${queued ? `, queued ${queued}` : ''}`;
}

/**
 * The health block's feed status (the market hub: socket, slots, last tick age) and the AI agent containers
 * (each group's /health, as the ai-gateway AgentHealthService polls it). Read-only; never throws into the packet.
 */
export class DeskStatusAdapter implements DeskStatusPort {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: Fetch;
  private readonly now: () => number;
  private readonly hub: () => HubLike | null;

  constructor(deps: DeskStatusDeps = {}) {
    this.env = deps.env ?? process.env;
    this.fetchFn = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = deps.now ?? Date.now;
    this.hub = deps.hub ?? (() => null);
  }

  /**
   * The module binding: the hub resolved lazily through the ModuleRef (MarketHubModule imports MarketDataModule and
   * TradeTrackerModule; a direct import here would add a module cycle, as for HUB_PRICE_SOURCE's consumers).
   */
  static fromModuleRef(ref: ModuleRef): DeskStatusAdapter {
    return new DeskStatusAdapter({
      hub: () => {
        try {
          return ref.get(MarketHubService, { strict: false });
        } catch {
          return null;
        }
      },
    });
  }

  async feed(): Promise<string> {
    const hub = this.hub();
    if (!hub) return 'hub not running: market hub service not found';
    return feedText(hub.status(), hub.disabledReason(), this.now());
  }

  async agents(): Promise<Record<string, string>> {
    if (!agentsOn(this.env)) return { all: 'off (AI_AGENTS off: AI calls run in the API process)' };
    const links = sharedAgentLinks();
    const out: Record<string, string> = {};
    await Promise.all(
      AGENT_GROUPS.map(async (g) => {
        const marked = links.isDown(g, this.now()) ? ' (marked down: calls served in-process)' : '';
        try {
          const res = await this.fetchFn(`${agentUrl(g, this.env)}/health`, { signal: AbortSignal.timeout(AGENT_POLL_MS) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const h = (await res.json()) as AgentHealth;
          if (!h || h.protocol !== AGENT_PROTOCOL) throw new Error(`protocol ${String(h?.protocol)} (API speaks ${AGENT_PROTOCOL})`);
          out[g] = `${agentText(h)}${marked}`;
        } catch (e) {
          out[g] = `down: ${errText(e)}${marked}`;
        }
      }),
    );
    return out;
  }
}
