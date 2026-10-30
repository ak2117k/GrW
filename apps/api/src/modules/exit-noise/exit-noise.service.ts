import { Injectable, Logger } from '@nestjs/common';
import { INDEX_UNDERLYINGS } from '../market-hub/underlying';
import { exposureOf } from '../exit-discipline/exposure';
import type { PositionSide } from '../exit-discipline/types';
import { noiseRead, type NoiseRead, type NoiseReadInput } from './domain/noise-read';
import { ExitNoiseRepository, type MinuteBar } from './exit-noise.repository';

export type NoiseSource = 'paper' | 'signal_paper' | 'real';

export interface ExitNoiseRequest {
  source: NoiseSource;
  /** The paper trade id, or the real exit's verdict id (ai_exit_executions.verdictId). */
  refId: string;
  exitRule: 'AI_EXIT' | 'AI_TRIGGER';
  /** When the exit fired. */
  at: Date;
  /** The sentinel's tracker id (`paper:<tradeId>` for a paper trade): the stored packet is read by it. */
  trackerId: string;
  tradeId?: string | null;
  userId?: string | null;
  /** The position as the caller knows it; absent ⇒ read from trade_trackers (a real position). */
  position?: { symbol: string; exchange: string; token: string; side: PositionSide } | null;
  /**
   * The exit price: the paper close, or a real exit's fill / order / decision price (the sentinel-executor
   * callers read their own ai_exit_executions row — only that module reads the table).
   */
  exitPrice?: number | null;
  /** The underlying the exit saw (the paper sentinel's last tick), when the caller has it. */
  underlyingNow?: number | null;
  /** Extra facts kept on the row (the trigger, the execution status). */
  context?: Record<string, unknown>;
}

const MIN = 60_000;
/** oi_snapshots read before the exit (≥ the read's 9-min window plus a capture's lag). */
const OI_FETCH_MIN = 15;
/** 1m bars read before the exit (the volume component's 25 bars, with slack). */
const BARS_FETCH_MIN = 35;
/** The underlying's last 1m close counts as "at the exit" when at most this old. */
const UNDERLYING_MAX_AGE_MIN = 3;
/** The stored packet's underlying LTP is the fallback when the packet is at most this old. */
const PACKET_UNDERLYING_MAX_AGE_MIN = 5;
/** Option expiries tried: the traded one first, then the nearest, until one has snapshots. */
const MAX_EXPIRIES = 3;
const CASH = new Set(['NSE', 'BSE']);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const path = (x: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((o, k) => obj(o)?.[k], x);

/** IST midnight of `at`'s IST day. */
function istMidnight(at: Date): Date {
  const ymd = new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return new Date(`${ymd}T00:00:00+05:30`);
}

/**
 * What the read takes from the sentinel's stored packet (structural: this module never imports
 * trade-sentinel). The underlying's best point and N from money.anchors / flow.noiseUnit, the
 * underlying LTP, and VWAP from the level book (or a cash position's equity block).
 */
export function packetFacts(packet: unknown): { bestUnderlying: number | null; n: number | null; underlying: number | null; underlyingAt: string | null; vwap: number | null; vwapSource: string } {
  const best = path(packet, 'money', 'anchors', 'best', 'underlying');
  const nu = path(packet, 'flow', 'noiseUnit');
  const n = obj(nu)?.available === true ? path(nu, 'value', 'underlying', 'n') : null;
  const ul = path(packet, 'position', 'underlyingLtp');
  const book = path(packet, 'structure', 'levelBook');
  const eq = path(packet, 'equity', 'vwap');
  const bookVwap = obj(book)?.available === true ? path(book, 'value', 'vwap') : null;
  const eqVwap = obj(eq)?.available === true ? path(eq, 'value', 'vwap') : null;
  const vwap = fin(bookVwap) && bookVwap > 0 ? bookVwap : fin(eqVwap) && eqVwap > 0 ? eqVwap : null;
  return {
    bestUnderlying: fin(best) && best > 0 ? best : null,
    n: fin(n) && n > 0 ? n : null,
    underlying: obj(ul)?.available === true && fin(obj(ul)?.value) ? (obj(ul)!.value as number) : null,
    underlyingAt: typeof obj(ul)?.at === 'string' ? (obj(ul)!.at as string) : null,
    vwap,
    vwapSource: vwap === null ? 'none' : vwap === bookVwap ? 'packet level book VWAP' : 'packet equity VWAP',
  };
}

/**
 * The "noise or real?" read of an AI exit (domain/noise-read), RECORD ONLY. Every exit path fires it
 * AFTER the exit decision and never awaits it, so it can never block, delay or change an exit.
 * Reads the database only — the sentinel's stored packet, the instrument master, oi_snapshots and
 * the hub's candles_1m — never the broker. Any failure is stored as NO_DATA with the error, or only
 * logged when even the row cannot be written. EXIT_NOISE_READS=off ⇒ nothing is read or written.
 */
@Injectable()
export class ExitNoiseReadService {
  private readonly logger = new Logger(ExitNoiseReadService.name);

  constructor(private readonly repo: ExitNoiseRepository) {}

  enabled(): boolean {
    return (process.env.EXIT_NOISE_READS ?? 'on').trim().toLowerCase() !== 'off';
  }

  /** Compute and store; never throws. */
  async record(r: ExitNoiseRequest): Promise<NoiseRead | null> {
    if (!this.enabled()) return null;
    try {
      const pos = r.position ?? (await this.realPosition(r.trackerId));
      if (!pos) {
        this.logger.warn(`[exit-noise] ${r.source} ${r.refId}: no position for tracker ${r.trackerId} — not recorded`);
        return null;
      }
      const want = exposureOf(pos.symbol, pos.side);
      let read: NoiseRead;
      let meta: { name: string | null; ref: { exchange: string; token: string; symbol: string } | null; underlying: number | null; n: number | null; extra: Record<string, unknown> } = {
        name: null, ref: null, underlying: null, n: null, extra: {},
      };
      try {
        const built = await this.input(r, pos, want);
        meta = built.meta;
        read = noiseRead(built.input);
      } catch (e) {
        const error = errText(e);
        read = { verdict: 'NO_DATA', want, at: r.at.toISOString(), summary: `NO_DATA: error ${error}`, components: [], error };
      }
      const exitPrice = fin(r.exitPrice) ? r.exitPrice : null;
      await this.repo.insert({
        source: r.source,
        refId: r.refId,
        tradeId: r.tradeId ?? null,
        trackerId: r.trackerId,
        userId: r.userId ?? null,
        symbol: pos.symbol,
        exchange: pos.exchange,
        underlying: meta.name,
        underlyingExchange: meta.ref?.exchange ?? null,
        underlyingToken: meta.ref?.token ?? null,
        side: pos.side,
        want,
        exitRule: r.exitRule,
        exitPrice,
        exitAt: r.at,
        underlyingAtExit: meta.underlying,
        noiseN: meta.n,
        verdict: read.verdict,
        read: { ...read, underlyingRef: meta.ref, ...meta.extra, ...(r.context ? { context: r.context } : {}) },
      });
      this.logger.log(`[exit-noise] ${r.source} ${r.exitRule} ${pos.symbol} (${r.refId}): ${read.summary}`);
      return read;
    } catch (e) {
      this.logger.warn(`[exit-noise] could not record the read for ${r.source} ${r.refId}: ${errText(e)}`);
      return null;
    }
  }

  private async realPosition(trackerId: string): Promise<ExitNoiseRequest['position']> {
    const t = await this.repo.tracker(trackerId);
    if (!t || !(t.qty !== 0)) return null;
    return { symbol: t.symbol, exchange: t.exchange, token: t.token, side: t.qty > 0 ? 'LONG' : 'SHORT' };
  }

  async input(r: ExitNoiseRequest, pos: NonNullable<ExitNoiseRequest['position']>, want: NoiseReadInput['want']) {
    const exchange = pos.exchange.toUpperCase();
    const cash = CASH.has(exchange);
    const contract = await this.repo.contract(exchange, pos.token, pos.symbol);
    const name = String(contract?.name ?? '').toUpperCase() || null;
    const today = istMidnight(r.at);
    // A stock's near-month future too (F&O stocks' futures OI is captured every 3 min).
    const fut = name ? await this.repo.nearestFuture(name, today) : null;
    const ref = await this.underlyingRef(name, exchange, pos, fut);
    const stored = await this.repo.latestPacket(r.trackerId, r.source !== 'real');
    const facts = packetFacts(stored?.packet);

    const from = new Date(r.at.getTime() - BARS_FETCH_MIN * MIN);
    const bars: MinuteBar[] = ref ? await this.repo.minuteBars(ref.exchange, ref.token, from, r.at) : [];
    const underlying = this.underlyingAt(r, bars, facts);

    const oiFrom = new Date(r.at.getTime() - OI_FETCH_MIN * MIN);
    const chain = name && !cash ? await this.chain(name, contract?.expiry ?? null, today, oiFrom, r.at) : null;
    let futures: NoiseReadInput['futures'] = null;
    let futBars: MinuteBar[] | null = null;
    if (fut) {
      const rows = await this.repo.oiRows([fut.instrumentId], oiFrom, r.at);
      if (rows.length) {
        let prices = await this.repo.oiLtps(fut.instrumentId, oiFrom, r.at);
        let priceSource = `oi_snapshots.ltp ${fut.symbol}`;
        if (prices.length === 0) {
          futBars = await this.repo.minuteBars(fut.exchange, fut.token, from, r.at);
          prices = futBars.map((b) => ({ at: b.at, close: b.close }));
          priceSource = `candles_1m ${fut.symbol}`;
        }
        if (prices.length === 0 && ref && ref.token !== fut.token) {
          prices = bars.map((b) => ({ at: b.at, close: b.close }));
          priceSource = `candles_1m ${ref.symbol}`;
        }
        futures = { symbol: fut.symbol, instrumentId: fut.instrumentId, rows, prices, priceSource };
      }
    }

    // Volume: the underlying's own bars (a stock); an index has none, so its future's.
    let volume: NoiseReadInput['volume'] = null;
    if (ref && bars.some((b) => b.volume > 0)) volume = { bars: bars.map((b) => ({ at: b.at, volume: b.volume })), source: `candles_1m ${ref.symbol}` };
    else if (fut) {
      futBars = futBars ?? (await this.repo.minuteBars(fut.exchange, fut.token, from, r.at));
      if (futBars.some((b) => b.volume > 0)) volume = { bars: futBars.map((b) => ({ at: b.at, volume: b.volume })), source: `candles_1m ${fut.symbol}` };
    }

    const input: NoiseReadInput = {
      at: r.at,
      want,
      underlying,
      n: facts.n,
      bestUnderlying: facts.bestUnderlying,
      chain,
      futures,
      vwap: facts.vwap === null ? null : { value: facts.vwap, source: facts.vwapSource },
      volume,
    };
    return {
      input,
      meta: { name, ref, underlying, n: facts.n, extra: { packetAt: stored?.at.toISOString() ?? null, ...(stored ? {} : { packetNote: 'no stored sentinel packet for the tracker' }) } },
    };
  }

  /** The underlying's own price line: the index, an MCX contract's nearest future, a stock's cash line (or the cash position itself). */
  private async underlyingRef(name: string | null, exchange: string, pos: NonNullable<ExitNoiseRequest['position']>, fut: { exchange: string; token: string; symbol: string } | null) {
    if (CASH.has(exchange)) return { exchange, token: pos.token, symbol: pos.symbol };
    if (!name) return null;
    const index = INDEX_UNDERLYINGS[name];
    if (index) return { exchange: index.exchange, token: index.token, symbol: index.symbol };
    if (exchange === 'MCX') return fut ? { exchange: fut.exchange, token: fut.token, symbol: fut.symbol } : null;
    return this.repo.cashRef(name);
  }

  /** The caller's tick → the underlying's last 1m close ≤ 3 min old → a fresh stored packet's underlying LTP. */
  private underlyingAt(r: ExitNoiseRequest, bars: readonly MinuteBar[], facts: ReturnType<typeof packetFacts>): number | null {
    if (fin(r.underlyingNow) && r.underlyingNow > 0) return r.underlyingNow;
    const last = bars.length ? bars[bars.length - 1] : null;
    if (last && last.close > 0 && r.at.getTime() - last.at.getTime() <= UNDERLYING_MAX_AGE_MIN * MIN) return last.close;
    const at = facts.underlyingAt ? Date.parse(facts.underlyingAt) : NaN;
    if (facts.underlying !== null && Number.isFinite(at) && r.at.getTime() - at <= PACKET_UNDERLYING_MAX_AGE_MIN * MIN) return facts.underlying;
    return null;
  }

  private async chain(name: string, expiry: string | null, today: Date, from: Date, to: Date): Promise<NoiseReadInput['chain']> {
    const expiries = await this.repo.optionExpiries(name, today);
    const order = [...(expiry && expiries.includes(expiry) ? [expiry] : []), ...expiries.filter((e) => e !== expiry)].slice(0, MAX_EXPIRIES);
    for (const e of order) {
      const contracts = await this.repo.optionContracts(name, e);
      if (contracts.length === 0) continue;
      const rows = await this.repo.oiRows(contracts.map((c) => c.instrumentId), from, to);
      if (rows.length === 0) continue;
      return { expiry: e, contracts, rows };
    }
    return null;
  }
}
