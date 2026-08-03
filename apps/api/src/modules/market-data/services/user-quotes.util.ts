import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import type { TokenRef } from './user-feed.types';
import { mapFullQuote } from './user-historical.util';

/**
 * Helpers for BATCHED FULL-mode quotes over a user's own Angel session.
 *
 * `GET /market-data/indices` is polled every 5s by every open market page and
 * needs ~7 tokens. One `marketData` call per token would spend most of Angel's
 * 10 req/sec budget on a single page refresh, so the tokens go out together:
 * `exchangeTokens` accepts a LIST per exchange.
 */

/**
 * Shape a `TokenRef[]` into Angel's `exchangeTokens` map, de-duplicating within
 * each exchange (the same token under two exchanges is kept — they are
 * different instruments).
 */
export function groupTokensByExchange(refs: TokenRef[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { token, exchange } of refs) {
    const list = (out[exchange] ??= []);
    if (!list.includes(token)) list.push(token);
  }
  return out;
}

/**
 * Map Angel's `marketData({ mode: 'FULL' })` `data.fetched` array to ticks keyed
 * by token. `mapFullQuote` reads only the FIRST entry (single-token contract),
 * so batching needs its own per-entry pass.
 *
 * A null / non-array `fetched` is a throttle or no-entitlement marker and maps
 * to an empty result rather than throwing — same contract as the candle path.
 */
export function mapFullQuotes(fetched: unknown): Map<string, TickData> {
  const out = new Map<string, TickData>();
  if (!Array.isArray(fetched)) return out;

  for (const entry of fetched) {
    const token = String(entry?.symbolToken ?? entry?.symboltoken ?? '');
    // No token means we cannot attribute the quote to an instrument — dropping
    // it beats keying the map on '' and colliding every such entry.
    if (!token) continue;
    const tick = mapFullQuote([entry], token);
    if (tick) out.set(token, tick);
  }
  return out;
}
