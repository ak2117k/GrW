/**
 * News impact layer 1b (2026-10-24): what KIND of news an article is, from rules on its text.
 *
 * NSE corporate announcements are ~550 rows a weekday and most are routine filings ("Copy of
 * Newspaper Publication", "Analysts/Institutional Investor Meet", trading-window notices …). Those
 * are BOILERPLATE and never go further (no LLM, no idea, no alert). The MATERIAL types are the ones
 * that move a stock. The same material rules tag RSS headlines ("X wins ₹2,000 cr order"), where the
 * default is NEWS (a general story — relevance alone decides whether it is analysed).
 *
 * For an NSE row the stored title is `SYMBOL: <subject> — <attachment text>` (nse-announcements.ts).
 * Boilerplate is decided on the SUBJECT first (a newspaper publication OF results is still a
 * newspaper publication); material on subject + text (an "Outcome of Board Meeting" whose text says
 * "approved the financial results" is RESULTS).
 */

export const MATERIAL_TYPES = [
  'RESULTS',
  'ORDER_WIN',
  'M_AND_A',
  'PLEDGE',
  'CREDIT_RATING',
  'BLOCK_DEAL',
  'MANAGEMENT_CHANGE',
  'BUYBACK',
  'FUND_RAISING',
  'CORPORATE_ACTION',
  'LITIGATION_REGULATORY',
  'GUIDANCE_UPDATE',
] as const;
export type MaterialKind = (typeof MATERIAL_TYPES)[number];
/** BOILERPLATE: routine filing. OTHER: an NSE filing that is neither. NEWS: an RSS story with no material keyword. */
export type MaterialType = MaterialKind | 'BOILERPLATE' | 'OTHER' | 'NEWS';

export interface Classification {
  type: MaterialType;
  material: boolean;
  boilerplate: boolean;
}

export const NSE_ANNOUNCEMENTS = 'NSE Announcements';

/** Routine filings, matched on the NSE subject (and, for a few, on the text). Order matters only for readability. */
const BOILERPLATE: readonly RegExp[] = [
  /newspaper (publication|advertisement)/i,
  /analysts?\s*\/?\s*institutional investor meet/i,
  /\b(con\.?|conference) call (updates?|intimation)/i,
  /investor (meet|presentation)/i,
  /trading window/i,
  /certificate under (sebi|reg)/i,
  /regulation 74|reg\.? ?74|depositories and participants/i,
  /loss of (share )?certificates?|duplicate (share )?certificates?|issue of duplicate/i,
  /\b(esop|esos|esps|esrs|employee stock (option|purchase)|employees? stock)/i,
  /change in (the )?(registrar|rta)|registrar (and|&) (share )?transfer agent/i,
  /compliance certificate|reconciliation of share capital|statement of investor complaints/i,
  /board meeting intimation|intimation of board meeting|prior intimation/i,
  /notice of (the )?(agm|egm|annual general|postal ballot)|record date for (agm|e-?voting)|scrutini[sz]er'?s? report|voting results/i,
  /annual report|business responsibility|secretarial (audit|compliance)/i,
  /shareholding pattern|disclosures? under (sebi )?\(?(sast|substantial acquisition)|reg(ulation)? 31\b/i,
  /closure of (the )?trading window|copy of (the )?(letter|intimation)/i,
  /(change|updation) of (e-?mail|address|website|contact)/i,
  /\bclarification\b.*\b(price movement|volume)\b|price movement/i,
  /certificate (from|of) (the )?(statutory )?auditor|related party transactions?/i,
];

const MATERIAL: ReadonlyArray<[MaterialKind, RegExp]> = [
  ['PLEDGE', /\bpledge|revocation|invocation|encumbrance/i],
  ['BUYBACK', /\bbuy-?back/i],
  ['CREDIT_RATING', /credit rating|\brating (upgrade|downgrade|reaffirm)|\b(crisil|icra|care ratings|india ratings|moody'?s|fitch|s&p)\b/i],
  ['BLOCK_DEAL', /\b(block|bulk) deals?\b/i],
  ['RESULTS', /financial results?|\bresults\b|\bq[1-4]\b.*\b(profit|loss|revenue|earnings)|\b(net )?profit (rises|falls|jumps|drops|up|down)|\bearnings\b/i],
  ['M_AND_A', /\b(acqui(re|res|red|sition|ring)|merger|amalgamation|demerger|takeover|open offer|scheme of arrangement|stake (sale|purchase|buy)|divest(ment|s)?|joint venture)\b/i],
  ['FUND_RAISING', /fund ?rais|\bqip\b|qualified institutions? placement|rights issue|preferential (issue|allotment)|\bncds?\b|\bdebentures?\b|\bwarrants?\b|\bipo\b|\bofs\b|offer for sale/i],
  ['CORPORATE_ACTION', /\bdividend|\bbonus (issue|shares?)?|stock split|sub-?division|split of (equity )?shares/i],
  ['ORDER_WIN', /\b(order|contract)s? (win|won|received|bagged|secured|worth|of|from)|\bwins?\b.*\b(order|contract)|letter of (award|intent)|\bloa\b|\bbags?\b|\bsecures?\b.*\b(order|contract|deal)/i],
  ['MANAGEMENT_CHANGE', /resign|appointment of (ceo|cfo|md|managing director|chairman|whole[- ]time director|key managerial)|cessation|change in (directorate|management|kmp|key managerial)|\b(ceo|cfo|md)\b.*\b(quits|steps down|appointed|exit)/i],
  ['LITIGATION_REGULATORY', /litigation|penalty|\bsebi order|show cause|\bnclt\b|insolvency|\bcirp\b|\bdefault|fraud|\bsearch\b|\braid|income tax|\bgst\b (demand|notice)|warning letter|import alert|\busfda\b|\bfda\b|\bobservations?\b|\bcourt\b|arbitration|tribunal|regulatory action/i],
  ['GUIDANCE_UPDATE', /guidance|business update|operational update|sales (update|numbers)|production (update|numbers)|monthly (sales|business)|capacity (expansion|addition)|commission(ing|ed)|plant (shut|closure)|strike|lockout/i],
];

/** The NSE subject of a stored NSE title (`SYM: subject — text`), else the title itself. */
export function nseSubject(title: string): { subject: string; text: string } {
  const m = /^[A-Z0-9&.-]{1,20}:\s*(.*)$/s.exec(title.trim());
  const rest = m ? m[1] : title;
  const dash = rest.indexOf(' — ');
  return dash >= 0 ? { subject: rest.slice(0, dash).trim(), text: rest.slice(dash + 3).trim() } : { subject: rest.trim(), text: '' };
}

/** The first material kind any rule finds in `text`, or null. */
export function materialKind(text: string): MaterialKind | null {
  for (const [kind, re] of MATERIAL) if (re.test(text)) return kind;
  return null;
}

/**
 * Classify one article. `source` decides the default: an NSE filing that is neither boilerplate nor
 * material is OTHER (not analysed); an RSS story is NEWS (analysed when relevant).
 */
export function classifyArticle(a: { title: string; summary?: string | null; source: string }): Classification {
  if (a.source === NSE_ANNOUNCEMENTS) {
    const { subject, text } = nseSubject(a.title);
    if (BOILERPLATE.some((re) => re.test(subject))) return { type: 'BOILERPLATE', material: false, boilerplate: true };
    // Subject first: "Credit Rating" with text "…to discuss results" stays CREDIT_RATING.
    const kind = materialKind(subject) ?? materialKind(`${text} ${a.summary ?? ''}`);
    if (kind) return { type: kind, material: true, boilerplate: false };
    // A boilerplate phrase in the text only (e.g. ESOP allotment under "Allotment of Securities").
    if (BOILERPLATE.some((re) => re.test(text))) return { type: 'BOILERPLATE', material: false, boilerplate: true };
    return { type: 'OTHER', material: false, boilerplate: false };
  }
  const kind = materialKind(`${a.title} ${a.summary ?? ''}`);
  return kind ? { type: kind, material: true, boilerplate: false } : { type: 'NEWS', material: false, boilerplate: false };
}

/** Combine the classifications of a cluster's articles: any material kind wins, boilerplate only if all are. */
export function combineTypes(types: readonly MaterialType[]): Classification {
  const material = types.find((t): t is MaterialKind => (MATERIAL_TYPES as readonly string[]).includes(t));
  if (material) return { type: material, material: true, boilerplate: false };
  if (types.length > 0 && types.every((t) => t === 'BOILERPLATE')) return { type: 'BOILERPLATE', material: false, boilerplate: true };
  if (types.includes('NEWS')) return { type: 'NEWS', material: false, boilerplate: false };
  return { type: types.includes('OTHER') ? 'OTHER' : 'NEWS', material: false, boilerplate: false };
}
