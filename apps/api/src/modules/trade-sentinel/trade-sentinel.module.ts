import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { NewsModule } from '../news/news.module';

import { SentinelController } from './controllers/sentinel.controller';
import { OpenPositionsRepository } from './repositories/open-positions.repository';
import { SentinelVerdictRepository } from './repositories/sentinel-verdict.repository';
import { SentinelThesisRepository } from './repositories/sentinel-thesis.repository';
import { OPEN_POSITIONS, OI_WALL_SOURCE } from './ports/open-positions.port';
import { ENGINE_OWNERSHIP_PROBE, RosterService } from './services/roster.service';
import { TripwireService } from './services/tripwire.service';
import {
  CHART_CONTEXT_SHIM,
  ContextPacketService,
  NEWS_SHIM,
} from './services/context-packet.service';
import { ThesisService } from './services/thesis.service';
import { ANTHROPIC_CLIENT, SentinelAgentService } from './services/sentinel-agent.service';
import { OiWallSnapshotService } from './services/oi-wall-snapshot.service';
import { SentinelCycleService, TICK_SOURCE } from './services/sentinel-cycle.service';
import { SentinelRunnerService } from './services/sentinel-runner.service';
import { EngineOwnershipAdapter } from './adapters/engine-ownership.adapter';
import { SentinelChartContextAdapter } from './adapters/chart-context.adapter';
import { SentinelNewsAdapter } from './adapters/news.adapter';
import { SentinelOiWallSource } from './adapters/oi-wall.adapter';
import { SentinelTickSource } from './adapters/tick-source.adapter';

/**
 * Trade Sentinel — Stage 0 (shadow). Watches open Angel One positions and
 * records the exits it WOULD have taken. It places no orders.
 *
 * READ THIS BEFORE STRENGTHENING THE CLAIM. `sentinel-cycle.service.spec.ts`
 * proves that no order-placing module is reachable by following imports from
 * `sentinel-cycle.service.ts`. That is the property, and it is a real one — it
 * is what makes shadow mode structural rather than a `dryRun` flag someone can
 * flip. It is NOT the claim that nothing in this module's injector can reach a
 * broker. It plainly can:
 *
 *   - `SentinelOiWallSource` -> `OiWallService` -> `OptionsChainService` -> feed
 *     -> `AngelOneAdapterService.placeOrder`;
 *   - `SentinelChartContextAdapter` and `SentinelTickSource` reach the same
 *     adapter through the signal-generator and market-data services.
 *
 * That is exactly what the ports are for. The cycle depends on `OiWallSource`,
 * `TickSource`, `ChartContextShim`, `NewsShim`, `OpenPositionsPort` and
 * `EngineOwnershipProbe` — six interfaces that between them expose seven
 * read-only methods — and THIS FILE is the only place the broker-capable
 * implementations behind them are named. A composition root is the correct home
 * for that edge, because it is the one file where a human decides what is wired
 * to what and a reviewer can see the whole decision at once. Adding an executor
 * would have to happen here, in the open.
 *
 * The interface-typed ports all need an explicit token: an interface erases at
 * runtime, so `design:paramtypes` emits `Object` and Nest cannot resolve the
 * parameter by type.
 */
@Module({
  imports: [
    PrismaModule,
    // Instrument master (token/expiry/underlying resolution) for the tick source.
    MarketDataModule,
    // Level book (`SignalGeneratorService`, `LevelBookService`) and the OI walls.
    // `@Global`, but imported explicitly so the dependency is visible here.
    SignalGeneratorModule,
    NewsModule,
  ],
  controllers: [SentinelController],
  providers: [
    {
      provide: ANTHROPIC_CLIENT,
      // The SDK reads ANTHROPIC_API_KEY from the environment itself; it is
      // passed through ConfigService so the key's source is visible here.
      //
      // IT DOES NOT VALIDATE THE KEY. The SDK does NOT throw on construction
      // with a missing one — it fails on the first REQUEST, as an API error the
      // agent and thesis services already classify and degrade from. So a
      // deploy without ANTHROPIC_API_KEY boots fine and the sentinel simply
      // records no verdicts, which is the right behaviour for a default-off
      // feature (crashing the whole API over it would be far worse) but is NOT
      // a boot-time guarantee. Do not rely on one.
      useFactory: (config: ConfigService) =>
        new Anthropic({ apiKey: config.get<string>('ANTHROPIC_API_KEY') }),
      inject: [ConfigService],
    },

    // Adapters — the narrow ports, bound to the real services.
    { provide: OPEN_POSITIONS, useClass: OpenPositionsRepository },
    { provide: ENGINE_OWNERSHIP_PROBE, useClass: EngineOwnershipAdapter },
    { provide: OI_WALL_SOURCE, useClass: SentinelOiWallSource },
    { provide: NEWS_SHIM, useClass: SentinelNewsAdapter },
    // Bound to the SAME instance the tick source injects by class, so the level
    // book is derived once per symbol per minute rather than twice.
    SentinelChartContextAdapter,
    { provide: CHART_CONTEXT_SHIM, useExisting: SentinelChartContextAdapter },
    { provide: TICK_SOURCE, useClass: SentinelTickSource },

    SentinelVerdictRepository,
    SentinelThesisRepository,
    RosterService,
    TripwireService,
    ContextPacketService,
    ThesisService,
    SentinelAgentService,
    OiWallSnapshotService,
    SentinelCycleService,
    SentinelRunnerService,
  ],
  exports: [SentinelCycleService, SentinelRunnerService],
})
export class TradeSentinelModule {}
