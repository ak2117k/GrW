import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LevelBookService } from './level-book.service';
import { SignalRepository, CreateSignalInput } from '../repositories/signal.repository';
import { LevelsContextStrategy } from '../strategies/levels-context.strategy';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { InstrumentService } from '../../market-data/services/instrument.service';
import { OptionStrikeSelectorService } from '../../options-chain/services/option-strike-selector.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { CandleData } from '../../../common/interfaces/trading-strategy.interface';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * AsymmetricScannerService
 *
 * Scans a hardcoded F&O hotlist (50 most-liquid NSE stocks) every 15
 * minutes during market hours and surfaces only setups with R:R ≥ 5.
 * Reuses LevelsContextStrategy with includeGradeC=true and rrFloor=5.0.
 * Persists winners with strategy='asymmetric-edge' so they don't mix
 * with the existing universe-scanner output.
 */
const FNO_HOTLIST: Array<{ token: string; symbol: string }> = [
  { token: '2885',   symbol: 'RELIANCE'   },
  { token: '11536',  symbol: 'TCS'        },
  { token: '1333',   symbol: 'HDFCBANK'   },
  { token: '1594',   symbol: 'INFY'       },
  { token: '4963',   symbol: 'ICICIBANK'  },
  { token: '3045',   symbol: 'SBIN'       },
  { token: '1660',   symbol: 'ITC'        },
  { token: '11630',  symbol: 'NTPC'       },
  { token: '910',    symbol: 'BHARTIARTL' },
  { token: '1922',   symbol: 'KOTAKBANK'  },
  { token: '2475',   symbol: 'ONGC'       },
  { token: '1232',   symbol: 'GAIL'       },
  { token: '13538',  symbol: 'TITAN'      },
  { token: '1394',   symbol: 'HINDUNILVR' },
  { token: '236',    symbol: 'ASIANPAINT' },
  { token: '17963',  symbol: 'NESTLEIND'  },
  { token: '5258',   symbol: 'M&M'        },
  { token: '6364',   symbol: 'WIPRO'      },
  { token: '1363',   symbol: 'HINDALCO'   },
  { token: '13404',  symbol: 'BAJFINANCE' },
  { token: '11483',  symbol: 'LT'         },
  { token: '467',    symbol: 'HCLTECH'    },
  { token: '15083',  symbol: 'POWERGRID'  },
  { token: '3456',   symbol: 'TATAMOTORS' },
  { token: '3499',   symbol: 'TATASTEEL'  },
  { token: '2031',   symbol: 'MARUTI'     },
  { token: '11532',  symbol: 'ULTRACEMCO' },
  { token: '14977',  symbol: 'SUNPHARMA'  },
  { token: '17939',  symbol: 'PIDILITIND' },
  { token: '1850',   symbol: 'JSWSTEEL'   },
  { token: '5900',   symbol: 'AXISBANK'   },
  { token: '739',    symbol: 'BAJAJFINSV' },
  { token: '157',    symbol: 'APOLLOHOSP' },
  { token: '317',    symbol: 'BAJAJ-AUTO' },
  { token: '20374',  symbol: 'COALINDIA'  },
  { token: '11250',  symbol: 'BPCL'       },
  { token: '2963',   symbol: 'HEROMOTOCO' },
  { token: '1964',   symbol: 'EICHERMOT'  },
  { token: '7229',   symbol: 'BRITANNIA'  },
  { token: '11005',  symbol: 'CIPLA'      },
  { token: '881',    symbol: 'DIVISLAB'   },
  { token: '526',    symbol: 'INDUSINDBK' },
  { token: '14299',  symbol: 'TECHM'      },
  { token: '11184',  symbol: 'SBILIFE'    },
  { token: '14366',  symbol: 'HDFCLIFE'   },
  { token: '2664',   symbol: 'ADANIPORTS' },
  { token: '7929',   symbol: 'GRASIM'     },
  { token: '9819',   symbol: 'IOC'        },
  { token: '6705',   symbol: 'TATACONSUM' },
];

const RR_FLOOR = 5.0;
const THROTTLE_MS = 200; // between symbols, to respect Angel One rate limits
const TIMEFRAME = '15m';
const CANDLE_LOOKBACK_DAYS = 5;
const MIN_CANDLES = 25;
const SCAN_WINDOW_OPEN_IST = '09:30';
const SCAN_WINDOW_CLOSE_IST = '14:30';

export interface AsymmetricSignalResult {
  symbol: string;
  token: string;
  side: 'BUY' | 'SELL';
  entry: number;
  stoploss: number;
  target: number;
  rr: number;
  atr14: number;
  grade: string;
  reason: string;
  signalId: string | null;
  strikeRec: {
    strike: number;
    side: 'CE' | 'PE';
    expiry: string;
    ltp: number;
    delta: number;
    iv: number;
    expectedProfitPerLot: number;
  } | null;
}

@Injectable()
export class AsymmetricScannerService {
  private readonly logger = new Logger(AsymmetricScannerService.name);
  private lastScanAt: Date | null = null;
  private lastResultCount = 0;
  private isRunning = false;

  constructor(
    private readonly levelBookService: LevelBookService,
    private readonly signalRepository: SignalRepository,
    private readonly marketDataRepository: MarketDataRepository,
    private readonly angelOneAdapter: AngelOneAdapterService,
    private readonly marketFeedService: MarketFeedService,
    private readonly prisma: PrismaService,
    @Optional() private readonly instrumentService?: InstrumentService,
    @Optional()
    private readonly optionStrikeSelector?: OptionStrikeSelectorService | null,
    @Optional()
    private readonly optionsChainService?: OptionsChainService | null,
  ) {}

  getStatus(): { lastScanAt: Date | null; lastResultCount: number; isRunning: boolean } {
    return {
      lastScanAt: this.lastScanAt,
      lastResultCount: this.lastResultCount,
      isRunning: this.isRunning,
    };
  }

  /**
   * Cron: every 15 minutes Mon-Fri. The runScan() method itself
   * short-circuits outside the 09:30-14:30 IST window and on weekends so
   * the cron can fire safely all day.
   */
  @Cron('*/15 * * * 1-5', { timeZone: 'Asia/Kolkata' })
  async cronScan(): Promise<void> {
    try {
      await this.runScan();
    } catch (err) {
      this.logger.error(
        `Asymmetric scan cron failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Run one full scan over the FNO hotlist. Returns the surfaced signals.
   * Off-hours or weekends: returns an empty array immediately.
   */
  async runScan(): Promise<AsymmetricSignalResult[]> {
    if (this.isRunning) {
      this.logger.warn('Asymmetric scan already running; skipping concurrent invocation');
      return [];
    }

    if (!this.marketFeedService.isMarketOpen()) {
      this.logger.debug('Asymmetric scan: market closed, skipping');
      return [];
    }

    const nowIst = this.computeNowIst();
    if (nowIst < SCAN_WINDOW_OPEN_IST || nowIst > SCAN_WINDOW_CLOSE_IST) {
      this.logger.debug(
        `Asymmetric scan: outside scan window (now=${nowIst}, window=${SCAN_WINDOW_OPEN_IST}-${SCAN_WINDOW_CLOSE_IST})`,
      );
      return [];
    }

    this.isRunning = true;
    const startedAt = Date.now();
    const results: AsymmetricSignalResult[] = [];

    try {
      for (const entry of FNO_HOTLIST) {
        try {
          const result = await this.scanSymbol(entry.token, entry.symbol);
          if (result) {
            results.push(result);
          }
        } catch (err) {
          this.logger.warn(
            `Asymmetric scan failed for ${entry.symbol}: ${err instanceof Error ? err.message : err}`,
          );
        }
        // Throttle between symbols to respect Angel One rate limits.
        await this.sleep(THROTTLE_MS);
      }

      this.lastScanAt = new Date();
      this.lastResultCount = results.length;
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      this.logger.log(
        `Asymmetric scan complete: ${results.length} winners from ${FNO_HOTLIST.length} symbols in ${elapsedSec}s`,
      );
    } finally {
      this.isRunning = false;
    }

    return results;
  }

  private async scanSymbol(
    token: string,
    symbol: string,
  ): Promise<AsymmetricSignalResult | null> {
    // 1. Lazy-load level book.
    const levelBook = await this.levelBookService.lazyLoad(token, 'NSE', symbol);
    if (!levelBook) {
      this.logger.debug(`[${symbol}] no level book available; skipping`);
      return null;
    }

    // 2. Fetch 25 most-recent 15m candles. Try DB first, broker fallback.
    const candles = await this.fetchCandles(token, symbol);
    if (candles.length < MIN_CANDLES) {
      this.logger.debug(
        `[${symbol}] insufficient candles (got ${candles.length}, need ${MIN_CANDLES}); skipping`,
      );
      return null;
    }

    // 3. Run LevelsContextStrategy with permissive params.
    const strategy = new LevelsContextStrategy();
    strategy.setParameters({ rrFloor: RR_FLOOR, includeGradeC: true });

    const nowIst = this.computeNowIst();
    const output = strategy.analyze({
      candles,
      levelBook,
      nowIst,
      nowMs: Date.now(),
    });

    if (!output) return null;

    const ctx = output.metadata as { atr14?: number; grade?: string };
    const atr14 = typeof ctx?.atr14 === 'number' ? ctx.atr14 : levelBook.atr14;
    if (!atr14 || atr14 <= 0) {
      this.logger.debug(`[${symbol}] atr14 not positive; skipping`);
      return null;
    }

    const slDist = Math.abs(output.entryPrice - output.stoplossPrice);
    if (slDist <= 0) return null;
    const targetDist = Math.abs(output.targetPrice - output.entryPrice);
    const rr = targetDist / slDist;
    if (rr < RR_FLOOR) {
      this.logger.debug(`[${symbol}] R:R ${rr.toFixed(2)} below floor ${RR_FLOOR}; skipping`);
      return null;
    }

    // 4. Pick best option strike (best-effort; stocks without F&O return null).
    const strikeRec = await this.computeStrikeRec(
      symbol,
      output.side,
      output.entryPrice,
      output.targetPrice,
    );

    // 5. Persist as Signal with strategy='asymmetric-edge'.
    let signalId: string | null = null;
    try {
      const instrumentId = await this.resolveInstrumentId(token, symbol);
      if (instrumentId) {
        const expectedProfit = Math.round(targetDist * 100) / 100;
        const expectedLoss = Math.round(slDist * 100) / 100;
        const rrRounded = Math.round(rr * 100) / 100;
        const grade = (ctx?.grade as string) ?? 'B';

        const input: CreateSignalInput = {
          instrumentId,
          side: output.side,
          entryPrice: output.entryPrice,
          targetPrice: output.targetPrice,
          stoplossPrice: output.stoplossPrice,
          expectedProfit,
          expectedLoss,
          riskRewardRatio: rrRounded,
          confidence: grade,
          confidenceScore: Math.min(100, Math.round(rr * 10)),
          strategy: 'asymmetric-edge',
          timeframe: TIMEFRAME,
          reason: output.reason,
          // Keep signals fresh for the rest of the session — re-use the
          // standard 4h floor; cron sweep will deactivate stale ones.
          expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        };

        // Use prisma directly so we can stuff our enriched setupContext
        // (strike rec + raw output metadata + token + symbol) into the
        // Json column. SignalRepository.createSignal doesn't expose
        // setupContext, so we replicate its shape inline.
        const created = await this.prisma.signal.create({
          data: {
            instrumentId: input.instrumentId,
            side: input.side,
            entryPrice: input.entryPrice,
            targetPrice: input.targetPrice,
            stoplossPrice: input.stoplossPrice,
            expectedProfit: input.expectedProfit,
            expectedLoss: input.expectedLoss,
            riskRewardRatio: input.riskRewardRatio,
            confidence: input.confidence,
            confidenceScore: input.confidenceScore,
            strategy: input.strategy,
            timeframe: input.timeframe,
            reason: input.reason,
            isActive: true,
            expiresAt: input.expiresAt ?? null,
            setupContext: {
              token,
              symbol,
              atr14,
              rr: rrRounded,
              entryPrice: output.entryPrice,
              targetPrice: output.targetPrice,
              stoplossPrice: output.stoplossPrice,
              strikeRec: strikeRec ?? null,
              levelsContext: output.metadata ?? null,
            } as Record<string, unknown>,
          },
        });
        signalId = created.id;
      } else {
        this.logger.debug(
          `[${symbol}] no instrument row found for token ${token}; skipping persistence`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[${symbol}] failed to persist asymmetric signal: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      symbol,
      token,
      side: output.side,
      entry: output.entryPrice,
      stoploss: output.stoplossPrice,
      target: output.targetPrice,
      rr: Math.round(rr * 100) / 100,
      atr14,
      grade: (ctx?.grade as string) ?? 'B',
      reason: output.reason,
      signalId,
      strikeRec,
    };
  }

  private async fetchCandles(token: string, symbol: string): Promise<CandleData[]> {
    const now = new Date();
    const from = new Date(now.getTime() - CANDLE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    let candles: CandleData[] = [];

    try {
      const instrument = await this.marketDataRepository.getInstrumentByToken(token);
      if (instrument) {
        const rows = await this.marketDataRepository.getCandles(
          instrument.id,
          TIMEFRAME,
          from,
          now,
          MIN_CANDLES,
        );
        candles = rows.map((c) => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
        }));
      }
    } catch (err) {
      this.logger.debug(
        `[${symbol}] DB candle fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (candles.length < MIN_CANDLES) {
      try {
        const broker = await this.angelOneAdapter.getHistoricalData(
          token,
          'NSE',
          TIMEFRAME,
          from,
          now,
        );
        candles = (broker as Array<Record<string, unknown>>).slice(-30).map((c) => ({
          timestamp: new Date(c.timestamp as string | number | Date),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume) || 0,
        }));
      } catch (err) {
        this.logger.debug(
          `[${symbol}] broker candle fetch failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return candles;
  }

  private async resolveInstrumentId(token: string, symbol: string): Promise<string | null> {
    // Try getInstrumentByToken first (matches the seeded universe).
    try {
      const inst = await this.marketDataRepository.getInstrumentByToken(token);
      if (inst) return inst.id;
    } catch {
      // fall through
    }

    // Fall back to symbol lookup on NSE.
    try {
      const matches = await this.marketDataRepository.searchInstruments(symbol, 'NSE');
      const exact = matches.find((m) => m.symbol === symbol);
      if (exact) return exact.id;
      if (matches.length > 0) return matches[0].id;
    } catch {
      // fall through
    }

    return null;
  }

  private async computeStrikeRec(
    symbol: string,
    side: 'BUY' | 'SELL',
    entry: number,
    target: number,
  ): Promise<AsymmetricSignalResult['strikeRec']> {
    if (!this.optionStrikeSelector || !this.optionsChainService) return null;
    try {
      const expiries = await this.optionsChainService.getExpiries(symbol);
      if (expiries.length === 0) return null;
      const expiry = expiries[0];
      const optionSide: 'CE' | 'PE' = side === 'BUY' ? 'CE' : 'PE';
      const sel = await this.optionStrikeSelector.selectBestStrike({
        underlying: symbol,
        expiry,
        side: optionSide,
      });
      if (!sel) return null;

      const targetMove = Math.abs(target - entry);
      const expectedProfitPerShare =
        sel.delta * targetMove + 0.5 * sel.gamma * targetMove * targetMove;
      // Lot size for stock options is unknown here without a DB lookup;
      // use 1 (per-share). The frontend can render per-lot if it has the
      // lot size. Returning per-share keeps it honest.
      const expectedProfitPerLot = Math.round(expectedProfitPerShare * 100) / 100;

      return {
        strike: sel.strikePrice,
        side: sel.side,
        expiry: sel.expiry,
        ltp: sel.ltp,
        delta: sel.delta,
        iv: sel.iv,
        expectedProfitPerLot,
      };
    } catch (err) {
      this.logger.debug(
        `[${symbol}] strike rec failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  private computeNowIst(): string {
    const now = new Date();
    const istParts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hh = istParts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = istParts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${hh === '24' ? '00' : hh}:${mm}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
