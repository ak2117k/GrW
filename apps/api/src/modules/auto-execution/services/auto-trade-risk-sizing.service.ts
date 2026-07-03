import { Injectable } from '@nestjs/common';
import type { PublicSignal } from '../../signal-fanout/dto/public-signal.dto';

/**
 * Per-user risk limits, sourced from the `AutoTradeConsent` row
 * (`riskPerTrade` / `maxCapital`). Both are absolute rupee amounts:
 *  - `riskPerTrade` — the maximum ₹ the user is willing to lose on the stop
 *    for a single trade (NOT a percentage).
 *  - `maxCapital` — the maximum ₹ notional the user will deploy on a single
 *    trade.
 */
export interface PerUserRiskLimits {
  riskPerTrade: number;
  maxCapital: number;
}

/** A successfully sized order (whole lots only). */
export interface SizedOrder {
  /** Number of whole lots (>= 1). */
  lots: number;
  /** lots * lotSize — the order quantity in units. */
  quantity: number;
  /** Absolute stop price derived from `stopPct` (BUY: below entry). */
  stopLoss: number;
  /** Absolute target price derived from `targetPct` (BUY: above entry). */
  target: number;
}

/** A rejected sizing (even 1 lot breaches risk or capital, or bad input). */
export interface RejectedOrder {
  rejected: true;
  reason: string;
}

export type SizingResult = SizedOrder | RejectedOrder;

/** Round a rupee price to paise (2 dp) for a clean, stable stop/target. */
function toPaise(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * AutoTradeRiskSizingService — TDA-011 per-user position sizing.
 *
 * PURE and DETERMINISTIC: no DB, no I/O, no side effects. It does per-user
 * *sizing* only; it is NOT the risk backstop. `RiskManagerService` remains the
 * shared hard backstop (global daily-loss / kill-switch / capital gates) and is
 * unchanged by this service.
 *
 * Sizing (for a long/BUY anand signal):
 *   stopLoss    = entryPrice * (1 - stopPct/100)
 *   target      = entryPrice * (1 + targetPct/100)
 *   perUnitRisk = entryPrice - stopLoss   (= entryPrice * stopPct/100)
 *   unitsByRisk = floor(riskPerTrade / perUnitRisk)   — cap ₹ risked on the stop
 *   unitsByCap  = floor(maxCapital  / entryPrice)     — cap ₹ notional deployed
 *   maxUnits    = min(unitsByRisk, unitsByCap)
 *   lots        = floor(maxUnits / lotSize)           — round DOWN to whole lots
 *   quantity    = lots * lotSize
 * If `lots < 1` (even one lot would breach the risk budget or the capital cap),
 * the trade is rejected with the binding reason.
 */
@Injectable()
export class AutoTradeRiskSizingService {
  /**
   * Size a single order for one user. Returns either a whole-lot
   * {@link SizedOrder} or a {@link RejectedOrder} with a human-readable reason.
   * Never throws for out-of-range inputs — it rejects instead — so the caller
   * can audit `ORDER_REJECTED{reason}` uniformly.
   */
  sizeOrder(
    signal: PublicSignal,
    limits: PerUserRiskLimits,
    lotSize: number,
  ): SizingResult {
    const { entryPrice, stopPct, targetPct } = signal;
    const { riskPerTrade, maxCapital } = limits;

    // --- Input validation (reject, never throw) ---
    if (!Number.isFinite(lotSize) || lotSize < 1) {
      return { rejected: true, reason: `Invalid lot size: ${lotSize}` };
    }
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return { rejected: true, reason: `Invalid entry price: ${entryPrice}` };
    }
    if (!Number.isFinite(stopPct) || stopPct <= 0) {
      return {
        rejected: true,
        reason: `Non-positive stop distance (stopPct=${stopPct}) — cannot size risk`,
      };
    }
    if (!Number.isFinite(riskPerTrade) || riskPerTrade <= 0) {
      return {
        rejected: true,
        reason: `Invalid per-user riskPerTrade: ${riskPerTrade}`,
      };
    }
    if (!Number.isFinite(maxCapital) || maxCapital <= 0) {
      return {
        rejected: true,
        reason: `Invalid per-user maxCapital: ${maxCapital}`,
      };
    }

    // --- Derive stop / target / per-unit risk (BUY, long) ---
    const perUnitRisk = (entryPrice * stopPct) / 100;
    const stopLoss = toPaise(entryPrice - perUnitRisk);
    const target = toPaise(entryPrice * (1 + targetPct / 100));

    // --- Size: min(risk-based, capital-based), then round down to lots ---
    // A small epsilon absorbs binary floating-point drift so an exact integer
    // boundary (e.g. 500.0000000001 or 499.9999999999) floors as intended.
    const EPS = 1e-9;
    const unitsByRisk = Math.floor(riskPerTrade / perUnitRisk + EPS);
    const unitsByCapital = Math.floor(maxCapital / entryPrice + EPS);
    const maxUnits = Math.min(unitsByRisk, unitsByCapital);
    const lots = Math.floor(maxUnits / lotSize + EPS);

    if (lots < 1) {
      // Report the binding constraint for a single lot.
      const oneLotRisk = lotSize * perUnitRisk;
      const oneLotCapital = lotSize * entryPrice;
      const reason =
        oneLotRisk > riskPerTrade
          ? `1 lot risks ₹${toPaise(oneLotRisk)} which exceeds riskPerTrade ₹${riskPerTrade}`
          : `1 lot needs ₹${toPaise(oneLotCapital)} capital which exceeds maxCapital ₹${maxCapital}`;
      return { rejected: true, reason };
    }

    return {
      lots,
      quantity: lots * lotSize,
      stopLoss,
      target,
    };
  }
}
