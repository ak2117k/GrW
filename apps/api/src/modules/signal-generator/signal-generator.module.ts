import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { HttpModule } from '@nestjs/axios';
import { MarketDataModule } from '../market-data/market-data.module';
import { SettingsModule } from '../settings/settings.module';
import { OptionsChainModule } from '../options-chain/options-chain.module';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { SignalGeneratorController } from './controllers/signal-generator.controller';
import { MlTriggerController } from './controllers/ml-trigger.controller';
import { SignalGeneratorService } from './services/signal-generator.service';
import { SignalScoringService } from './services/signal-scoring.service';
import { StrategyRegistryService } from './services/strategy-registry.service';
import { SignalRepository } from './repositories/signal.repository';
import { SignalScanProcessor } from './workers/signal-scan.processor';
import { UniverseScannerWorker } from './workers/universe-scanner.worker';
import { SignalGateway } from './gateways/signal.gateway';
import { StrategyBuilderController } from './controllers/strategy-builder.controller';
import { StrategyParserService } from './services/strategy-parser.service';
import { StrategyExecutorService } from './services/strategy-executor.service';
import { StrategyStorageService } from './services/strategy-storage.service';
import { RsiReversalStrategy } from './strategies/rsi-reversal.strategy';
import { EmaCrossoverStrategy } from './strategies/ema-crossover.strategy';
import { VwapDeviationStrategy } from './strategies/vwap-deviation.strategy';
import { AnandSniperV25CombinedStrategy } from './strategies/anand-sniper-v25-combined.strategy';
import { ChartinkGatedStrategy } from './strategies/chartink-gated.strategy';
import { LevelBookService } from './services/level-book.service';
import { LevelBookCron } from './services/level-book.cron';
import { ExitPriceService } from './services/exit-price.service';
import { SetupTrackerService } from './services/setup-tracker.service';
import { MtfAlignmentService } from './services/mtf-alignment.service';
import { ZoneRepository } from './repositories/zone.repository';
import { StrongZoneDetectorService } from './services/strong-zone-detector.service';
import { SrEvidenceService } from './services/sr-evidence.service';
import { OiWallService } from './services/oi-wall.service';
import { SrLevelTrackingService } from './services/sr-level-tracking.service';
import { SrLevelObservationRepository } from './repositories/sr-level-observation.repository';
import { ContextScoringService } from './services/context-scoring/context-scoring.service';
import { MtfTrendFactor } from './services/context-scoring/factors/mtf-trend.factor';
import { GreeksFactor } from './services/context-scoring/factors/greeks.factor';
import { VolatilityFactor } from './services/context-scoring/factors/volatility.factor';
import { SectorFactor } from './services/context-scoring/factors/sector.factor';
import { OiShiftFactor } from './services/context-scoring/factors/oi-shift.factor';
import { FiiFactor } from './services/context-scoring/factors/fii.factor';
import { NasdaqFactor } from './services/context-scoring/factors/nasdaq.factor';
import { CrudeOilFactor } from './services/context-scoring/factors/crude-oil.factor';
import { GoldFactor } from './services/context-scoring/factors/gold.factor';
import { PatternObservationRepository } from './ml/pattern-observation.repository';
import { PatternBackfillService } from './ml/pattern-backfill.service';
import { PatternCaptureService } from './ml/pattern-capture.service';
import type { ContextFactor } from './services/context-scoring/types';

// @Global so LevelBookService is injectable from MarketFeedService
// (in MarketDataModule) without MarketDataModule needing to import this
// module — that would be a bootstrap cycle since SignalGeneratorModule
// already imports MarketDataModule.
@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: 'signal-scan' }),
    BullModule.registerQueue({ name: 'signal-review' }),
    HttpModule.register({ timeout: 5000 }),
    PrismaModule,
    MarketDataModule,
    SettingsModule,
    OptionsChainModule,
    TradeEngineModule,
    SubscriptionModule,
  ],
  // MlTriggerController is @Public() + secret-authed (ML_TRIGGER_SECRET): the
  // external heartbeat that drives the ML capture ops cannot present a JWT.
  // Kept off SignalGeneratorController so its class-level @AdminOnly() stays intact.
  controllers: [SignalGeneratorController, StrategyBuilderController, MlTriggerController],
  providers: [
    // Core services
    SignalGeneratorService,
    SignalScoringService,
    StrategyRegistryService,

    // Built-in trading strategies
    RsiReversalStrategy,
    EmaCrossoverStrategy,
    VwapDeviationStrategy,
    AnandSniperV25CombinedStrategy,
    ChartinkGatedStrategy,

    // User-defined strategy engine
    StrategyParserService,
    StrategyExecutorService,
    StrategyStorageService,

    // Data access
    SignalRepository,

    // Bull queue processor
    SignalScanProcessor,

    // Universe scanner — auto-trades NIFTY+BANKNIFTY on the combined rule
    UniverseScannerWorker,

    // WebSocket gateway
    SignalGateway,

    // Level book — per-instrument VWAP / today H/L / spot tracker
    LevelBookService,

    // Risk-critical exit pricing — fresh-or-surface resolver
    // (REST batch -> per-token REST -> fresh level-book; never a stale seed).
    ExitPriceService,

    // Cron jobs — pre-market session seeder (09:15) + opening range locker (09:30)
    LevelBookCron,

    // In-memory locked-setup tracker — anchors entry/SL/target so the same
    // setup re-evaluated on subsequent polls returns the same numbers.
    SetupTrackerService,

    // Multi-timeframe alignment gate — Chartink MTF rule. Pulls candles
    // for the 4 reference timeframes (1d/1h/15m/5m) and reports whether
    // their last-close directions agree. Consumed by the chartink gate
    // and exposed to other modules through the module exports list.
    MtfAlignmentService,

    // Strong-zone persistence cache. Used by SignalGeneratorService to feed
    // the TP1-at-obstacle algorithm with the active S/R zone set per token.
    ZoneRepository,

    // Strong/swap zone detector — pure compute, fed by /signals/zones
    // on cache miss so the chart overlay never sees an empty zone list.
    StrongZoneDetectorService,

    // OI walls + evidence-weighted S/R orchestrator
    OiWallService,
    SrLevelObservationRepository,
    SrLevelTrackingService,
    SrEvidenceService,

    // ML pattern-quality data capture — persists detected patterns with their
    // realized ATR-follow-through outcome, building the training set for the
    // pattern-quality scorer. Backfill replays history; capture records live
    // detections; the resolver finalizes rows once their horizon completes.
    PatternObservationRepository,
    PatternBackfillService,
    PatternCaptureService,

    // Context scoring engine — Mama's 10-factor framework v1.
    // Each factor is registered as a provider so it can be unit-tested
    // independently. ContextScoringService receives the array via a
    // factory so we can plug factors in / out without touching the service.
    MtfTrendFactor,
    GreeksFactor,
    VolatilityFactor,
    SectorFactor,
    OiShiftFactor,
    FiiFactor,
    NasdaqFactor,
    CrudeOilFactor,
    GoldFactor,
    {
      provide: ContextScoringService,
      useFactory: (
        mtf: MtfTrendFactor,
        greeks: GreeksFactor,
        vol: VolatilityFactor,
        sector: SectorFactor,
        oi: OiShiftFactor,
        fii: FiiFactor,
        nasdaq: NasdaqFactor,
        crude: CrudeOilFactor,
        gold: GoldFactor,
      ) =>
        new ContextScoringService([
          mtf, greeks, vol, sector, oi, fii, nasdaq, crude, gold,
        ] satisfies ContextFactor[]),
      inject: [
        MtfTrendFactor, GreeksFactor, VolatilityFactor,
        SectorFactor, OiShiftFactor, FiiFactor, NasdaqFactor,
        CrudeOilFactor, GoldFactor,
      ],
    },
  ],
  exports: [
    SignalGeneratorService,
    SignalScoringService,
    StrategyRegistryService,
    StrategyParserService,
    StrategyExecutorService,
    StrategyStorageService,
    SignalRepository,
    LevelBookService,
    ExitPriceService,
    SetupTrackerService,
    ContextScoringService,
    MtfAlignmentService,
    SrEvidenceService,
  ],
})
export class SignalGeneratorModule {}
