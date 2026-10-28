import { Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AngelOneAdapterService } from '../market-data/services/angel-one-adapter.service';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { SignalIntakeRepository } from './repositories/signal-intake.repository';
import { SignalIntakeCron } from './services/signal-intake.cron';
import {
  eventEmitterAdapter,
  SIGNAL_EMITTER,
  SIGNAL_INTAKE_REPO,
  SIGNAL_MASTER,
  SIGNAL_VOCAB,
  SignalIntakeService,
  type MasterSource,
} from './services/signal-intake.service';
import {
  SIGNAL_CLOCK,
  SIGNAL_INFO_BARS,
  SIGNAL_INFO_MASTER,
  SIGNAL_INFO_VOCAB,
  SIGNAL_OUTCOME_BARS,
  SIGNAL_OUTCOME_REPO,
  SignalOutcomeService,
  type InfoBars,
  type OutcomeBars,
} from './services/signal-outcome.service';
import { SIGNAL_INFO_LLM, SIGNAL_LLM, SignalParseLlmService } from './services/signal-parse-llm.service';
import { SIGNAL_VISION, SignalVisionService } from './services/signal-vision.service';
import { SignalVocabularyService } from './services/signal-vocabulary.service';
import { SetupWatchService } from './services/setup-watch.service';
import { SignalWatchService } from './services/signal-watch.service';
import { parseSignalIntakeConfig, SIGNAL_INTAKE_CONFIG, type SignalIntakeConfig } from './signal-intake.config';

/**
 * Stream S — Telegram signal intake (docs/superpowers/plans/2026-10-23-telegram-signals-contract.md).
 *
 * Listens to stream R's `telegram.message` (EventEmitterModule.forRoot() is registered once, in the
 * root module), classifies every message, writes trade_signals / signal_clusters /
 * signal_message_classes, and emits `signal.ready` / `signal.update` for stream X. It places nothing:
 * no order, no paper trade. The LLM fallback uses only the sentinel's shared (non-reserved) slot.
 */
@Module({
  imports: [PrismaModule, AiGatewayModule, TradeSentinelModule, MarketDataModule],
  providers: [
    { provide: SIGNAL_INTAKE_CONFIG, useFactory: (): SignalIntakeConfig => parseSignalIntakeConfig(process.env) },
    { provide: SIGNAL_CLOCK, useFactory: () => makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE) },
    SignalIntakeRepository,
    { provide: SIGNAL_INTAKE_REPO, useExisting: SignalIntakeRepository },
    { provide: SIGNAL_OUTCOME_REPO, useExisting: SignalIntakeRepository },
    SignalVocabularyService,
    { provide: SIGNAL_VOCAB, useExisting: SignalVocabularyService },
    {
      // The broker's in-memory scrip master (24 h cache, shared with the rest of the app).
      provide: SIGNAL_MASTER,
      useFactory: (adapter: AngelOneAdapterService): MasterSource => ({ rows: () => adapter.getInstrumentMaster() }),
      inject: [AngelOneAdapterService],
    },
    SignalParseLlmService,
    { provide: SIGNAL_LLM, useExisting: SignalParseLlmService },
    { provide: SIGNAL_INFO_LLM, useExisting: SignalParseLlmService },
    SignalVisionService,
    { provide: SIGNAL_VISION, useExisting: SignalVisionService },
    { provide: SIGNAL_EMITTER, useFactory: (ee: EventEmitter2) => eventEmitterAdapter(ee), inject: [EventEmitter2] },
    {
      // 5-minute bars over the OWNER's own Angel session (paced by the session's historical gate).
      provide: SIGNAL_OUTCOME_BARS,
      useFactory: (feeds: UserFeedManager, cfg: SignalIntakeConfig): OutcomeBars => ({
        fetch: async (exchange, token, from, to) => {
          if (!cfg.ownerUserId) return [];
          const rows = await feeds.fetchCandles(cfg.ownerUserId, token, exchange, '5m', from, to);
          return (rows ?? []).map((c) => ({ ts: c.timestamp.getTime(), high: c.high, low: c.low, close: c.close }));
        },
      }),
      inject: [UserFeedManager, SIGNAL_INTAKE_CONFIG],
    },
    {
      // Daily bars for the CHANNEL_INFO outcome (index / NSE cash / nearest MCX future), owner's own session.
      provide: SIGNAL_INFO_BARS,
      useFactory: (feeds: UserFeedManager, cfg: SignalIntakeConfig): InfoBars => ({
        daily: async (exchange, token, from, to) => {
          if (!cfg.ownerUserId) return [];
          const rows = await feeds.fetchCandles(cfg.ownerUserId, token, exchange, '1d', from, to);
          return (rows ?? []).map((c) => ({
            day: new Date(c.timestamp.getTime() + 330 * 60_000).toISOString().slice(0, 10),
            high: c.high,
            low: c.low,
            close: c.close,
          }));
        },
      }),
      inject: [UserFeedManager, SIGNAL_INTAKE_CONFIG],
    },
    { provide: SIGNAL_INFO_MASTER, useExisting: SIGNAL_MASTER },
    { provide: SIGNAL_INFO_VOCAB, useExisting: SignalVocabularyService },
    SignalIntakeService,
    SignalOutcomeService,
    SignalIntakeCron,
    SignalWatchService,
    SetupWatchService,
  ],
  exports: [SignalIntakeService, SIGNAL_INTAKE_CONFIG],
})
export class SignalIntakeModule {}
