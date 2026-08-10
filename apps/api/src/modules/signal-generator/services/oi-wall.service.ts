import { Injectable, Logger, Optional } from '@nestjs/common';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import type { LevelCandidate } from '../types/evidence-level.types';

/**
 * OI walls: the strikes with the most open interest act as magnets/walls.
 * Top call-OI strike = resistance, top put-OI strike = support. F&O underlyings
 * only — a cash stock has no chain, so `walls()` returns []. Never throws.
 */
@Injectable()
export class OiWallService {
  private readonly logger = new Logger(OiWallService.name);

  /**
   * Symbols already warned about, so a 60s chart poll logs the cause ONCE
   * instead of every minute. Keyed by symbol+cause so a changed cause is
   * still reported.
   */
  private readonly warned = new Set<string>();

  constructor(@Optional() private readonly optionsChain?: OptionsChainService) {}

  /**
   * Report WHY there are no OI walls, exactly once per symbol+cause.
   *
   * This exists because the failure used to be a `logger.debug` inside a catch,
   * which at production log levels is silence. "This stock has no options" and
   * "the chain fetch failed" then looked identical from the outside: the
   * evidence array simply had no OI kinds, the barrier ranking fell through to
   * bare levels, and every projection came out as an ATR guess with no way to
   * find out why. A missing input must be loud — the same empty-vs-failed rule
   * the rest of this pipeline runs on.
   *
   * `no-options` stays at debug: a cash stock having no chain is a fact, not a
   * fault, and warning on it would bury the real failures.
   */
  private report(symbol: string, cause: string, detail?: string): void {
    const key = `${symbol}:${cause}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    const msg = `OI walls unavailable for ${symbol}: ${cause}${detail ? ` — ${detail}` : ''}`;
    if (cause === 'no-options') this.logger.debug(msg);
    else this.logger.warn(msg);
  }

  async walls(symbol: string, ltp: number): Promise<LevelCandidate[]> {
    if (!this.optionsChain || !symbol) {
      this.report(symbol || '(no symbol)', 'options-chain service not wired');
      return [];
    }
    try {
      const expiries = await this.optionsChain.getExpiries(symbol);
      if (!expiries || expiries.length === 0) return []; // cash stock — no OI
      const chain = await this.optionsChain.getOptionsChain(symbol, expiries[0]);
      if (!Array.isArray(chain) || chain.length === 0) return [];

      // Only OTM OI forms a wall: call OI above spot caps upside (resistance),
      // put OI below spot floors downside (support). A high-OI ITM strike (call
      // below spot / put above spot) is not a barrier in the usual sense and was
      // previously mis-sided by the downstream price-vs-spot split — exclude it
      // here at the source, where the call/put semantics are known. ltp<=0 (no
      // spot) disables the filter rather than dropping every wall.
      const hasSpot = ltp > 0;
      const calls = chain
        .map((e: any) => ({ price: e.strikePrice, oi: e.ceData?.oi ?? 0 }))
        .filter((x) => x.oi > 0 && (!hasSpot || x.price > ltp))
        .sort((a, b) => b.oi - a.oi || b.price - a.price);
      const puts = chain
        .map((e: any) => ({ price: e.strikePrice, oi: e.peData?.oi ?? 0 }))
        .filter((x) => x.oi > 0 && (!hasSpot || x.price < ltp))
        .sort((a, b) => b.oi - a.oi || a.price - b.price);

      const out: LevelCandidate[] = [];
      const ranks = [30, 20];
      calls.slice(0, 2).forEach((c, i) => out.push({ price: c.price, kind: 'OI_CALL', score: ranks[i] }));
      puts.slice(0, 2).forEach((p, i) => out.push({ price: p.price, kind: 'OI_PUT', score: ranks[i] }));
      return out;
    } catch (err) {
      this.logger.debug(`OI walls failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /**
   * Richer OI-flow read of the chain. Returns the static OI walls (identical to
   * `walls()`) PLUS:
   *   - one MAX_PAIN candidate at the max-pain strike (option-writer payoff
   *     minimum — acts as an expiry magnet/pin), and
   *   - up to 2 OI_CHANGE candidates at the strikes with the largest fresh OI
   *     BUILD-UP (sided OTM like the static walls — call build-up above spot is
   *     resistance, put build-up below spot is support).
   *
   * OI_CHANGE is skipped cleanly when the chain carries no change-in-OI data
   * (no fields to read → no candidates), so it never fabricates a level.
   *
   * F&O underlyings only; non-F&O / failure → []. Never throws.
   */
  async wallsExtended(symbol: string, ltp: number): Promise<LevelCandidate[]> {
    if (!this.optionsChain) {
      this.report(symbol || '(no symbol)', 'options-chain service not wired');
      return [];
    }
    if (!symbol) {
      this.report('(no symbol)', 'caller passed no underlying');
      return [];
    }
    try {
      const expiries = await this.optionsChain.getExpiries(symbol);
      if (!expiries || expiries.length === 0) {
        // A cash stock genuinely has no chain. Fact, not fault.
        this.report(symbol, 'no-options');
        return [];
      }
      const chain = await this.optionsChain.getOptionsChain(symbol, expiries[0]);
      if (!Array.isArray(chain) || chain.length === 0) {
        // Expiries exist but the chain is empty — this IS a fault, and the one
        // most likely to be hiding here: the underlying is an F&O name whose
        // chain could not be served.
        this.report(symbol, 'chain empty', `expiry ${expiries[0]}`);
        return [];
      }

      const out: LevelCandidate[] = [];
      out.push(...this.staticWalls(chain, ltp));
      const maxPain = this.maxPainCandidate(chain);
      if (maxPain) out.push(maxPain);
      out.push(...this.oiChangeWalls(chain, ltp));

      if (out.length === 0) {
        // A chain that carries no usable OI at all — every strike zero, or the
        // spot filter excluded everything. Distinct from a failed fetch.
        this.report(symbol, 'chain carries no open interest', `${chain.length} strikes, ltp ${ltp}`);
      }
      return out;
    } catch (err) {
      this.report(symbol, 'fetch failed', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Pure static-wall computation, mirroring `walls()` exactly: top-2 OTM call
   * strikes (30/20) as resistance, top-2 OTM put strikes (30/20) as support.
   */
  private staticWalls(chain: any[], ltp: number): LevelCandidate[] {
    const hasSpot = ltp > 0;
    const calls = chain
      .map((e: any) => ({ price: e.strikePrice, oi: e.ceData?.oi ?? 0 }))
      .filter((x) => x.oi > 0 && (!hasSpot || x.price > ltp))
      .sort((a, b) => b.oi - a.oi || b.price - a.price);
    const puts = chain
      .map((e: any) => ({ price: e.strikePrice, oi: e.peData?.oi ?? 0 }))
      .filter((x) => x.oi > 0 && (!hasSpot || x.price < ltp))
      .sort((a, b) => b.oi - a.oi || a.price - b.price);

    const out: LevelCandidate[] = [];
    const ranks = [30, 20];
    calls.slice(0, 2).forEach((c, i) => out.push({ price: c.price, kind: 'OI_CALL', score: ranks[i] }));
    puts.slice(0, 2).forEach((p, i) => out.push({ price: p.price, kind: 'OI_PUT', score: ranks[i] }));
    return out;
  }

  /**
   * Classic max-pain: the strike where total option-writer payoff is minimized
   * if price expired there. CE writers lose (expiry-strike)*CE_OI above each
   * strike; PE writers lose (strike-expiry)*PE_OI below it. The `totalPain > 0`
   * guard avoids the trivial "lowest strike wins with zero pain" degenerate case
   * when the chain carries no OI. Returns null when no max-pain can be found.
   */
  private maxPainCandidate(chain: any[]): LevelCandidate | null {
    if (chain.length === 0) return null;
    const strikes = chain.map((e: any) => e.strikePrice);
    let minPain = Infinity;
    let maxPainStrike = 0;

    for (const testStrike of strikes) {
      let totalPain = 0;
      for (const entry of chain) {
        const ceOi = entry.ceData?.oi ?? 0;
        const peOi = entry.peData?.oi ?? 0;
        if (testStrike > entry.strikePrice) {
          totalPain += (testStrike - entry.strikePrice) * ceOi;
        }
        if (testStrike < entry.strikePrice) {
          totalPain += (entry.strikePrice - testStrike) * peOi;
        }
      }
      if (totalPain > 0 && totalPain < minPain) {
        minPain = totalPain;
        maxPainStrike = testStrike;
      }
    }

    if (maxPainStrike <= 0) return null;
    return { price: maxPainStrike, kind: 'MAX_PAIN', score: 25 };
  }

  /**
   * Up to 2 OI_CHANGE candidates at the strikes with the largest fresh OI
   * build-up, sided OTM like the static walls (call build-up above spot, put
   * build-up below spot). Mirrors the static 30/20 rank weighting. If the chain
   * exposes no change-in-OI (all zero/absent), this returns [] — no fabrication.
   */
  private oiChangeWalls(chain: any[], ltp: number): LevelCandidate[] {
    const hasSpot = ltp > 0;
    const callBuilds = chain
      .map((e: any) => ({ price: e.strikePrice, build: e.ceData?.oiChange ?? 0 }))
      .filter((x) => x.build > 0 && (!hasSpot || x.price > ltp));
    const putBuilds = chain
      .map((e: any) => ({ price: e.strikePrice, build: e.peData?.oiChange ?? 0 }))
      .filter((x) => x.build > 0 && (!hasSpot || x.price < ltp));

    const combined = [...callBuilds, ...putBuilds].sort(
      (a, b) => b.build - a.build || a.price - b.price,
    );

    const ranks = [30, 20];
    return combined
      .slice(0, 2)
      .map((c, i) => ({ price: c.price, kind: 'OI_CHANGE' as const, score: ranks[i] }));
  }
}
