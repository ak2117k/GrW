import { Injectable } from '@nestjs/common';
import type { RiskStateProvider } from '../risk-wall/ports';
import { exposureOf } from '../risk-wall/risk-wall';
import type { RiskLiveState, RiskOpenPosition } from '../risk-wall/risk-wall.types';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import { PaperLedgerService } from './paper-ledger.service';

/** An option tradingsymbol ends in its type, after the strike digit (trade-sentinel/charges.ts OPTION_SUFFIX). */
const OPTION_TYPE = /\d(CE|PE)$/;

/** A ledger amount string as rupees; anything unparseable is unknown (null), which the wall rejects. */
function rupees(s: string): number | null {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
}

/**
 * RISK_STATE_PROVIDER from the paper ledger (spec §4.7). Deployed capital, open
 * positions, today's entries and today's net realised P&L are real. Until M4 marks
 * positions to market, openPnl is null and every position is unpriced, so the Risk Wall
 * keeps rejecting entries (PNL_UNKNOWN): fail closed, and visibly so in every verdict.
 * Positions are not strategy-tagged before M4/M5 (strategyId '' and no per-strategy
 * P&L), and the daily-loss latch is M5's. A ledger read that fails throws, and
 * RiskWallService turns that into a CONTEXT_UNAVAILABLE reject.
 */
@Injectable()
export class PaperRiskStateProvider implements RiskStateProvider {
  constructor(private readonly ledger: PaperLedgerService) {}

  async liveState(userId: string, at: Date): Promise<RiskLiveState> {
    const [funds, positions, day] = await Promise.all([this.ledger.funds(userId), this.ledger.positions(userId), this.ledger.dayStats(userId, at)]);
    const openPositions: RiskOpenPosition[] = positions.map((p) => {
      const optionType = p.vehicle === 'OPTIONS_BUY' ? ((OPTION_TYPE.exec(p.instrument.symbol.toUpperCase())?.[1] as 'CE' | 'PE' | undefined) ?? null) : null;
      return {
        positionId: p.key,
        strategyId: '',
        vehicle: p.vehicle,
        symbol: p.instrument.symbol,
        underlying: p.instrument.underlying ?? p.instrument.symbol,
        direction: exposureOf(p.vehicle, p.direction === 'LONG' ? 'BUY' : 'SELL', optionType),
        state: 'OPEN',
        priced: false,
      };
    });
    return {
      asOf: at,
      openPositions,
      realisedPnlToday: day.netPnlToday.toNumber(),
      openPnl: null,
      pnlTodayByStrategy: {},
      tradesToday: day.entriesToday,
      deployedCapital: Object.fromEntries(VEHICLES.map((v) => [v, rupees(funds.deployedByVehicle[v])])) as Record<Vehicle, number | null>,
      dailyLossLatched: false,
    };
  }
}
