import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { TelegramRepository, CreateSignalInput } from '../repositories/telegram.repository';
import { InstrumentService } from '../../market-data/services/instrument.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { TelegramIngestDto } from '../dto/telegram-ingest.dto';

export interface TelegramTrackJobData {
  signalId: string;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DEFAULT_MIN_CONFIDENCE = 0.55;
const DEFAULT_SWING_TRACK_DAYS = 10;

@Injectable()
export class TelegramIngestService {
  private readonly logger = new Logger(TelegramIngestService.name);

  constructor(
    private readonly repo: TelegramRepository,
    @InjectQueue('telegram-track') private readonly queue: Queue<TelegramTrackJobData>,
    private readonly instruments: InstrumentService,
    private readonly options: OptionsChainService,
    private readonly config: ConfigService,
  ) {}

  async ingest(dto: TelegramIngestDto): Promise<{ messageId: string | null; signalId: string | null }> {
    const channel = await this.repo.upsertChannel(dto.channel);
    const parsed = dto.parsed as Record<string, any>;
    const isSignal = parsed?.isSignal === true;
    const minConfidence = this.minConfidence();
    const confident = (Number(parsed?.confidence) || 0) >= minConfidence;
    const parseStatus = !isSignal ? 'not-signal' : confident ? 'signal' : 'low-confidence';

    const msg = await this.repo.insertMessage({
      channelId: channel.id,
      tgMessageId: dto.message.tgMessageId,
      rawText: dto.message.rawText,
      postedAt: new Date(dto.message.postedAt),
      parseStatus,
      rawPayload: parsed as Prisma.InputJsonValue,
    });
    if (!msg) return { messageId: null, signalId: null }; // duplicate — idempotent

    await this.repo.advanceLastSeen(channel.id, dto.message.tgMessageId);
    if (!isSignal || !confident) return { messageId: msg.id, signalId: null };

    const token = await this.resolveToken(parsed);
    const input = this.toSignalInput(msg.id, channel.id, parsed, token, new Date(dto.message.postedAt));
    const sig = await this.repo.insertSignal(input);
    if (input.status !== 'UNTRACKABLE') {
      await this.queue.add('track', { signalId: sig.id });
    } else {
      await this.repo.addEvent({ signalId: sig.id, type: 'UNTRACKABLE', note: 'token/levels unresolved' });
    }
    return { messageId: msg.id, signalId: sig.id };
  }

  private minConfidence(): number {
    const configured = this.config.get<number>('telegram.minConfidence');
    // Guard against a misconfigured out-of-range threshold; confidence lives in [0,1].
    if (typeof configured === 'number' && configured >= 0 && configured <= 1) return configured;
    return DEFAULT_MIN_CONFIDENCE;
  }

  private async resolveToken(p: Record<string, any>): Promise<{ token: string; exchange: string } | null> {
    // Options are tracked live via premium (Task 6); their token is resolved there.
    if (p.instrument === 'OPTION') return null;
    const hits = await this.instruments.search(String(p.symbol), p.exchange ?? undefined);
    const exact = hits.find((h) => h.symbol?.toUpperCase() === String(p.symbol).toUpperCase()) ?? hits[0];
    return exact ? { token: exact.token, exchange: exact.exchange } : null;
  }

  private toSignalInput(
    messageId: string,
    channelId: string,
    p: Record<string, any>,
    resolved: { token: string; exchange: string } | null,
    postedAt: Date,
  ): CreateSignalInput {
    const isDirectional = p.signalType === 'DIRECTIONAL';
    const leveledUntrackable =
      p.signalType === 'LEVELED' &&
      p.slMode === 'NUMERIC' &&
      p.stopLoss == null &&
      (!Array.isArray(p.targets) || p.targets.length === 0);
    const tokenMissing = p.instrument !== 'OPTION' && !resolved;
    const status: CreateSignalInput['status'] =
      tokenMissing || leveledUntrackable
        ? 'UNTRACKABLE'
        : isDirectional || p.entryMode === 'CMP'
          ? 'ACTIVE'
          : 'PENDING';

    return {
      messageId,
      channelId,
      symbol: String(p.symbol ?? ''),
      token: resolved?.token ?? null,
      exchange: resolved?.exchange ?? p.exchange ?? null,
      instrument: p.instrument,
      side: p.side,
      optionType: p.optionType ?? null,
      strike: p.strike ?? null,
      expiry: p.expiry ? new Date(p.expiry) : null,
      signalType: p.signalType,
      entryMode: p.entryMode,
      entryLow: p.entryLow ?? null,
      entryHigh: p.entryHigh ?? null,
      slMode: p.slMode,
      stopLoss: p.stopLoss ?? null,
      targets: Array.isArray(p.targets) ? p.targets : [],
      horizon: p.horizon,
      parseConfidence: Number(p.confidence) || 0,
      status,
      entryPrice: null,
      trackExpiresAt: this.computeExpiry(postedAt, p.horizon),
    };
  }

  private computeExpiry(postedAt: Date, horizon: string): Date {
    if (horizon === 'SWING') {
      const days = this.config.get<number>('telegram.swingTrackDays') ?? DEFAULT_SWING_TRACK_DAYS;
      return new Date(postedAt.getTime() + days * 24 * 3600_000);
    }
    // INTRADAY → 15:30 IST of the posted day.
    const ist = new Date(postedAt.getTime() + IST_OFFSET_MS);
    const midnightUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
    return new Date(midnightUtc + (15 * 60 + 30) * 60_000 - IST_OFFSET_MS);
  }
}
