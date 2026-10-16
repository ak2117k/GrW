import type { MarketTag } from '../types';

const IN_RE = /\b(?:RBI|Reserve Bank of India|SEBI|GST|MPC|India(?:'s)? (?:CPI|inflation|GDP))\b/;
const GLOBAL_RE = /\b(?:Fed|FOMC|Federal Reserve|Powell|US (?:CPI|inflation|jobs|payrolls|GDP)|ECB|China|Treasury yields?|Wall Street)\b/;

/** Spec §5.5. Case-sensitive keywords: "the fed-up investor" is not the Fed. */
export function marketTags(category: string, text: string): MarketTag[] {
  const out: MarketTag[] = [];
  if (category === 'indian' || IN_RE.test(text)) out.push('IN');
  if (category === 'global' || GLOBAL_RE.test(text)) out.push('GLOBAL');
  return out;
}

/** The ET sector feeds (spec §5.4). Keys are RSS source names in news-aggregator.service.ts. */
export const FEED_SECTOR: Readonly<Record<string, readonly string[]>> = {
  'ET Auto': ['NIFTY AUTO'],
  'ET Tech': ['NIFTY IT'],
  'ET Pharma': ['NIFTY PHARMA'],
  'ET BFSI': ['NIFTY BANK', 'NIFTY FIN SERVICE'],
  'ET Energy': ['NIFTY ENERGY'],
  'ET Realty': ['NIFTY REALTY'],
};

const SECTOR_PHRASES: ReadonlyArray<{ re: RegExp; sector: string }> = [
  { re: /\bPSU banks?\b/i, sector: 'NIFTY PSU BANK' },
  { re: /\b(?:private|pvt) (?:sector )?banks?\b/i, sector: 'NIFTY PVT BANK' },
  { re: /\bbank(?:ing)? (?:stocks|shares|sector)\b/i, sector: 'NIFTY BANK' },
  { re: /\bIT (?:stocks|shares|sector|companies|services|majors)\b/, sector: 'NIFTY IT' },
  { re: /\bauto (?:sales|stocks|shares|sector)\b/i, sector: 'NIFTY AUTO' },
  { re: /\bpharma (?:stocks|shares|sector|companies)\b/i, sector: 'NIFTY PHARMA' },
  { re: /\bmetal (?:stocks|shares|sector)\b/i, sector: 'NIFTY METAL' },
  { re: /\bFMCG (?:stocks|shares|sector|companies)\b/i, sector: 'NIFTY FMCG' },
  { re: /\brealty (?:stocks|shares|sector)\b/i, sector: 'NIFTY REALTY' },
  { re: /\bNBFCs?\b/, sector: 'NIFTY FIN SERVICE' },
];

/** Sector phrases in the text (spec §5.4), in table order, de-duplicated. */
export function sectorPhraseTags(text: string): string[] {
  const out: string[] = [];
  for (const p of SECTOR_PHRASES) if (p.re.test(text) && !out.includes(p.sector)) out.push(p.sector);
  return out;
}
