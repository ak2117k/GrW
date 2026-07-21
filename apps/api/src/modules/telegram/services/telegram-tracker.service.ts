import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { TelegramRepository } from '../repositories/telegram.repository';
import { InstrumentService } from '../../market-data/services/instrument.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { TelegramGateway } from '../gateways/telegram.gateway';
import { Bar, EvalSignal, evaluateDirectional, evaluateLeveled } from './outcome-eval';

// Stored candle timeframes are '1d'/'15m' (packages/shared TIMEFRAMES) — NOT
// '1day'/'15minute'. Using the wrong string returns zero rows from getCandles,
// which would silently EXPIRE every tracked equity/future signal.
const TF_SWING = '1d';
const TF_INTRADAY = '15m';

const DEFAULT_INTRADAY = { winPct: 3, lossPct: 2 };
const DEFAULT_SWING = { winPct: 8, lossPct: 5 };

@Injectable()
export class TelegramTrackerService {
  private readonly logger = new Logger(TelegramTrackerService.name);
  constructor(
    private readonly repo: TelegramRepository,
    private readonly instruments: InstrumentService,
    private readonly marketRepo: MarketDataRepository,
    private readonly options: OptionsChainService,
    private readonly gateway: TelegramGateway,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/60 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollActive(): Promise<void> {
    const active = await this.repo.findActiveSignals();
    for (const s of active) {
      try {
        await this.evaluateOne(s.id);
      } catch (e) {
        this.logger.warn(`evaluate ${s.id} failed: ${(e as Error).message}`);
      }
    }
  }

  async evaluateOne(signalId: string): Promise<void> {
    const s: any = await this.repo.findSignal(signalId);
    if (!s || !['PENDING', 'ACTIVE'].includes(s.status)) return;

    const bars = await this.loadBars(s);
    if (bars == null) {
      // Untrackable (e.g. option with no live premium / past window, missing token).
      await this.markUntrackable(signalId);
      return;
    }

    // Directional and CMP-entry signals arrive ACTIVE with no entryPrice — the
    // PENDING→ACTIVE branch that seeds entries never runs for them, and
    // evaluateDirectional early-returns ACTIVE while entryPrice is null. Seed the
    // entry from the first available candle close (≈ post-time price) so they can
    // actually reach TARGET_HIT/SL_HIT. LEVELED-with-zone signals seed their own
    // entry via evaluateLeveled and are left untouched.
    if (
      s.entryPrice == null &&
      (s.signalType === 'DIRECTIONAL' || s.entryMode === 'CMP') &&
      bars.length > 0
    ) {
      const seededEntry = bars[0].close;
      await this.repo.transition(signalId, {
        entryPrice: seededEntry, entryFilledAt: bars[0].timestamp,
      });
      await this.repo.addEvent({ signalId, type: 'ENTRY_FILLED', price: seededEntry });
      s.entryPrice = seededEntry;
    }

    const evalSig: EvalSignal = {
      side: s.side, signalType: s.signalType, entryLow: s.entryLow, entryHigh: s.entryHigh,
      entryMode: s.entryMode, stopLoss: s.stopLoss, slMode: s.slMode, targets: s.targets,
      entryPrice: s.entryPrice, horizon: s.horizon,
    };
    const th = this.config.get<{ winPct: number; lossPct: number }>(
      `telegram.directional.${s.horizon === 'SWING' ? 'swing' : 'intraday'}`,
    ) ?? (s.horizon === 'SWING' ? DEFAULT_SWING : DEFAULT_INTRADAY);
    const r = s.signalType === 'DIRECTIONAL'
      ? evaluateDirectional(evalSig, bars, th)
      : evaluateLeveled(evalSig, bars);

    // Terminal outcome — persist, log an event, broadcast.
    if (r.status === 'TARGET_HIT' || r.status === 'SL_HIT') {
      await this.repo.transition(signalId, {
        status: r.status, entryPrice: r.entryPrice ?? s.entryPrice, entryFilledAt: r.entryFilledAt,
        exitPrice: r.exitPrice, exitAt: r.exitAt, hitTargetIndex: r.hitTargetIndex ?? null,
        resultPct: r.resultPct,
      });
      await this.repo.addEvent({
        signalId, type: r.status, price: r.exitPrice, note: `result ${r.resultPct?.toFixed(2)}%`,
      });
      this.gateway.emit('signal-update', { id: signalId, status: r.status, resultPct: r.resultPct });
      return;
    }

    // Not terminal — expire past-window signals, else advance PENDING → ACTIVE.
    if (s.trackExpiresAt && Date.now() > new Date(s.trackExpiresAt).getTime()) {
      await this.repo.transition(signalId, { status: 'EXPIRED', entryPrice: r.entryPrice ?? s.entryPrice });
      await this.repo.addEvent({ signalId, type: 'EXPIRED' });
      this.gateway.emit('signal-update', { id: signalId, status: 'EXPIRED' });
      return;
    }
    if (r.status === 'ACTIVE' && s.status === 'PENDING') {
      await this.repo.transition(signalId, {
        status: 'ACTIVE', entryPrice: r.entryPrice, entryFilledAt: r.entryFilledAt,
      });
      await this.repo.addEvent({ signalId, type: 'ENTRY_FILLED', price: r.entryPrice });
    }
  }

  /** Returns candle bars for the signal's window, or null if untrackable. */
  private async loadBars(s: any): Promise<Bar[] | null> {
    if (s.instrument === 'OPTION') {
      // Phase 1: live premium only. A fully-past window has no stored option
      // candles → untrackable. When live, sample the current premium as a 1-bar.
      const past = s.trackExpiresAt && Date.now() > new Date(s.trackExpiresAt).getTime();
      if (past || !s.expiry) return null;
      const ltp = await this.options.getLiveOptionLtp(
        s.symbol, new Date(s.expiry).toISOString(), s.strike, s.optionType);
      if (ltp == null) return null;
      const now = new Date();
      return [{ high: ltp, low: ltp, close: ltp, timestamp: now }];
    }
    if (!s.token) return null;
    const inst = await this.instruments.getByToken(s.token);
    if (!inst) return null;
    const tf = s.horizon === 'SWING' ? TF_SWING : TF_INTRADAY;
    const to = s.trackExpiresAt
      ? new Date(Math.min(Date.now(), new Date(s.trackExpiresAt).getTime()))
      : new Date();
    const bars = await this.marketRepo.getCandles(inst.id, tf, new Date(s.createdAt), to);
    return (bars ?? []).map((b: any) => ({
      high: Number(b.high), low: Number(b.low), close: Number(b.close), timestamp: new Date(b.timestamp),
    }));
  }

  private async markUntrackable(signalId: string): Promise<void> {
    await this.repo.transition(signalId, { status: 'UNTRACKABLE' });
    await this.repo.addEvent({ signalId, type: 'UNTRACKABLE', note: 'no price history available' });
  }
}
