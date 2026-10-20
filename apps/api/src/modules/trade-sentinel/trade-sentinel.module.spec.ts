import type { Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { SentinelGatewayTransport } from '../ai-gateway/sentinel/sentinel-gateway.transport';
import { ClaudeCliTransport } from './adapters/claude-cli.transport';
import { TradeSentinelModule } from './trade-sentinel.module';
import { OI_WALL_SOURCE, OPEN_POSITIONS } from './ports/open-positions.port';
import { ENGINE_OWNERSHIP_PROBE, RosterService } from './services/roster.service';
import {
  CHART_CONTEXT_SHIM,
  ContextPacketService,
  NEWS_SHIM,
} from './services/context-packet.service';
import { ThesisService } from './services/thesis.service';
import { OiWallSnapshotService } from './services/oi-wall-snapshot.service';
import { SentinelCycleService, TICK_SOURCE } from './services/sentinel-cycle.service';
import { EXIT_ATTEMPTS, FUTILE_REJUDGE_CONFIG } from './services/futile-rejudge';
import { ANTHROPIC_CLIENT } from './services/sentinel-agent.service';
import { SentinelOvernightService } from './services/sentinel-overnight.service';
import { OVERNIGHT_EVIDENCE } from './ports/overnight-evidence.port';
import { MACRO_CUES } from './ports/market-cues.port';
import { EXIT_DISCIPLINE_CONFIG } from '../exit-discipline/config';
import { SentinelTickSource } from './adapters/tick-source.adapter';
import { MinuteBarsReader } from './adapters/minute-bars.reader';
import { NewsWatchBook } from './services/news-watch-book';
import { NewsWakeService } from './services/news-wake.service';
import { NEWS_INDEX } from './ports/news-index.port';
import { MARKET_EVENTS } from './ports/events.port';

/**
 * Every parameter Nest must resolve by an explicit TOKEN rather than by type.
 *
 * An interface erases at runtime, so `design:paramtypes` emits `Object` for it
 * and Nest reports an unresolved dependency AT BOOT. That is the entire class of
 * failure this module could not have hit before — nothing had ever booted — so
 * it is checked here rather than discovered on a deploy.
 */
const TOKEN_PARAMS: Array<[string, unknown, string]> = [
  ['RosterService.trackers', RosterService, OPEN_POSITIONS],
  ['RosterService.ownership', RosterService, ENGINE_OWNERSHIP_PROBE],
  ['ContextPacketService.chartContext', ContextPacketService, CHART_CONTEXT_SHIM],
  ['ContextPacketService.news', ContextPacketService, NEWS_SHIM],
  ['ContextPacketService.macroCues', ContextPacketService, MACRO_CUES],
  ['ThesisService.client', ThesisService, ANTHROPIC_CLIENT],
  ['ThesisService.chartContext', ThesisService, CHART_CONTEXT_SHIM],
  ['OiWallSnapshotService.oiWall', OiWallSnapshotService, OI_WALL_SOURCE],
  ['SentinelCycleService.ticks', SentinelCycleService, TICK_SOURCE],
  ['SentinelCycleService.discipline', SentinelCycleService, EXIT_DISCIPLINE_CONFIG],
  ['SentinelCycleService.futileCfg', SentinelCycleService, FUTILE_REJUDGE_CONFIG],
  ['SentinelCycleService.exitAttempts', SentinelCycleService, EXIT_ATTEMPTS],
  ['SentinelOvernightService.ticks', SentinelOvernightService, TICK_SOURCE],
  ['SentinelOvernightService.evidence', SentinelOvernightService, OVERNIGHT_EVIDENCE],
  ['SentinelTickSource.discipline', SentinelTickSource, EXIT_DISCIPLINE_CONFIG],
];

/** The `@Inject(...)` tokens Nest recorded for a class, in no particular order. */
function injectedTokens(target: unknown): unknown[] {
  const meta =
    ((Reflect as { getMetadata?: (k: string, t: unknown) => unknown }).getMetadata?.(
      'self:paramtypes',
      target,
    ) as Array<{ param: unknown }> | undefined) ?? [];
  return meta.map((m) => m.param);
}

/** Nest's module metadata, read without building a container. */
function moduleMeta<T>(key: string): T[] {
  return (
    ((Reflect as { getMetadata?: (k: string, t: unknown) => unknown }).getMetadata?.(
      key,
      TradeSentinelModule,
    ) as T[] | undefined) ?? []
  );
}

/** The token each provider entry answers to — a class provides itself. */
function providedTokens(): unknown[] {
  return moduleMeta<unknown>('providers').map((p) =>
    typeof p === 'object' && p !== null && 'provide' in p
      ? (p as { provide: unknown }).provide
      : p,
  );
}

/**
 * THE SYMMETRIC HALF OF THE BOOT CHECK, and the more valuable one.
 *
 * Asserting that a constructor carries `@Inject(TOKEN)` proves only that Nest
 * knows what to LOOK FOR. If nothing PROVIDES that token the container still
 * fails at boot with an unresolved dependency — which is the exact class of
 * failure this module could not previously have hit, because nothing had ever
 * booted. Checking one half and not the other closes half the hole and reads
 * like it closed all of it.
 */
describe('TradeSentinelModule — every token is actually provided', () => {
  it('provides a binding for every token a sentinel service injects', () => {
    const provided = providedTokens();
    const missing = TOKEN_PARAMS.filter(([, , token]) => !provided.includes(token)).map(
      ([label]) => label,
    );
    expect(missing).toEqual([]);
  });

  it('provides the exit-discipline config and the 1-minute bars reader (DB only)', () => {
    expect(providedTokens()).toEqual(expect.arrayContaining([EXIT_DISCIPLINE_CONFIG, MinuteBarsReader]));
  });

  it('reads a non-empty provider list, so the check cannot pass vacuously', () => {
    // A renamed metadata key would make `providedTokens()` return [] and turn
    // the assertion above into "nothing is missing from nothing".
    expect(providedTokens().length).toBeGreaterThan(10);
  });

  it('registers the controller and the runner, the two things nothing else reaches', () => {
    expect(moduleMeta<{ name: string }>('controllers').map((c) => c.name)).toEqual(['SentinelController', 'NightAnalysisController']);
    expect(providedTokens().map((t) => (t as { name?: string })?.name)).toContain(
      'SentinelRunnerService',
    );
    expect(providedTokens().map((t) => (t as { name?: string })?.name)).toContain(
      'SentinelOvernightService',
    );
  });

  it('imports the modules that export the concrete classes the adapters need', () => {
    // `OiWallService` and `ChartContextService` come from SignalGeneratorModule,
    // `NewsAggregatorService` from NewsModule, `MarketDataRepository` and
    // `LevelBookService` from MarketDataModule/SignalGeneratorModule. Losing an
    // import is the same boot failure by a different route.
    const imports = moduleMeta<{ name?: string }>('imports').map((m) => m?.name);
    expect(imports).toEqual(
      expect.arrayContaining([
        'PrismaModule',
        'MarketDataModule',
        'SignalGeneratorModule',
        'NewsModule',
        // The market-cues cache: the live packet's macro and the overnight cues.
        'MarketCuesModule',
        // News & events v2: the parsed NEWS_EVENTS_CONFIG and its singletons.
        'NewsEventsCoreModule',
      ]),
    );
  });

  it('provides the news & events v2 push wakes (NewsWatchBook, NewsWakeService)', () => {
    expect(providedTokens()).toEqual(expect.arrayContaining([NewsWatchBook, NewsWakeService]));
  });

  it('binds the news & events v2 ports to the real services, through the composition root only', () => {
    const p = (token: string) =>
      moduleMeta<Provider>('providers').find(
        (x) => typeof x === 'object' && (x as { provide?: unknown }).provide === token,
      ) as { useExisting?: { name?: string } } | undefined;
    expect(p(NEWS_INDEX)?.useExisting?.name).toBe('NewsIndexService');
    expect(p(MARKET_EVENTS)?.useExisting?.name).toBe('EventsService');
    expect(moduleMeta<{ name?: string }>('imports').map((m) => m?.name)).toEqual(
      expect.arrayContaining(['NewsEventsCoreModule', 'NewsIndexModule', 'MarketEventsModule']),
    );
  });
});

describe('TradeSentinelModule — every interface-typed dependency has a token', () => {
  it.each(TOKEN_PARAMS)('%s is injected by token', (_label, target, token) => {
    expect(injectedTokens(target)).toContain(token);
  });

  it('the tokens are all distinct, so no two ports share a provider by accident', () => {
    const tokens = [
      OPEN_POSITIONS,
      ENGINE_OWNERSHIP_PROBE,
      CHART_CONTEXT_SHIM,
      NEWS_SHIM,
      OI_WALL_SOURCE,
      TICK_SOURCE,
      ANTHROPIC_CLIENT,
      OVERNIGHT_EVIDENCE,
      MACRO_CUES,
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('no service resolves a port by TYPE, which would silently emit Object', () => {
    // Guards the reintroduction of the original bug: dropping an `@Inject` still
    // compiles, and the failure only appears when the container is built.
    for (const [label, target, token] of TOKEN_PARAMS) {
      const tokens = injectedTokens(target);
      expect({ label, has: tokens.includes(token) }).toEqual({ label, has: true });
    }
  });
});

/**
 * SP3 A6 — the `ANTHROPIC_CLIENT` binding under `AI_GATEWAY_SENTINEL`.
 *
 * Boots the module's REAL factory provider (taken from the module metadata, so
 * its `inject` list is exercised too) next to the real `AiGatewayModule`, with
 * only Prisma faked. Building the whole sentinel module would drag in the
 * market-data and broker graph, which this binding does not depend on.
 */
describe('TradeSentinelModule — ANTHROPIC_CLIENT binding (AI_GATEWAY_SENTINEL)', () => {
  function clientProvider(): Provider {
    const p = moduleMeta<Provider>('providers').find(
      (x) => typeof x === 'object' && x !== null && 'provide' in x && x.provide === ANTHROPIC_CLIENT,
    );
    if (!p) throw new Error('no ANTHROPIC_CLIENT provider');
    return p;
  }

  async function boot(env: Record<string, string>) {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
        AiGatewayModule,
      ],
      providers: [clientProvider()],
    })
      .overrideProvider(PrismaService)
      .useValue({ aiCall: { create: jest.fn(), aggregate: jest.fn() } })
      .compile();
    return { client: mod.get(ANTHROPIC_CLIENT), cli: mod.get(ClaudeCliTransport), mod };
  }

  it('no longer provides ClaudeCliTransport itself (the gateway module owns the one instance)', () => {
    expect(providedTokens()).not.toContain(ClaudeCliTransport);
    expect(moduleMeta<{ name?: string }>('imports').map((m) => m?.name)).toContain('AiGatewayModule');
  });

  it('flag unset, SENTINEL_JUDGE unset → a new Anthropic SDK client (exactly today)', async () => {
    const { client } = await boot({});
    expect(client).toBeInstanceOf(Anthropic);
  });

  it.each(['false', 'FALSE', '1', 'yes', ''])('AI_GATEWAY_SENTINEL=%p → the pre-gateway binding', async (flag) => {
    const { client } = await boot({ AI_GATEWAY_SENTINEL: flag });
    expect(client).toBeInstanceOf(Anthropic);
  });

  it('flag unset, SENTINEL_JUDGE=cli → the CLI transport, the SAME instance the gateway holds', async () => {
    const { client, cli, mod } = await boot({ SENTINEL_JUDGE: 'cli' });
    expect(client).toBe(cli);
    const gw = mod.get(AiGatewayService) as unknown as {
      deps: { adapters: { 'claude-cli': { cli: unknown } } };
    };
    expect(gw.deps.adapters['claude-cli'].cli).toBe(cli);
  });

  it.each(['true', ' TRUE '])('AI_GATEWAY_SENTINEL=%p → SentinelGatewayTransport', async (flag) => {
    const { client } = await boot({ AI_GATEWAY_SENTINEL: flag, SENTINEL_JUDGE: 'cli' });
    expect(client).toBeInstanceOf(SentinelGatewayTransport);
  });
});
