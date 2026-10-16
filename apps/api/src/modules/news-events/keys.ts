import type { ArticleTags, IndexedArticle, MarketTag, NewsPosition, NewsPositionResult, NewsRowLike } from './types';
import { TITLE_MAX } from './config';

/** Index underlyings (names as on the instrument master). R1: their index key is `X:<name>`. */
export const INDEX_UNDERLYINGS_V2: readonly string[] = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'SENSEX50'];

/** The benchmark each MCX contract family's headlines talk about. */
export const MCX_BENCHMARKS_V2: readonly string[] = [
  'CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL', 'COTTON', 'MENTHAOIL',
];

/** Minis / micros / variants → benchmark. Superset of the v1 PARENT in underlying-news-aliases.ts. */
export const MCX_PARENT_V2: Readonly<Record<string, string>> = {
  CRUDEOILM: 'CRUDEOIL', NATGASMINI: 'NATURALGAS',
  GOLDM: 'GOLD', GOLDGUINEA: 'GOLD', GOLDPETAL: 'GOLD', GOLDTEN: 'GOLD',
  SILVERM: 'SILVER', SILVERMIC: 'SILVER', SILVER1000: 'SILVER',
  ZINCMINI: 'ZINC', LEADMINI: 'LEAD', ALUMINI: 'ALUMINIUM',
  COTTONCNDY: 'COTTON', KAPAS: 'COTTON',
};

/**
 * Every MCX underlying name the master carries (reconciled in Task A2 against
 * `SELECT DISTINCT name FROM instruments WHERE exchange='MCX' AND "isActive"`).
 * A name here without a keyword mapping fails commodity-index-keywords.spec.ts.
 */
export const MCX_UNDERLYINGS: readonly string[] = [
  ...MCX_BENCHMARKS_V2.filter((b) => b !== 'COTTON'),
  ...Object.keys(MCX_PARENT_V2),
];

export const MCX_GROUP: Readonly<Record<string, string>> = {
  CRUDEOIL: 'MCX ENERGY', NATURALGAS: 'MCX ENERGY',
  GOLD: 'MCX BULLION', SILVER: 'MCX BULLION',
  COPPER: 'MCX BASE METALS', ZINC: 'MCX BASE METALS', LEAD: 'MCX BASE METALS', ALUMINIUM: 'MCX BASE METALS', NICKEL: 'MCX BASE METALS',
  COTTON: 'MCX AGRI', MENTHAOIL: 'MCX AGRI',
};

/** `stock_sectors.sectorIndexToken` → NSE sectoral index name (tokens: nse-sector-index.service.ts SECTOR_TOKEN). */
export const SECTOR_TOKEN_NAME: Readonly<Record<string, string>> = {
  '99926009': 'NIFTY BANK', '99926011': 'NIFTY FIN SERVICE', '99926013': 'NIFTY IT', '99926015': 'NIFTY FMCG',
  '99926017': 'NIFTY PHARMA', '99926019': 'NIFTY ENERGY', '99926021': 'NIFTY AUTO', '99926023': 'NIFTY METAL',
  '99926027': 'NIFTY REALTY', '99926029': 'NIFTY INFRA', '99926031': 'NIFTY MEDIA', '99926033': 'NIFTY PSU BANK',
  '99926035': 'NIFTY PVT BANK', '99926041': 'NIFTY HEALTHCARE', '99926039': 'NIFTY CONSR DURBL',
};

export const BANK_SECTORS: ReadonlySet<string> = new Set(['NIFTY BANK', 'NIFTY PSU BANK', 'NIFTY PVT BANK']);

/** The sector layer of an index position (R2). */
export const INDEX_SECTOR: Readonly<Record<string, string>> = {
  BANKNIFTY: 'NIFTY BANK', BANKEX: 'NIFTY BANK', FINNIFTY: 'NIFTY FIN SERVICE',
};

export function baseSymbol(raw: string): string {
  return String(raw ?? '').trim().toUpperCase().replace(/^(.+)-[A-Z0-9]{1,3}$/, '$1');
}

const CANNOT_SEE = 'the news feed cannot see this underlying; this is NOT a finding that nothing was published';

export function newsPositionOf(underlying: string | null, exchange: string | null, expiry: string | null): NewsPositionResult {
  if (!underlying || !underlying.trim()) {
    return {
      unresolved:
        'the underlying behind this contract could not be resolved, so no news or events were looked up. ' +
        'This is a FAILURE TO LOOK, not a finding — do not read it as an absence in the market.',
    };
  }
  const ex = String(exchange ?? '').trim().toUpperCase();
  const base = baseSymbol(underlying);
  if (ex === 'MCX') {
    const key = MCX_PARENT_V2[base] ?? base;
    if (!MCX_GROUP[key]) return { unresolved: `no headline keyword mapping exists for the MCX underlying ${base} — ${CANNOT_SEE}` };
    return { kind: 'COMMODITY', underlying: base, key, exchange: ex, expiry };
  }
  if (INDEX_UNDERLYINGS_V2.includes(base)) return { kind: 'INDEX', underlying: base, key: base, exchange: ex, expiry };
  return { kind: 'STOCK', underlying: base, key: base, exchange: ex, expiry };
}

export function instrumentKeysOf(p: NewsPosition): string[] {
  return (p.components ?? [p.key]).map((k) => (p.kind === 'INDEX' ? `X:${k}` : `I:${k}`));
}

export function keysOfTags(t: ArticleTags): string[] {
  return [
    ...t.instruments.map((k) => `I:${k}`),
    ...t.sectors.map((k) => `S:${k}`),
    ...t.indices.map((k) => `X:${k}`),
    ...t.markets.map((k) => `M:${k}`),
    ...(t.drivers ?? []).map((k) => `D:${k}`),
  ];
}

const MARKETS: ReadonlySet<string> = new Set<MarketTag>(['IN', 'GLOBAL']);

export function toIndexedArticle(row: NewsRowLike): IndexedArticle {
  const title = row.title.length > TITLE_MAX ? `${row.title.slice(0, TITLE_MAX - 1)}…` : row.title;
  return {
    id: row.id,
    title,
    source: row.source,
    sentiment: row.sentiment,
    publishedAt: row.publishedAt.getTime(),
    fetchedAt: row.fetchedAt.getTime(),
    dateInferred: row.dateInferred,
    tags: {
      instruments: [...row.instruments],
      sectors: [...row.sectors],
      indices: [...row.indices],
      markets: row.markets.filter((m): m is MarketTag => MARKETS.has(m)),
      ...(row.drivers && row.drivers.length ? { drivers: [...row.drivers] } : {}),
    },
  };
}
