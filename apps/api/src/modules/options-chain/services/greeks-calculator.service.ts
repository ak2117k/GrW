import { Injectable } from '@nestjs/common';

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/** Default risk-free rate: India 10Y govt bond yield */
const DEFAULT_RISK_FREE_RATE = 0.065;

@Injectable()
export class GreeksCalculatorService {
  /**
   * Cumulative standard normal distribution function.
   * Uses the rational approximation from Abramowitz & Stegun (26.2.17).
   */
  normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;

    const t = 1.0 / (1.0 + p * x);
    const y =
      1.0 -
      ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Standard normal probability density function.
   */
  private normalPDF(x: number): number {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2.0 * Math.PI);
  }

  /**
   * Black-Scholes theoretical option price.
   * @param spot     Current underlying price
   * @param strike   Option strike price
   * @param time     Time to expiry in years
   * @param rate     Risk-free interest rate (default 6.5%)
   * @param vol      Implied volatility (e.g., 0.20 for 20%)
   * @param type     'CE' for call, 'PE' for put
   */
  blackScholesPrice(
    spot: number,
    strike: number,
    time: number,
    rate: number = DEFAULT_RISK_FREE_RATE,
    vol: number,
    type: 'CE' | 'PE',
  ): number {
    if (time <= 0) {
      // At or past expiry — intrinsic value only
      return type === 'CE'
        ? Math.max(spot - strike, 0)
        : Math.max(strike - spot, 0);
    }

    const d1 =
      (Math.log(spot / strike) + (rate + (vol * vol) / 2) * time) /
      (vol * Math.sqrt(time));
    const d2 = d1 - vol * Math.sqrt(time);

    if (type === 'CE') {
      return (
        spot * this.normalCDF(d1) -
        strike * Math.exp(-rate * time) * this.normalCDF(d2)
      );
    } else {
      return (
        strike * Math.exp(-rate * time) * this.normalCDF(-d2) -
        spot * this.normalCDF(-d1)
      );
    }
  }

  /**
   * Calculate option Greeks using the Black-Scholes model.
   * @param spotPrice     Current underlying price
   * @param strikePrice   Option strike price
   * @param timeToExpiry  Time to expiry in years
   * @param riskFreeRate  Risk-free rate (default 6.5%)
   * @param iv            Implied volatility (decimal, e.g., 0.20)
   * @param optionType    'CE' or 'PE'
   */
  calculateGreeks(
    spotPrice: number,
    strikePrice: number,
    timeToExpiry: number,
    riskFreeRate: number = DEFAULT_RISK_FREE_RATE,
    iv: number,
    optionType: 'CE' | 'PE' = 'CE',
  ): Greeks {
    if (timeToExpiry <= 0 || iv <= 0) {
      return { delta: 0, gamma: 0, theta: 0, vega: 0 };
    }

    const sqrtT = Math.sqrt(timeToExpiry);
    const d1 =
      (Math.log(spotPrice / strikePrice) +
        (riskFreeRate + (iv * iv) / 2) * timeToExpiry) /
      (iv * sqrtT);
    const d2 = d1 - iv * sqrtT;

    const nd1 = this.normalCDF(d1);
    const nd2 = this.normalCDF(d2);
    const pdf_d1 = this.normalPDF(d1);

    // Gamma is the same for calls and puts
    const gamma = pdf_d1 / (spotPrice * iv * sqrtT);

    // Vega is the same for calls and puts (per 1% move in vol)
    const vega = (spotPrice * pdf_d1 * sqrtT) / 100;

    let delta: number;
    let theta: number;

    if (optionType === 'CE') {
      delta = nd1;

      theta =
        (-(spotPrice * pdf_d1 * iv) / (2 * sqrtT) -
          riskFreeRate *
            strikePrice *
            Math.exp(-riskFreeRate * timeToExpiry) *
            nd2) /
        365;
    } else {
      delta = nd1 - 1;

      theta =
        (-(spotPrice * pdf_d1 * iv) / (2 * sqrtT) +
          riskFreeRate *
            strikePrice *
            Math.exp(-riskFreeRate * timeToExpiry) *
            this.normalCDF(-d2)) /
        365;
    }

    return {
      delta: Math.round(delta * 10000) / 10000,
      gamma: Math.round(gamma * 10000) / 10000,
      theta: Math.round(theta * 100) / 100,
      vega: Math.round(vega * 100) / 100,
    };
  }

  /**
   * Calculate Implied Volatility using Newton-Raphson iteration.
   * @param optionPrice   Market price of the option
   * @param spotPrice     Current underlying price
   * @param strikePrice   Option strike price
   * @param timeToExpiry  Time to expiry in years
   * @param riskFreeRate  Risk-free rate (default 6.5%)
   * @param optionType    'CE' or 'PE'
   * @returns Implied volatility as a decimal (e.g., 0.20 = 20%)
   */
  calculateIV(
    optionPrice: number,
    spotPrice: number,
    strikePrice: number,
    timeToExpiry: number,
    riskFreeRate: number = DEFAULT_RISK_FREE_RATE,
    optionType: 'CE' | 'PE',
  ): number {
    if (timeToExpiry <= 0 || optionPrice <= 0) {
      return 0;
    }

    const MAX_ITERATIONS = 100;
    const TOLERANCE = 1e-6;

    // Initial guess using Brenner-Subrahmanyam approximation
    let vol = Math.sqrt((2 * Math.PI) / timeToExpiry) * (optionPrice / spotPrice);
    if (vol <= 0 || !isFinite(vol)) vol = 0.3;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const price = this.blackScholesPrice(
        spotPrice,
        strikePrice,
        timeToExpiry,
        riskFreeRate,
        vol,
        optionType,
      );

      const diff = price - optionPrice;
      if (Math.abs(diff) < TOLERANCE) break;

      // Vega = dPrice/dVol
      const sqrtT = Math.sqrt(timeToExpiry);
      const d1 =
        (Math.log(spotPrice / strikePrice) +
          (riskFreeRate + (vol * vol) / 2) * timeToExpiry) /
        (vol * sqrtT);
      const vega = spotPrice * this.normalPDF(d1) * sqrtT;

      if (vega < 1e-12) break;

      vol = vol - diff / vega;

      // Clamp to reasonable bounds
      if (vol <= 0.001) vol = 0.001;
      if (vol > 5.0) vol = 5.0;
    }

    return Math.round(vol * 10000) / 10000;
  }

  /**
   * Calculate time to expiry in years from now to the expiry date.
   */
  getTimeToExpiry(expiryDate: Date | string): number {
    const expiry =
      typeof expiryDate === 'string' ? new Date(expiryDate) : expiryDate;
    const now = new Date();
    const diffMs = expiry.getTime() - now.getTime();
    if (diffMs <= 0) return 0;
    return diffMs / (365.25 * 24 * 60 * 60 * 1000);
  }
}
