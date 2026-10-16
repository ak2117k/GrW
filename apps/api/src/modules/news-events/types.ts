/**
 * News & events v2 shared shapes (docs/superpowers/specs/2026-10-16-news-events-design.md).
 * PURE — imports nothing: the sentinel's cycle walk reads this file through its ports.
 */

/** The ladder rung a headline was claimed by (spec §7). */
export type NewsLayer = 'instrument' | 'sector' | 'index' | 'market';

/** Market-wide tag: Indian market or global macro. */
export type MarketTag = 'IN' | 'GLOBAL';

/** Tag-once result stored on `news_articles` (v2 columns, never `relatedSymbols`). */
export interface ArticleTags { instruments: string[]; sectors: string[]; indices: string[]; markets: MarketTag[] }

/** One article as the in-memory index holds it (times in epoch ms, title already capped). */
export interface IndexedArticle {
  id: string; title: string; source: string; sentiment: string | null;
  publishedAt: number; fetchedAt: number; dateInferred: boolean; tags: ArticleTags;
}

/** The subset of a `news_articles` row the index reads. */
export interface NewsRowLike {
  id: string; title: string; source: string; sentiment: string | null; publishedAt: Date; fetchedAt: Date;
  dateInferred: boolean; instruments: string[]; sectors: string[]; indices: string[]; markets: string[];
}

/** What kind of underlying a position trades. */
export type PositionKind = 'STOCK' | 'INDEX' | 'COMMODITY';

/** A position as news/events see it: `key` is the index key without prefix (benchmark for MCX). */
export interface NewsPosition { kind: PositionKind; underlying: string; key: string; exchange: string; expiry: string | null }

/** A resolved position, or the honest reason news cannot be looked up for it. */
export type NewsPositionResult = NewsPosition | { unresolved: string };

/** One packet headline with the rung that claimed it. */
export interface LayeredHeadline {
  title: string; source: string; sentiment: string | null; publishedAt: string;
  layer: NewsLayer; key: string; ageMin: number;
}

/** Provenance of the news block: last successful ingest, down sources, staleness. */
export interface NewsAsOf { lastIngestAt: string | null; downSources: string[]; stale: boolean }

/** A fresh own-instrument article (edge-triggered wake input). */
export interface FreshItem { id: string; title: string }

/** Synchronous news read for one position. */
export type NewsPeek =
  | { status: 'ok'; headlines: LayeredHeadline[]; newestAt: string | null; freshCount: number; fresh: FreshItem[]; asOf: NewsAsOf }
  | { status: 'warming' | 'unavailable'; reason: string };

/** Symbol → NSE sectoral index name. */
export interface SectorLookup { sectorOf(symbol: string): string | null }

/** In-memory health of one news source (spec §4.4). */
export interface SourceHealth { source: string; lastOkAt: string | null; lastError: string | null; consecutiveFailures: number; itemsLastFetch: number }

/** What an event is about. */
export type EventScope = 'company' | 'market' | 'commodity' | 'expiry';

/** How much an event can move the position. */
export type EventImpact = 'high' | 'medium' | 'low';

/** An event as a builder produces it, before storage. */
export interface MarketEventInput {
  scope: EventScope; kind: string; key: string; title: string; startsAt: Date; allDay: boolean;
  impact: EventImpact; source: string; sourceRef: string | null;
}

/** A `market_events` row. */
export interface StoredMarketEvent extends MarketEventInput { id: string; fetchedAt: Date }

/** One event as the packet renders it. */
export interface PacketEvent { kind: string; scope: EventScope; title: string; atIst: string; minutesAway: number; impact: EventImpact; source: string }

/** A packet event plus what the tripwire needs (stable id, all-day flag). */
export interface EventView extends PacketEvent { id: string; allDay: boolean }

/** Synchronous events read for one position. */
export type EventsPeek =
  | { status: 'ok'; events: EventView[]; minutesToNextHighImpact: number | null; noHighImpactReason: string | null; notes: string[]; fetchedAt: string | null }
  | { status: 'warming' | 'unavailable'; reason: string };
