import { Injectable, Logger } from '@nestjs/common';
import { TickData } from '../../../common/interfaces/broker-adapter.interface';
import {
  MarketDataRepository,
  SaveCandleInput,
} from '../repositories/market-data.repository';
import { TIMEFRAMES } from '@td/shared/constants';

/** Timeframes we aggregate in real-time. */
const AGGREGATED_TIMEFRAMES = [
  TIMEFRAMES.ONE_MIN,
  TIMEFRAMES.FIVE_MIN,
  TIMEFRAMES.FIFTEEN_MIN,
  TIMEFRAMES.ONE_HOUR,
] as const;

type AggregatedTimeframe = (typeof AGGREGATED_TIMEFRAMES)[number];

/** In-memory representation of a building candle. */
interface BuildingCandle {
  instrumentId: string;
  token: string;
  timeframe: string;
  periodStart: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Callback type for when a candle closes.
 * The MarketFeedService registers a listener so it can push candle updates
 * to the gateway and Redis.
 */
export type CandleCloseCallback = (candle: SaveCandleInput & { token: string }) => void;

@Injectable()
export class CandleAggregatorService {
  private readonly logger = new Logger(CandleAggregatorService.name);

  /**
   * Map<compositeKey, BuildingCandle> where compositeKey = `${token}:${timeframe}`
   */
  private readonly candles = new Map<string, BuildingCandle>();

  /** Token-to-instrumentId mapping cache — populated from InstrumentService. */
  private readonly tokenInstrumentMap = new Map<string, string>();

  /** Registered listeners for candle close events. */
  private readonly onCloseListeners: CandleCloseCallback[] = [];

  constructor(private readonly repository: MarketDataRepository) {}

  /**
   * Register a callback that fires whenever a candle closes.
   */
  onCandleClose(callback: CandleCloseCallback): void {
    this.onCloseListeners.push(callback);
  }

  /**
   * Set the mapping from a token to its database instrument ID.
   * Must be called before ticks arrive for that token.
   */
  setTokenInstrumentId(token: string, instrumentId: string): void {
    this.tokenInstrumentMap.set(token, instrumentId);
  }

  /**
   * Core method: process an incoming tick and update all timeframe candles.
   */
  processTick(tick: TickData): void {
    const instrumentId = this.tokenInstrumentMap.get(tick.token);

    for (const tf of AGGREGATED_TIMEFRAMES) {
      const key = `${tick.token}:${tf}`;
      const periodStart = this.getPeriodStart(tick.timestamp, tf);
      const existing = this.candles.get(key);

      if (existing && existing.periodStart.getTime() === periodStart.getTime()) {
        // Same candle period — update OHLCV
        existing.high = Math.max(existing.high, tick.ltp);
        existing.low = Math.min(existing.low, tick.ltp);
        existing.close = tick.ltp;
        existing.volume += tick.volume;
      } else {
        // Period boundary crossed — close previous candle if it exists
        if (existing && instrumentId) {
          this.closeCandle(existing);
        }

        // Start a new candle
        this.candles.set(key, {
          instrumentId: instrumentId ?? '',
          token: tick.token,
          timeframe: tf,
          periodStart,
          open: tick.ltp,
          high: tick.ltp,
          low: tick.ltp,
          close: tick.ltp,
          volume: tick.volume,
        });
      }
    }
  }

  /**
   * Get the current (still building) candle for a token and timeframe.
   */
  getCurrentCandle(
    token: string,
    timeframe: string,
  ): BuildingCandle | null {
    return this.candles.get(`${token}:${timeframe}`) ?? null;
  }

  /**
   * Flush all open candles to the database. Called on shutdown or end of day.
   */
  async flushAll(): Promise<void> {
    const toSave: SaveCandleInput[] = [];

    for (const candle of this.candles.values()) {
      if (candle.instrumentId) {
        toSave.push({
          instrumentId: candle.instrumentId,
          timeframe: candle.timeframe,
          timestamp: candle.periodStart,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        });
      }
    }

    if (toSave.length > 0) {
      try {
        const saved = await this.repository.saveCandles(toSave);
        this.logger.log(`Flushed ${saved} candles to database`);
      } catch (error) {
        this.logger.error(
          `Failed to flush candles: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    this.candles.clear();
  }

  /**
   * Close a single candle: persist to DB and notify listeners.
   */
  private closeCandle(candle: BuildingCandle): void {
    const saveInput: SaveCandleInput = {
      instrumentId: candle.instrumentId,
      timeframe: candle.timeframe,
      timestamp: candle.periodStart,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };

    // Persist asynchronously — don't block tick processing
    this.repository.saveCandles([saveInput]).catch((err) => {
      this.logger.error(
        `Failed to persist closed candle ${candle.token}:${candle.timeframe}: ${err instanceof Error ? err.message : err}`,
      );
    });

    // Notify listeners (MarketFeedService -> Gateway)
    const payload = { ...saveInput, token: candle.token };
    for (const listener of this.onCloseListeners) {
      try {
        listener(payload);
      } catch (err) {
        this.logger.error(
          `Candle close listener error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /**
   * Calculate the start of the period for a given timestamp and timeframe.
   */
  private getPeriodStart(timestamp: Date, timeframe: AggregatedTimeframe): Date {
    const d = new Date(timestamp);
    const minutes = d.getMinutes();
    const hours = d.getHours();

    // Zero out seconds and milliseconds
    d.setSeconds(0, 0);

    switch (timeframe) {
      case TIMEFRAMES.ONE_MIN:
        // Already floored to the minute
        break;

      case TIMEFRAMES.FIVE_MIN:
        d.setMinutes(minutes - (minutes % 5));
        break;

      case TIMEFRAMES.FIFTEEN_MIN:
        d.setMinutes(minutes - (minutes % 15));
        break;

      case TIMEFRAMES.ONE_HOUR:
        d.setMinutes(0);
        d.setHours(hours);
        break;

      default:
        break;
    }

    return d;
  }
}
