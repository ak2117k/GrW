import { Logger } from '@nestjs/common';

/**
 * Ruling J2: how ChartinkProcessService reaches the core without importing TradeCoreModule (the
 * kill-gate pattern). This file must stay free of runtime imports beyond @nestjs/common's Logger.
 */
export interface ChartinkHit {
  alertId: string;
  /** As Chartink sent it (bare, e.g. RELIANCE): the exposure underlying. */
  symbol: string;
  /** The instrument master's trading symbol (e.g. RELIANCE-EQ): the traded symbol. */
  tradingSymbol: string;
  token: string;
  exchange: 'NSE';
  hitPrice: number;
  scanName: string | null;
  /** The silo pipeline's direction (sector trend, stock-trend fallback). */
  side: 'BUY' | 'SELL';
  /** The silo pipeline's 0–100 Chartink score. */
  score: number;
  /** When the core was handed the hit (not the alert time). */
  receivedAt: Date;
  /**
   * When the Chartink alert itself was stored (ChartinkAlert.receivedAt), so a hit handed off late, or
   * re-run by Bull after a restart, can be judged by its real age. null when it could not be read
   * (the intake then fails closed).
   */
  alertAt: Date | null;
}

export interface CoreAlertIntake {
  /** Queues the hit. Must not block; may throw (the hand-off swallows it). */
  accept(hit: ChartinkHit): void;
}

const logger = new Logger('CoreAlertHandoff');
let intake: CoreAlertIntake | null = null;

export function setCoreAlertIntake(next: CoreAlertIntake | null): void {
  intake = next;
}

export function currentCoreAlertIntake(): CoreAlertIntake | null {
  return intake;
}

/** Fire-and-forget: never throws, never awaits. With no intake registered (entries off) it does nothing. */
export function handOffChartinkHit(hit: ChartinkHit): void {
  const target = intake;
  if (!target) return;
  try {
    target.accept(hit);
  } catch (err) {
    logger.warn(`core intake refused ${hit.symbol} from alert ${hit.alertId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
