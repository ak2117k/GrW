import { BLOCKED_ALIASES, COMMON_WORD_BLOCKLIST, CURATED_ALIASES } from './curated-aliases';

export type AliasKind = 'official' | 'derived' | 'curated' | 'blocked';
export interface AliasRow { symbol: string; alias: string; kind: AliasKind }

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "Tata Motors Limited" → "Tata Motors"; "(India)", "Ltd." and "& Co" stripped, repeatedly. */
export function stripSuffixes(name: string): string {
  let s = clean(name);
  for (;;) {
    const next = clean(s.replace(/\s*\((?:India|I)\)\s*$/i, '').replace(/\s+(?:Limited|Ltd\.?)$/i, '').replace(/\s*&\s*Co\.?$/i, ''));
    if (next === s) return s;
    s = next;
  }
}

function admissible(alias: string, blocklist: ReadonlySet<string>): boolean {
  const words = alias.split(' ');
  if (!/[a-z]/.test(alias)) return false; // an all-caps "name" carries no case signal; tickers cover it
  if (words.length === 1) {
    const letters = alias.replace(/[^A-Za-z]/g, '');
    return letters.length >= 6 && !blocklist.has(alias.toLowerCase());
  }
  return true;
}

/**
 * Spec §5.2: official name + suffix-stripped name per symbol; single words need ≥ 6
 * letters and must not be a common word; an alias two symbols share is dropped;
 * curated short forms are added last (and win over a derived twin); blocked text is removed.
 * Sorted by symbol, then alias.
 */
export function deriveAliases(
  rows: ReadonlyArray<{ symbol: string; name: string }>,
  curated: Readonly<Record<string, string>> = CURATED_ALIASES,
  blocklist: ReadonlySet<string> = COMMON_WORD_BLOCKLIST,
  blocked: ReadonlySet<string> = BLOCKED_ALIASES,
): AliasRow[] {
  const candidates: AliasRow[] = [];
  for (const r of rows) {
    const official = clean(r.name);
    const derived = stripSuffixes(official);
    if (official && admissible(official, blocklist)) candidates.push({ symbol: r.symbol, alias: official, kind: 'official' });
    if (derived && derived !== official && admissible(derived, blocklist)) candidates.push({ symbol: r.symbol, alias: derived, kind: 'derived' });
  }
  const owners = new Map<string, Set<string>>();
  for (const c of candidates) owners.set(c.alias, (owners.get(c.alias) ?? new Set<string>()).add(c.symbol));
  const out = candidates.filter((c) => owners.get(c.alias)!.size === 1 && !blocked.has(c.alias) && curated[c.alias] === undefined);
  for (const [alias, symbol] of Object.entries(curated)) if (!blocked.has(alias)) out.push({ symbol, alias, kind: 'curated' });
  return out.sort((a, b) => (a.symbol === b.symbol ? a.alias.localeCompare(b.alias) : a.symbol.localeCompare(b.symbol)));
}

/** NSE EQUITY_L.csv → (symbol, name). Header names are trimmed (NSE pads them with spaces). */
export function parseEquityL(csv: string): Array<{ symbol: string; name: string }> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = splitCsv(lines[0]).map((h) => h.trim().toUpperCase());
  const iSym = header.indexOf('SYMBOL');
  const iName = header.indexOf('NAME OF COMPANY');
  if (iSym < 0 || iName < 0) throw new Error(`EQUITY_L header not recognised: ${lines[0].slice(0, 80)}`);
  return lines
    .slice(1)
    .map(splitCsv)
    .filter((c) => c[iSym] && c[iName])
    .map((c) => ({ symbol: c[iSym].trim().toUpperCase(), name: clean(c[iName]) }));
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
