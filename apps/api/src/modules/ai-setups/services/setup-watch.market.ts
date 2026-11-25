import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { QuoteResolverLike } from '../../market-data/services/batch-quotes.service';
import { lookupHubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, type InstrumentRef } from '../../market-hub/hub.types';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { istYmd } from '../../mbm/domain/chain-snapshot';
import { quoteIsStale } from '../../message-reader/domain/reader-quote';
import type { Vocabulary } from '../../signal-intake/domain/vocabulary';
import { infoRefOf, type InfoBars } from '../../signal-intake/services/signal-outcome.service';
import type { Bar15m } from '../domain/setup-watch';
import type { SetupWatchMarket, WatchRef } from './setup-watch.service';

/** The hub watch owner / priority / TTL for the setup watch's refs (≤ 3 underlyings + ≤ 3 options a day). */
export const SETUP_WATCH_HUB_OWNER = 'ai-setup-watch';
const HUB_PRIORITY = 2;
const HUB_TTL_MS = 2 * 60_000;
/** A hub price older than this is not "live": the quote batch is asked instead. */
const HUB_MAX_AGE_MS = 15_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const keyOf = (r: Pick<WatchRef, 'exchange' | 'token'>) => `${r.exchange.toUpperCase()}:${r.token}`;

/**
 * The setup watch's market reads over the OWNER's session (quotes and bars only, never an order):
 * - ltps: the market hub's live price when the ref is live there (hubFor(owner, 'positions'), watched under
 *   SETUP_WATCH_HUB_OWNER so the next pass has a tick), the rest in ONE MarketQuoteResolver.resolveQuotes batch;
 *   a quote older than 5 min during the session is not fresh.
 * - bars15m: SIGNAL_INFO_BARS.intraday15m (the loader the setup packet reads).
 * - underlyingRef: signal-intake infoRefOf (index / NSE cash / MCX front future), cached per underlying per IST day.
 *   It THROWS when the master or the vocabulary is not loaded / failed (the watch waits); null only when both
 *   loaded and nothing matched (the watch expires the setup NO_UNDERLYING_REF).
 */
export class LiveSetupWatchMarket implements SetupWatchMarket {
  private readonly logger = new Logger('SetupWatchMarket');
  private readonly refs = new Map<string, { day: string; ref: WatchRef | null }>();

  constructor(
    private readonly d: {
      moduleRef: Pick<ModuleRef, 'get'> | null;
      quotes: QuoteResolverLike;
      bars: InfoBars | null;
      master: { rows(): Promise<readonly unknown[] | null> } | null;
      vocab: { get(): Promise<Vocabulary> } | null;
      ownerUserId: string | null;
      clock: { isOpen(exchange: string, at?: Date): boolean; minutesToClose(exchange: string, at?: Date): number | null };
    },
  ) {}

  async underlyingRef(underlying: string, now: Date): Promise<WatchRef | null> {
    const u = underlying.trim().toUpperCase();
    const day = istYmd(now);
    const hit = this.refs.get(u);
    if (hit && hit.day === day && hit.ref) return hit.ref;
    // An index needs neither the master nor the vocabulary.
    const idx = INDEX_UNDERLYINGS[u];
    if (idx) {
      const ref = { exchange: idx.exchange, token: idx.token, symbol: u };
      this.refs.set(u, { day, ref });
      return ref;
    }
    // Anything else needs BOTH loaded: a missing / failed / empty one THROWS (the watch waits), never null — null
    // means "both loaded and nothing matched" and expires the setup (NO_UNDERLYING_REF). Without the vocabulary an
    // MCX name would fall through to an NSE equity lookup and look like "no line".
    const [vocab, master] = await Promise.all([this.loadVocab(), this.loadMaster()]);
    const r = infoRefOf(u, vocab, master, now);
    const ref = r ? { exchange: r.exchange, token: r.token, symbol: u } : null;
    this.refs.set(u, { day, ref });
    return ref;
  }

  private async loadVocab(): Promise<Vocabulary> {
    if (!this.d.vocab) throw new Error('underlying vocabulary not wired');
    let v: Vocabulary | null = null;
    try {
      v = await this.d.vocab.get();
    } catch (err) {
      throw new Error(`underlying vocabulary unavailable: ${errText(err)}`);
    }
    if (!v || !v.classOf || v.classOf.size === 0) throw new Error('underlying vocabulary not loaded (empty)');
    return v;
  }

  private async loadMaster(): Promise<readonly unknown[]> {
    if (!this.d.master) throw new Error('instrument master not wired');
    let m: readonly unknown[] | null = null;
    try {
      m = await this.d.master.rows();
    } catch (err) {
      throw new Error(`instrument master unavailable: ${errText(err)}`);
    }
    if (!m || m.length === 0) throw new Error('instrument master not loaded (empty)');
    return m;
  }

  async ltps(refs: readonly WatchRef[], now: Date): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const owner = this.d.ownerUserId;
    if (!owner || refs.length === 0) return out;
    let missing: WatchRef[] = [...refs];
    try {
      const hub = lookupHubPrices(this.d.moduleRef)?.hubFor(owner, 'positions') ?? null;
      if (hub) {
        const hubRefs: InstrumentRef[] = [];
        for (const r of refs) {
          const ex = r.exchange.toUpperCase();
          if (isHubExchange(ex)) hubRefs.push({ exchange: ex, token: r.token, symbol: r.symbol });
        }
        if (hubRefs.length > 0) void Promise.resolve(hub.watch(hubRefs, HUB_PRIORITY, SETUP_WATCH_HUB_OWNER, HUB_TTL_MS)).catch(() => undefined);
        missing = [];
        for (const r of refs) {
          const ex = r.exchange.toUpperCase();
          const p = isHubExchange(ex) ? hub.price({ exchange: ex, token: r.token, symbol: r.symbol }, { maxAgeMs: HUB_MAX_AGE_MS }) : null;
          if (p && p.kind === 'fresh' && p.price.ltp > 0) out.set(keyOf(r), p.price.ltp);
          else missing.push(r);
        }
      }
    } catch (err) {
      this.logger.warn(`[ai-setup] hub prices: ${errText(err)} — quote batch for all`);
      missing = refs.filter((r) => !out.has(keyOf(r)));
    }
    if (missing.length === 0) return out;
    try {
      const q = await this.d.quotes.resolveQuotes(owner, missing.map((r) => ({ token: r.token, exchange: r.exchange, symbol: r.symbol })));
      for (const r of missing) {
        const v = q.get(r.token);
        if (!v || !(v.ltp > 0)) continue;
        if (v.exchange && v.exchange.toUpperCase() !== r.exchange.toUpperCase()) continue;
        if (quoteIsStale(r.exchange, new Date(v.timestamp), now)) continue;
        out.set(keyOf(r), v.ltp);
      }
    } catch (err) {
      this.logger.warn(`[ai-setup] quote batch (${missing.length}): ${errText(err)}`);
    }
    return out;
  }

  async bars15m(ref: WatchRef, from: Date, now: Date): Promise<Bar15m[]> {
    if (!this.d.bars?.intraday15m) throw new Error('no 15m bar loader');
    const rows = await this.d.bars.intraday15m(ref.exchange, ref.token, from, now);
    return (rows ?? []).map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close }));
  }

  async master(): Promise<readonly unknown[] | null> {
    return this.d.master ? this.d.master.rows() : null;
  }

  isOpen(exchange: string, now: Date): boolean {
    try {
      return this.d.clock.isOpen(exchange, now);
    } catch {
      return false;
    }
  }

  minutesToClose(exchange: string, now: Date): number | null {
    try {
      return this.d.clock.minutesToClose(exchange, now);
    } catch {
      return null;
    }
  }
}
