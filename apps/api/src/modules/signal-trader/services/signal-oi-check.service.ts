import { Injectable, Logger } from '@nestjs/common';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import { oiCheck, wantedLean, type OiCheck, type OiCheckInput } from '../domain/oi-check';
import type { EntryPlan } from '../domain/gate';
import type { SignalView } from '../domain/signal.types';

export interface OiCheckRequest {
  decisionId: string;
  signal: Pick<SignalView, 'underlying' | 'instrumentKind' | 'strike'>;
  plan: Pick<EntryPlan, 'exchange' | 'side' | 'ltp'>;
  /** The traded contract's expiry YYYY-MM-DD (null for cash). */
  expiry: string | null;
  at: Date;
}

const MIN = 60_000;
/** Option expiries tried: the traded one first, then the nearest ones, until one has snapshots. */
const MAX_EXPIRIES = 3;
/** A chain snapshot's spot older than this does not centre the strikes. */
const CHAIN_SPOT_MAX_AGE_MIN = 20;
/** A 1m close older than this does not centre the strikes. */
const MINUTE_SPOT_MAX_AGE_MIN = 10;
/** oi_snapshots fetched: the session's first 90 min (the "open" snapshot) and the 45 min before the trade. */
const OPEN_FETCH_MIN = 90;
const RECENT_FETCH_MIN = 45;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** IST midnight of `at`'s IST day, plus `minutes`. */
function istDayAt(at: Date, minutes: number): Date {
  const ymd = new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return new Date(new Date(`${ymd}T00:00:00+05:30`).getTime() + minutes * MIN);
}

/**
 * The OI check of a paper trade's open (domain/oi-check), RECORD ONLY. SignalPaperService fires it
 * after the trade exists and does not await it, so it can never block, delay or change the trade.
 * Reads the database only — oi_snapshots, the instrument master, option_chain_snapshots and the
 * hub's candles_1m — never the broker. Any failure is stored as NO_DATA with the error.
 */
@Injectable()
export class SignalOiCheckService {
  private readonly logger = new Logger(SignalOiCheckService.name);

  constructor(private readonly repo: SignalTraderRepository) {}

  /** Compute and store; never throws. */
  async record(r: OiCheckRequest): Promise<OiCheck> {
    let check: OiCheck;
    try {
      check = oiCheck(await this.input(r));
    } catch (e) {
      const error = errText(e);
      check = { verdict: 'NO_DATA', source: 'NONE', want: wantedLean(r.signal.instrumentKind, r.plan.side), at: r.at.toISOString(), summary: `NO_DATA: error ${error}`, error };
    }
    try {
      await this.repo.recordOiCheck(r.decisionId, check);
      this.logger.log(`[signal-oi] ${r.signal.underlying} ${r.signal.instrumentKind} ${r.plan.side} (decision ${r.decisionId}): ${check.summary}`);
    } catch (e) {
      this.logger.warn(`[signal-oi] could not store the OI check for ${r.decisionId}: ${errText(e)}`);
    }
    return check;
  }

  async input(r: OiCheckRequest): Promise<OiCheckInput> {
    const name = String(r.signal.underlying ?? '').toUpperCase();
    const kind = r.signal.instrumentKind;
    const mcx = String(r.plan.exchange).toUpperCase() === 'MCX';
    const sessionStart = istDayAt(r.at, mcx ? 9 * 60 : 9 * 60 + 15);
    const today = istDayAt(r.at, 0);
    const windows: Array<[Date, Date]> = [
      [sessionStart, new Date(sessionStart.getTime() + OPEN_FETCH_MIN * MIN)],
      [new Date(r.at.getTime() - RECENT_FETCH_MIN * MIN), r.at],
    ];
    const fut = await this.repo.nearestFuture(name, today);
    const under = await this.underlyingRef(name, mcx, fut);
    return {
      at: r.at,
      want: wantedLean(kind, r.plan.side),
      sessionStart,
      chain: await this.chain(r, name, today, windows, under),
      futures: fut ? await this.futures(r, fut, sessionStart, windows, under) : null,
    };
  }

  /** The underlying's own price line: the index, an MCX option's nearest future, a stock's cash line. */
  private async underlyingRef(name: string, mcx: boolean, fut: { exchange: string; token: string; symbol: string } | null) {
    const index = INDEX_UNDERLYINGS[name];
    if (index) return { exchange: index.exchange, token: index.token, label: `candles_1m ${index.symbol}` };
    if (mcx) return fut ? { exchange: fut.exchange, token: fut.token, label: `candles_1m ${fut.symbol}` } : null;
    const cash = await this.repo.cashRef(name);
    return cash ? { exchange: cash.exchange, token: cash.token, label: `candles_1m ${cash.symbol}` } : null;
  }

  private async chain(r: OiCheckRequest, name: string, today: Date, windows: Array<[Date, Date]>, under: { exchange: string; token: string; label: string } | null): Promise<OiCheckInput['chain']> {
    const expiries = await this.repo.optionExpiries(name, today);
    if (expiries.length === 0) return null;
    const option = r.signal.instrumentKind === 'CE' || r.signal.instrumentKind === 'PE';
    const order = [...(option && r.expiry && expiries.includes(r.expiry) ? [r.expiry] : []), ...expiries.filter((e) => e !== r.expiry)].slice(0, MAX_EXPIRIES);
    const { center, centerSource } = await this.center(r, name, under);
    for (const expiry of order) {
      const contracts = await this.repo.optionContracts(name, expiry);
      if (contracts.length === 0) continue;
      const rows = await this.repo.oiRows(contracts.map((c) => c.instrumentId), windows);
      if (rows.length === 0) continue;
      return { expiry, contracts, rows, center, centerSource };
    }
    return null;
  }

  /**
   * The price the near-money strikes centre on: a FUT / EQ trade's own LTP → a chain snapshot ≤ 20 min
   * → the underlying's last 1m close ≤ 10 min → the traded strike (channel calls are near the money).
   */
  private async center(r: OiCheckRequest, name: string, under: { exchange: string; token: string; label: string } | null): Promise<{ center: number | null; centerSource: string }> {
    const kind = r.signal.instrumentKind;
    if ((kind === 'FUT' || kind === 'EQ') && r.plan.ltp > 0) return { center: r.plan.ltp, centerSource: `trade LTP (${kind})` };
    const spot = await this.repo.chainSpotSince(name, new Date(r.at.getTime() - CHAIN_SPOT_MAX_AGE_MIN * MIN));
    if (spot !== null) return { center: spot, centerSource: 'option_chain_snapshots spot' };
    if (under) {
      const bars = await this.repo.minuteCloses(under.exchange, under.token, new Date(r.at.getTime() - MINUTE_SPOT_MAX_AGE_MIN * MIN), r.at);
      const last = bars.length ? bars[bars.length - 1].close : null;
      if (last !== null && last > 0) return { center: last, centerSource: under.label };
    }
    const strike = r.signal.strike;
    return typeof strike === 'number' && strike > 0 ? { center: strike, centerSource: 'traded strike (no underlying price)' } : { center: null, centerSource: 'none' };
  }

  /** The future's OI rows and ONE price series (never mixed): snapshot LTPs, else its 1m closes, else the underlying's. */
  private async futures(
    r: OiCheckRequest,
    fut: { instrumentId: string; symbol: string; exchange: string; token: string },
    sessionStart: Date,
    windows: Array<[Date, Date]>,
    under: { exchange: string; token: string; label: string } | null,
  ): Promise<OiCheckInput['futures']> {
    const rows = await this.repo.oiRows([fut.instrumentId], windows);
    if (rows.length === 0) return null;
    const from = new Date(sessionStart.getTime() - 5 * MIN);
    // The snapshot's own LTP (same quote as the OI) first; then the future's 1m closes; then the underlying's.
    let prices = await this.repo.oiLtps(fut.instrumentId, from, r.at);
    let priceSource = `oi_snapshots.ltp ${fut.symbol}`;
    if (prices.length === 0) {
      prices = await this.repo.minuteCloses(fut.exchange, fut.token, from, r.at);
      priceSource = `candles_1m ${fut.symbol}`;
    }
    if (prices.length === 0 && under && under.token !== fut.token) {
      prices = await this.repo.minuteCloses(under.exchange, under.token, from, r.at);
      priceSource = under.label;
    }
    return { instrumentId: fut.instrumentId, symbol: fut.symbol, rows, prices, priceSource };
  }
}
