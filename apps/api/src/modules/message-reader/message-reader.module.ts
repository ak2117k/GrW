import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SignalIntakeModule } from '../signal-intake/signal-intake.module';
import { SignalTraderModule } from '../signal-trader/signal-trader.module';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { MessageReaderController } from './controllers/message-reader.controller';
import { MESSAGE_READER_CONFIG, parseMessageReaderConfig, type MessageReaderConfig } from './message-reader.config';
import { MessageReaderRepository } from './repositories/message-reader.repository';
import { MessageReaderLlm } from './services/message-reader-llm.service';
import { MESSAGE_READER_CLOCK, MessageReaderCron } from './services/message-reader.cron';
import { MessageReaderService } from './services/message-reader.service';
import { READER_PACKET_SOURCES } from './services/reader-packet.sources';
import { ReaderPacketService } from './services/reader-packet.service';

/**
 * AI message reader (docs/superpowers/specs/2026-11-25-ai-message-reader-design.md): every Telegram post
 * (image posts after the vision read) is read by the AI against our live data → message_readings.
 * Listens to `telegram.message` and `signal.vision.done`; places nothing, emits nothing. A 5-minute check
 * alerts ops when posts arrive and nothing is read; in `on` mode confirmed market-wide claims alert the owner.
 * GET /api/message-reader/health and /notes (owner only).
 * MESSAGE_READER=off (default) | shadow | on; also off unless AI agents are on.
 * SignalIntakeModule supplies the pre-filter vocabulary (it must never import this module).
 */
@Module({
  imports: [PrismaModule, AiGatewayModule, TradeSentinelModule, MarketDataModule, SignalTraderModule, SignalIntakeModule],
  controllers: [MessageReaderController],
  providers: [
    { provide: MESSAGE_READER_CONFIG, useFactory: (): MessageReaderConfig => parseMessageReaderConfig(process.env) },
    MessageReaderRepository,
    { provide: READER_PACKET_SOURCES, useExisting: MessageReaderRepository },
    ReaderPacketService,
    MessageReaderLlm,
    MessageReaderService,
    // NSE trading days for the 5-minute dead-reader check (holidays included).
    { provide: MESSAGE_READER_CLOCK, useFactory: () => makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE) },
    MessageReaderCron,
  ],
  exports: [MessageReaderService, MessageReaderRepository, MESSAGE_READER_CONFIG],
})
export class MessageReaderModule {}
