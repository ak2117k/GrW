import { Injectable } from '@nestjs/common';
import { NewsAggregatorService } from '../../news/services/news-aggregator.service';
import type { NewsShim, SourcedValue } from '../services/context-packet.service';
import { normaliseSymbol } from '../symbols';

/**
 * How far back a headline still counts as "recent" for the packet's news block.
 *
 * THE WINDOW IS APPLIED HERE BECAUSE THE SOURCE HAS NONE.
 * `NewsAggregatorService.getNewsForSymbol` is `orderBy publishedAt desc, take
 * 20` with no date filter at all — for a symbol that has been quiet for a month
 * it happily returns last month's twenty headlines. Handed straight to the
 * agent under a block the prompt teaches it to read as recent context, that is
 * the packet's central failure mode: evidence that is present, carries
 * provenance, and is wrong.
 *
 * SIX HOURS, not the thirty minutes the `freshCount` field uses. The two answer
 * different questions and must not be collapsed. `freshCount` is a TRIGGER —
 * "something just broke, go and look" — and wants to be tight. This block is
 * CONTEXT the agent reads while judging a position it may have held all
 * session, and a result downgrade published at 09:40 is still the reason a
 * 14:00 breakdown is happening. Six hours covers a full trading session plus
 * the pre-open, and stops at roughly the point where a headline is yesterday's
 * news rather than today's.
 */
export const NEWS_RECENCY_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Headlines are evidence, not a feed; more than this is noise in a prompt. */
const MAX_HEADLINES = 8;

/**
 * `NewsShim` over the real aggregator, with the recency window the aggregator
 * does not have.
 */
@Injectable()
export class SentinelNewsAdapter implements NewsShim {
  constructor(private readonly news: NewsAggregatorService) {}

  async recentFor(symbol: string): Promise<SourcedValue | null> {
    // `relatedSymbols` is tagged from scanner/news feeds, which use the BASE
    // symbol. Querying the broker's `SUZLON-EQ` matches nothing, silently.
    const base = normaliseSymbol(symbol);
    const articles = await this.news.getNewsForSymbol(base);

    const cutoff = Date.now() - NEWS_RECENCY_WINDOW_MS;
    const fresh = articles.filter((a) => a.publishedAt.getTime() >= cutoff);
    // Null, not an empty array with provenance: `ContextPacketService.safely`
    // turns both into an absent block, and "no recent headlines" is a fact the
    // agent should read as a stated absence rather than as an empty list it
    // might interpret as a source outage.
    if (fresh.length === 0) return null;

    const headlines = fresh.slice(0, MAX_HEADLINES).map((a) => ({
      title: a.title,
      source: a.source,
      sentiment: a.sentiment,
      publishedAt: a.publishedAt.toISOString(),
    }));

    return {
      value: headlines,
      // The window is named in the provenance string. Without it two packets
      // built under different windows would be indistinguishable in replay.
      source: `news-aggregator.service (published within ${NEWS_RECENCY_WINDOW_MS / 3_600_000}h)`,
      // The MOST RECENT headline's publication time, not now: the block's `at`
      // is meant to say when the DATA is from, and stamping it with the build
      // time would make a five-hour-old headline look like it just landed.
      at: fresh[0].publishedAt.toISOString(),
    };
  }
}
