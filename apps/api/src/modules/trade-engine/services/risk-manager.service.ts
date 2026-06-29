import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../settings/services/settings.service';
import { TradeRepository } from '../repositories/trade.repository';
import { PaperTradeService } from './paper-trade.service';
import {
  ExecuteTradeDto,
  RiskValidation,
  DailyRiskStatus,
} from '../dto/trade.dto';
import {
  MARKET_OPEN_HOUR,
  MARKET_OPEN_MINUTE,
  MARKET_CLOSE_HOUR,
  MARKET_CLOSE_MINUTE,
  MCX_OPEN_HOUR,
  MCX_OPEN_MINUTE,
  MCX_CLOSE_HOUR,
  MCX_CLOSE_MINUTE,
} from '@td/shared/constants';
import { formatTradeRejection } from '../../../common/utils/trade-rejection-log';

/**
 * Risk Manager Service
 *
 * NON-NEGOTIABLE safety layer. Every trade MUST pass through validateTrade()
 * before execution. This service cannot be bypassed.
 */
@Injectable()
export class RiskManagerService {
  private readonly logger = new Logger(RiskManagerService.name);

  /** Kill switch state — when active, ALL trades are rejected. */
  private killSwitchActive = false;
  private killSwitchReason = '';
  private killSwitchTimestamp: Date | null = null;

  /** Running total of today's unrealized P&L (updated externally). */
  private currentUnrealizedPnl = 0;

  /** Capital currently deployed in open positions. */
  private currentCapitalDeployed = 0;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly tradeRepository: TradeRepository,
    private readonly paperTradeService: PaperTradeService,
  ) {}

  /**
   * Validate a trade request against ALL risk rules.
   * ALL checks must pass. Returns { allowed: false, reason } on first failure.
   */
  async validateTrade(request: ExecuteTradeDto): Promise<RiskValidation> {
    // 0. Kill switch — absolute first check, no exceptions
    if (this.killSwitchActive) {
      const reason = `Kill switch active: ${this.killSwitchReason}`;
      this.logger.warn(
        formatTradeRejection({
          symbol: request.symbol,
          side: request.side,
          stage: 'execution',
          reason,
        }),
      );
      return {
        allowed: false,
        reason,
      };
    }

    const settings = await this.settingsService.getSettings();

    // 1. Max daily loss check
    const dailyLossCheck = await this.checkMaxDailyLoss(
      settings.maxDailyLoss,
      request,
    );
    if (!dailyLossCheck.allowed) return dailyLossCheck;

    // 2. Max concurrent positions check
    const positionCheck = await this.checkMaxConcurrentPositions(
      settings.maxConcurrentPositions,
      request,
    );
    if (!positionCheck.allowed) return positionCheck;

    // 3. Max capital per trade check
    const capitalCheck = this.checkMaxCapitalPerTrade(
      request,
      settings.maxCapitalPerTrade,
    );
    if (!capitalCheck.allowed) return capitalCheck;

    // 3b. Available paper cash check — paper BUY orders cannot exceed the
    // virtual cash balance. SELL orders are not gated here: closing a long
    // returns cash, and opening a short credits cash. This mirrors what a
    // real brokerage margin engine would reject before the order leaves.
    if (settings.paperTrading && request.side === 'BUY') {
      const paperCashCheck = this.checkPaperCashSufficient(request);
      if (!paperCashCheck.allowed) return paperCashCheck;
    }

    // 4. Market hours check
    if (settings.tradingHoursOnly) {
      const hoursCheck = this.checkMarketHours(request);
      if (!hoursCheck.allowed) return hoursCheck;
    }

    // 5. Duplicate position check
    const duplicateCheck = await this.checkDuplicatePosition(request);
    if (!duplicateCheck.allowed) return duplicateCheck;

    this.logger.log(
      `Trade validated: ${request.side} ${request.symbol} x${request.quantity}`,
    );
    return { allowed: true };
  }

  /**
   * Check if kill switch is currently active.
   */
  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  /**
   * Activate the kill switch. This immediately blocks ALL new trades.
   * The caller is responsible for closing existing positions.
   */
  activateKillSwitch(reason: string): void {
    this.killSwitchActive = true;
    this.killSwitchReason = reason;
    this.killSwitchTimestamp = new Date();
    this.logger.error(
      `KILL SWITCH ACTIVATED: ${reason} at ${this.killSwitchTimestamp.toISOString()}`,
    );
  }

  /**
   * Deactivate the kill switch. Should only be done manually/deliberately.
   */
  deactivateKillSwitch(): void {
    this.logger.warn('Kill switch DEACTIVATED');
    this.killSwitchActive = false;
    this.killSwitchReason = '';
    this.killSwitchTimestamp = null;
  }

  /**
   * Update the current unrealized P&L (called by PositionManagerService).
   */
  updateUnrealizedPnl(unrealizedPnl: number): void {
    this.currentUnrealizedPnl = unrealizedPnl;
  }

  /**
   * Update capital currently deployed in open positions.
   */
  updateCapitalDeployed(capital: number): void {
    this.currentCapitalDeployed = capital;
  }

  /**
   * Get a snapshot of the current daily risk status.
   */
  async getDailyRiskStatus(): Promise<DailyRiskStatus> {
    const settings = await this.settingsService.getSettings();
    const realizedPnl = await this.tradeRepository.getDailyPnL(new Date());
    const openTrades = await this.tradeRepository.getOpenTrades();
    const totalDailyLoss = realizedPnl + this.currentUnrealizedPnl;

    // Capital deployed = summed entry value of every open trade. Derived
    // from the open trades (not the mutable currentCapitalDeployed counter,
    // which only advances on a matching tick) so it is restart-safe and
    // consistent with positionsUsed.
    const capitalDeployed = openTrades.reduce(
      (sum, t) => sum + (t.entryPrice ?? 0) * t.quantity,
      0,
    );

    return {
      dailyLossUsed: Math.abs(Math.min(0, totalDailyLoss)),
      dailyLossLimit: settings.maxDailyLoss,
      positionsUsed: openTrades.length,
      positionsLimit: settings.maxConcurrentPositions,
      capitalDeployed,
      capitalLimit: settings.maxCapitalPerTrade * settings.maxConcurrentPositions,
      killSwitchActive: this.killSwitchActive,
    };
  }

  // ------------------------------------------------------------------
  //  Private risk checks
  // ------------------------------------------------------------------

  private async checkMaxDailyLoss(
    maxDailyLoss: number,
    request: ExecuteTradeDto,
  ): Promise<RiskValidation> {
    const realizedPnl = await this.tradeRepository.getDailyPnL(new Date());
    const totalDailyPnl = realizedPnl + this.currentUnrealizedPnl;

    // If total P&L is negative and exceeds the max daily loss threshold
    if (totalDailyPnl < 0 && Math.abs(totalDailyPnl) >= maxDailyLoss) {
      const reason = `Max daily loss limit reached: loss=${Math.abs(totalDailyPnl).toFixed(2)}, limit=${maxDailyLoss}`;
      this.logger.warn(
        formatTradeRejection({
          symbol: request.symbol,
          side: request.side,
          stage: 'execution',
          reason,
        }),
      );
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  private async checkMaxConcurrentPositions(
    maxPositions: number,
    request: ExecuteTradeDto,
  ): Promise<RiskValidation> {
    const openTrades = await this.tradeRepository.getOpenTrades();

    if (openTrades.length >= maxPositions) {
      const reason = `Max concurrent positions reached: ${openTrades.length}/${maxPositions}`;
      this.logger.warn(
        formatTradeRejection({
          symbol: request.symbol,
          side: request.side,
          stage: 'execution',
          reason,
        }),
      );
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  private checkMaxCapitalPerTrade(
    request: ExecuteTradeDto,
    maxCapital: number,
  ): RiskValidation {
    const estimatedPrice = request.price ?? request.triggerPrice ?? 0;
    const orderValue = estimatedPrice * request.quantity;

    if (orderValue > maxCapital) {
      const reason = `Order value ${orderValue.toFixed(2)} exceeds max capital per trade: ${maxCapital}`;
      this.logger.warn(
        formatTradeRejection({
          symbol: request.symbol,
          side: request.side,
          stage: 'execution',
          reason,
        }),
      );
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  /**
   * Paper-only: reject BUY orders that exceed the available virtual cash.
   * For MARKET orders, request.price is often undefined — we fall back to
   * triggerPrice. If we still can't estimate (both undefined), we allow
   * the order through and let the simulator fill it; the worst case is a
   * temporary negative balance until next tick triggers PositionManager.
   */
  private checkPaperCashSufficient(
    request: ExecuteTradeDto,
  ): RiskValidation {
    const estimatedPrice = request.price ?? request.triggerPrice ?? 0;
    if (estimatedPrice <= 0) {
      // Cannot estimate — let the simulator handle it. Logged so we notice
      // if this is happening often and need a better price source.
      this.logger.debug(
        `Paper cash check skipped — no estimable price for ${request.symbol} ` +
          `(price=${request.price}, triggerPrice=${request.triggerPrice})`,
      );
      return { allowed: true };
    }
    const orderValue = estimatedPrice * request.quantity;
    const available = this.paperTradeService.getVirtualBalance();
    if (orderValue > available) {
      const reason =
        `Insufficient paper cash: need ₹${orderValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}, ` +
        `available ₹${available.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
      this.logger.warn(
        formatTradeRejection({
          symbol: request.symbol,
          side: request.side,
          stage: 'execution',
          reason,
        }),
      );
      return { allowed: false, reason };
    }
    return { allowed: true };
  }

  private checkMarketHours(request: ExecuteTradeDto): RiskValidation {
    // Resting paper orders (LIMIT / STOPLOSS) are exempt from the trading-hours
    // gate: their whole point is to sit unfilled until price reaches them, and
    // the paper engine only fills them on live ticks (which arrive during market
    // hours anyway). This lets a trader stage a resting order after hours for
    // the next session. MARKET orders still need a live fill, and LIVE orders
    // (isPaper === false) still respect hours + the LIVE_TRADING_ENABLED gate.
    const isResting =
      request.orderType === 'LIMIT' ||
      request.orderType === 'STOPLOSS' ||
      request.orderType === 'STOPLOSS_MARKET';
    const isPaperOrder = request.isPaper !== false; // missing ⇒ paper-safe default
    if (isResting && isPaperOrder) {
      return { allowed: true };
    }

    const exchange = request.exchange;
    const now = new Date();
    // Convert to IST (UTC+5:30)
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const timeInMinutes = hours * 60 + minutes;

    let openMinutes: number;
    let closeMinutes: number;

    if (exchange === 'MCX') {
      openMinutes = MCX_OPEN_HOUR * 60 + MCX_OPEN_MINUTE;
      closeMinutes = MCX_CLOSE_HOUR * 60 + MCX_CLOSE_MINUTE;
    } else {
      openMinutes = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
      closeMinutes = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;
    }

    if (timeInMinutes < openMinutes || timeInMinutes > closeMinutes) {
      const reason = `Outside trading hours for ${exchange}: current IST ${hours}:${String(minutes).padStart(2, '0')}, market ${Math.floor(openMinutes / 60)}:${String(openMinutes % 60).padStart(2, '0')}-${Math.floor(closeMinutes / 60)}:${String(closeMinutes % 60).padStart(2, '0')}`;
      this.logger.warn(
        formatTradeRejection({
          symbol: request.symbol,
          side: request.side,
          stage: 'execution',
          reason,
        }),
      );
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  private async checkDuplicatePosition(
    request: ExecuteTradeDto,
  ): Promise<RiskValidation> {
    const openTrades = await this.tradeRepository.getOpenTrades();

    const duplicate = openTrades.find(
      (trade) =>
        (trade as any).instrument?.symbol === request.symbol &&
        (trade as any).instrument?.exchange === request.exchange &&
        trade.side === request.side,
    );

    if (duplicate) {
      const reason = `Duplicate position: already have an open ${request.side} position in ${request.symbol} on ${request.exchange}`;
      this.logger.warn(
        formatTradeRejection({
          symbol: request.symbol,
          side: request.side,
          stage: 'execution',
          reason,
        }),
      );
      return { allowed: false, reason };
    }

    return { allowed: true };
  }
}
