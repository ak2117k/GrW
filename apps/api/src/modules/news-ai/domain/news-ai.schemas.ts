/**
 * Structured-output schemas for the two news-ai jobs.
 *
 * VERTEX RULE (2026-11-23, c987acf0): never combine a type array containing 'null' with `enum`
 * (`{ type: ['string','null'], enum: [...] }` is rejected on every call). A nullable enum is
 * `anyOf: [{ type: 'string', enum: [...] }, { type: 'null' }]`. `findTypeArrayEnumCombos` walks a
 * schema for that shape; the spec asserts both schemas are clean.
 * No numeric / array-length constraints either (not supported by structured outputs): ranges and
 * caps are enforced by the validators in news-ai.validate.ts.
 */

export const DIRECTIONS = ['BULL', 'BEAR', 'NEUTRAL', 'MIXED'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const AFFECTED_DIRECTIONS = ['BULL', 'BEAR'] as const;
export type AffectedDirection = (typeof AFFECTED_DIRECTIONS)[number];
export const AFFECTED_KINDS = ['INDEX', 'SECTOR', 'STOCK', 'COMMODITY', 'CURRENCY', 'RATES'] as const;
export type AffectedKind = (typeof AFFECTED_KINDS)[number];
export const BRIEF_INDICES = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
export const BRIEF_COMMODITIES = ['CRUDEOIL', 'GOLD', 'SILVER'] as const;

const str = { type: 'string' } as const;
const ids = { type: 'array', items: { type: 'string' } } as const;
const direction = { type: 'string', enum: [...DIRECTIONS] } as const;

export const NEWS_READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['direction', 'strength', 'importance', 'takeaway', 'affected'],
  properties: {
    direction,
    strength: { type: 'integer' },
    importance: { type: 'integer' },
    takeaway: str,
    affected: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'name', 'direction', 'why'],
        properties: {
          kind: { type: 'string', enum: [...AFFECTED_KINDS] },
          name: str,
          direction: { type: 'string', enum: [...AFFECTED_DIRECTIONS] },
          why: str,
        },
      },
    },
  },
} as const;

const point = (nameSchema: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: ['name', 'direction', 'summary', 'articleIds'],
  properties: { name: nameSchema, direction, summary: str, articleIds: ids },
});

const tone = {
  type: 'object',
  additionalProperties: false,
  required: ['direction', 'summary', 'articleIds'],
  properties: { direction, summary: str, articleIds: ids },
} as const;

export const NEWS_BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'indiaTone', 'globalTone', 'indices', 'sectors', 'commodities', 'holdings', 'topStories', 'watchNext'],
  properties: {
    headline: str,
    indiaTone: tone,
    globalTone: tone,
    indices: { type: 'array', items: point({ type: 'string', enum: [...BRIEF_INDICES] }) },
    sectors: { type: 'array', items: point(str) },
    commodities: { type: 'array', items: point({ type: 'string', enum: [...BRIEF_COMMODITIES] }) },
    holdings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol', 'direction', 'summary', 'articleIds'],
        properties: { symbol: str, direction, summary: str, articleIds: ids },
      },
    },
    topStories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['articleId', 'headline', 'direction', 'whyItMatters'],
        properties: { articleId: str, headline: str, direction, whyItMatters: str },
      },
    },
    watchNext: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'articleIds'],
        properties: { item: str, articleIds: ids },
      },
    },
  },
} as const;

/**
 * Every JSON-pointer-ish path in `schema` where a node has BOTH a `type` array and an `enum` —
 * the combination Vertex rejects. Empty = safe to send.
 */
export function findTypeArrayEnumCombos(schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema)) return schema.flatMap((s, i) => findTypeArrayEnumCombos(s, `${path}[${i}]`));
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const here = Array.isArray(node.type) && 'enum' in node ? [path] : [];
  return [
    ...here,
    ...Object.entries(node).flatMap(([k, v]) => (v && typeof v === 'object' ? findTypeArrayEnumCombos(v, `${path}.${k}`) : [])),
  ];
}

export const NEWS_READ_SYSTEM = [
  'You read ONE news article for an Indian derivatives trader who trades NSE/BSE F&O (NIFTY, BANKNIFTY, SENSEX,',
  'FINNIFTY and stock options/futures) and MCX commodities (crude oil, gold, silver, natural gas).',
  'Judge what the story means for prices over the next few sessions, not whether it is good news for society.',
  '',
  'Return JSON only:',
  '- direction: BULL | BEAR | NEUTRAL | MIXED for the Indian market overall as this story touches it.',
  '  MIXED = clearly bullish for some instruments and bearish for others. NEUTRAL = no tradeable tilt.',
  '- strength: 0-100, how strong the tilt is (0 = none, 50 = clear but ordinary, 90+ = rare, decisive).',
  '- importance: 0-100, how much an Indian F&O / MCX trader should care TODAY. Routine filings, old news,',
  '  recaps of moves that already happened, small-cap trivia and generic commentary are low (under 25).',
  '  Policy rates, budget/tax, large results of index heavyweights, war/oil shocks, big FII flows are high.',
  '- takeaway: ONE plain-English line a trader can act on (no hype, no hedging boilerplate).',
  '- affected: the instruments the story actually moves, each {kind, name, direction BULL|BEAR, why (one line)}.',
  '  kind: INDEX | SECTOR | STOCK | COMMODITY | CURRENCY | RATES.',
  '  name: NSE symbols for stocks (RELIANCE, HDFCBANK, TCS ...); indices NIFTY | BANKNIFTY | SENSEX | FINNIFTY |',
  '  MIDCPNIFTY; commodities CRUDEOIL | GOLD | SILVER | NATURALGAS | COPPER; currency USDINR; rates INDIA10Y or',
  '  RBI_REPO / US10Y; sectors as plain upper-case names (BANKS, IT, AUTO, PHARMA, METALS, FMCG, ENERGY, REALTY,',
  '  PSU_BANKS, OIL_GAS, TELECOM, INFRA, MEDIA, CHEMICALS, CAPITAL_GOODS, FINANCIALS).',
  '  Leave affected empty when nothing tradeable is moved. Do not list an instrument you cannot justify.',
  'The existing tags are hints from a keyword tagger and can be wrong; trust the text.',
].join('\n');

export const NEWS_BRIEF_SYSTEM = [
  'You write the "what matters now" brief at the top of a news page for ONE Indian derivatives trader (NSE/BSE F&O',
  'and MCX). You get news articles already read one by one (direction, strength, importance, takeaway, affected',
  'instruments), most important first, plus the trader\'s open holdings and positions.',
  '',
  'Rules:',
  '- Cite article ids for EVERY point (articleIds / articleId) using ONLY the ids given. No id, no point.',
  '- Weigh importance and agreement across sources; one loud story is not a trend. Say when the tone is mixed.',
  '- Be concrete and short: one or two sentences per point, plain English, no hype, no disclaimers.',
  '- headline: one line, the single most useful sentence for the trader right now.',
  '- indiaTone / globalTone: overall direction BULL | BEAR | NEUTRAL | MIXED with a short reason.',
  '- indices: NIFTY, BANKNIFTY, SENSEX - include each one the news actually says something about.',
  '- sectors: only sectors with real news flow; name them in plain upper case (BANKS, IT, AUTO ...).',
  '- commodities: CRUDEOIL, GOLD, SILVER when there is news on them.',
  '- holdings: for each holding / position given that the news touches (directly, via its sector, index or',
  '  commodity), what the news means for it. Skip holdings no article touches. Use the symbol as given.',
  '- topStories: up to 5, most important first, each with why it matters for this trader.',
  '- watchNext: scheduled events, levels of news risk or follow-ups to watch in the next sessions.',
].join('\n');
