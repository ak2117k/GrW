import { Inject, Injectable } from '@nestjs/common';
import { BreadthSectorService } from '../../market-data/services/breadth-sector.service';
import { MARKET_QUOTE_RESOLVER, type QuoteResolverLike } from '../../market-data/services/batch-quotes.service';
import { SignalContextService } from '../../signal-trader/services/signal-context.service';
import { SIGNAL_TRADER_CONFIG } from '../../signal-trader/services/signal-trader.service';
import type { SignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import { segmentFor } from '../../signal-trader/domain/contract-resolver';
import { istYmd } from '../../mbm/domain/chain-snapshot';
import { MESSAGE_READER_CONFIG, type MessageReaderConfig } from '../message-reader.config';
import { READER_PACKET_SOURCES, type ReaderPacketSources } from './reader-packet.sources';

export type PacketBlock = { status: 'present'; source: string; value: unknown } | { status: 'unavailable'; source: string; reason: string };

export interface ReaderPacket {
  at: string;
  marketPulse: { indices: PacketBlock; breadth: PacketBlock; sectors: PacketBlock };
  instruments: Record<string, Record<string, unknown>>;
  channelRecent: PacketBlock;
  todayNotes: PacketBlock;
}

type MarketPulse = ReaderPacket['marketPulse'];

/** The market pulse (indices, breadth, sectors) is shared by every post read within this window. */
const PULSE_CACHE_MS = 60_000;
const MAX_INSTRUMENTS = 3;
const CHANNEL_WINDOW_MS = 30 * 60_000;
const MAX_ROWS = 10;

/** Index quotes for the pulse (tokens as in market-context's UNDERLYING_TOKEN_MAP). */
const PULSE_INDICES = [
  { name: 'NIFTY', token: '99926000', exchange: 'NSE' },
  { name: 'BANKNIFTY', token: '99926009', exchange: 'NSE' },
  { name: 'SENSEX', token: '99919000', exchange: 'BSE' },
] as const;

const SRC = {
  indices: 'market-quote-resolver (NIFTY, BANKNIFTY, SENSEX)',
  breadth: 'breadth-sector (advance / decline)',
  sectors: 'breadth-sector (sector performance)',
  instrument: 'signal-context (judge market packet)',
  channel: 'message_readings (this channel, last 30 min)',
  notes: 'message_readings (today, confirmed / contradicted market claims)',
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Builds the data packet the AI reader checks a post against: market pulse, the instruments the post
 * names, the channel's recent posts and today's settled market notes. Every source runs in parallel and
 * is raced against MESSAGE_READER_PACKET_MS; a slow or failing source becomes an `unavailable` block,
 * never a throw. The pulse costs a quote batch on the owner's Angel session (10 req/s), so it is cached
 * for 60 s and concurrent builds share one in-flight fetch.
 */
@Injectable()
export class ReaderPacketService {
  private pulse: { at: number; promise: Promise<MarketPulse> } | null = null;

  constructor(
    private readonly breadth: BreadthSectorService,
    @Inject(MARKET_QUOTE_RESOLVER) private readonly quotes: QuoteResolverLike,
    private readonly context: SignalContextService,
    @Inject(READER_PACKET_SOURCES) private readonly sources: ReaderPacketSources,
    @Inject(MESSAGE_READER_CONFIG) private readonly cfg: MessageReaderConfig,
    @Inject(SIGNAL_TRADER_CONFIG) private readonly traderCfg: SignalTraderConfig,
  ) {}

  async build(i: { text: string; channelId: string; underlyings: string[]; now: Date }): Promise<{ packet: ReaderPacket; ms: number }> {
    const started = Date.now();
    const names = [...new Set(i.underlyings.map((u) => u.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_INSTRUMENTS);
    const owner = this.traderCfg.ownerUserId;
    const [marketPulse, instruments, channelRecent, todayNotes] = await Promise.all([
      this.marketPulse(owner),
      Promise.all(names.map(async (u) => [u, await this.instrument(u, owner, i.now)] as const)),
      this.block(SRC.channel, async () => (await this.sources.recentChannelPosts(i.channelId, new Date(i.now.getTime() - CHANNEL_WINDOW_MS))).slice(0, MAX_ROWS)),
      this.block(SRC.notes, async () => (await this.sources.todayMarketNotes(istYmd(i.now))).slice(0, MAX_ROWS)),
    ]);
    const packet: ReaderPacket = { at: i.now.toISOString(), marketPulse, instruments: Object.fromEntries(instruments), channelRecent, todayNotes };
    return { packet, ms: Date.now() - started };
  }

  private marketPulse(owner: string | null): Promise<MarketPulse> {
    const now = Date.now();
    if (this.pulse && now - this.pulse.at < PULSE_CACHE_MS) return this.pulse.promise;
    const promise = this.fetchPulse(owner);
    this.pulse = { at: now, promise };
    return promise;
  }

  private async fetchPulse(owner: string | null): Promise<MarketPulse> {
    const need = <T>(f: (userId: string) => Promise<T>) => async () => {
      if (!owner) throw new Error('no owner user id (HUB_OWNER_USER_ID) to quote with');
      return f(owner);
    };
    const [indices, breadth, sectors] = await Promise.all([
      this.block(SRC.indices, need(async (u) => {
        const q = await this.quotes.resolveQuotes(u, PULSE_INDICES.map(({ token, exchange, name }) => ({ token, exchange, symbol: name })));
        const out: Record<string, unknown> = {};
        for (const ix of PULSE_INDICES) {
          const r = q.get(ix.token);
          if (r) out[ix.name] = { ltp: r.ltp, prevClose: r.close, change: r.change, changePercent: r.changePercent, at: new Date(r.timestamp).toISOString() };
        }
        if (Object.keys(out).length === 0) throw new Error('no index quote returned');
        return out;
      })),
      this.block(SRC.breadth, need((u) => this.breadth.getBreadth(u))),
      this.block(SRC.sectors, need((u) => this.breadth.getSectorPerformance(u))),
    ]);
    return { indices, breadth, sectors };
  }

  /**
   * The judge's market packet for one named underlying. The post names an underlying, not a contract,
   * so it is read as a futures signal on it: exchange from signal-trader's own segment rule (NFO / BFO /
   * MCX); a stock's spot then comes from its cash line, as for a stock-futures signal.
   */
  private async instrument(underlying: string, owner: string | null, now: Date): Promise<Record<string, unknown>> {
    const r = await this.block(SRC.instrument, () =>
      this.context.build({ underlying, kind: 'FUT', exchange: segmentFor({ underlying, instrumentKind: 'FUT' }), ownerUserId: owner, now }),
    );
    return r.status === 'present' ? (r.value as Record<string, unknown>) : { context: r };
  }

  /** Runs one source against the packet time box; never throws. */
  private async block(source: string, read: () => Promise<unknown>): Promise<PacketBlock> {
    const ms = this.cfg.packetMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      timer.unref?.();
    });
    try {
      const value = await Promise.race([read(), timeout]);
      return { status: 'present', source, value };
    } catch (err) {
      return { status: 'unavailable', source, reason: errText(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
