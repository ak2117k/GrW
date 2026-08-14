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
import { ANTHROPIC_CLIENT } from './services/sentinel-agent.service';

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
  ['ThesisService.client', ThesisService, ANTHROPIC_CLIENT],
  ['ThesisService.chartContext', ThesisService, CHART_CONTEXT_SHIM],
  ['OiWallSnapshotService.oiWall', OiWallSnapshotService, OI_WALL_SOURCE],
  ['SentinelCycleService.ticks', SentinelCycleService, TICK_SOURCE],
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

  it('reads a non-empty provider list, so the check cannot pass vacuously', () => {
    // A renamed metadata key would make `providedTokens()` return [] and turn
    // the assertion above into "nothing is missing from nothing".
    expect(providedTokens().length).toBeGreaterThan(10);
  });

  it('registers the controller and the runner, the two things nothing else reaches', () => {
    expect(moduleMeta<unknown>('controllers')).toHaveLength(1);
    expect(providedTokens().map((t) => (t as { name?: string })?.name)).toContain(
      'SentinelRunnerService',
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
      ]),
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
