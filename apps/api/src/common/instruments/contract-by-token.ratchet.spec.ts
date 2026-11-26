import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * CONTRACT-BY-TOKEN RATCHET. Angel re-uses a derivative's token after expiry and the instrument master
 * keeps the expired row, so a lookup keyed on (exchange, token) alone can return a dead contract of
 * another underlying (2026-11-26: BHEL 29DEC 420 PE read as BDL 25AUG 1500 CE). Every such lookup must
 * go through `contractByToken` / `contractsByTokens` (./contract-by-token.ts).
 *
 * Flagged: a Prisma `instrument.find*` whose `where` names `token` but neither `symbol` (symbol + token
 * is unique) nor `name:` (a chain query by underlying, token only a filter), and raw SQL joining
 * "instruments" on token without symbol.
 */
const SRC = join(__dirname, '..', '..');

/** Deliberate exceptions, each with its reason. Keep this list short. */
const ALLOWED: Record<string, string> = {
  // The master repair must see every row for a token, inactive and differently named ones included.
  'modules/market-data/repositories/market-data.repository.ts#findInstrumentsByExchangeToken': 'master repair',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/** Text between the bracket at `open` and its match. */
function balanced(src: string, open: number): string {
  const o = src[open];
  const c = o === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** The enclosing method name of a position (for the allowlist key). */
function methodAt(src: string, pos: number): string {
  const before = src.slice(0, pos);
  const re = /^\s*(?:(?:public|private|protected|static|async)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/gm;
  let m: RegExpExecArray | null;
  let last = '?';
  while ((m = re.exec(before))) if (!['if', 'for', 'while', 'switch', 'return', 'catch'].includes(m[1])) last = m[1];
  return last;
}

export function offendersIn(rel: string, src: string): string[] {
  const out: string[] = [];
  const re = /\binstrument\.(findFirst|findFirstOrThrow|findMany|findUnique|findUniqueOrThrow)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const args = balanced(src, m.index + m[0].length - 1);
    const w = /\bwhere\s*:\s*\{/.exec(args);
    if (!w) continue;
    const where = balanced(args, w.index + w[0].length - 1);
    // symbol + token is unique; a `name:` query selects a whole chain, token is then only a filter.
    if (!/\btoken\b/.test(where) || /\bsymbol\b|\bname\s*:/.test(where)) continue;
    const key = `${rel}#${methodAt(src, m.index)}`;
    if (ALLOWED[key]) continue;
    out.push(`${key} (line ${src.slice(0, m.index).split('\n').length})`);
  }
  // Raw SQL: JOIN "instruments" ... ON ...token... without symbol in the ON clause.
  const sql = /JOIN\s+"?instruments"?\s+\w+\s+ON\s+([^\n]*?)(?=\n|WHERE|JOIN|LEFT|ORDER|GROUP|$)/gi;
  while ((m = sql.exec(src))) {
    if (/\btoken\b/.test(m[1]) && !/\bsymbol\b/.test(m[1])) out.push(`${rel}#sql (line ${src.slice(0, m.index).split('\n').length})`);
  }
  return out;
}

function offenders(): string[] {
  const out: string[] = [];
  for (const p of walk(SRC)) {
    const rel = relative(SRC, p).split(sep).join('/');
    if (rel === 'common/instruments/contract-by-token.ts') continue;
    out.push(...offendersIn(rel, readFileSync(p, 'utf8')));
  }
  return out.sort();
}

describe('contract-by-token ratchet', () => {
  it('no instrument lookup keyed on token alone outside contractByToken', () => {
    expect(offenders()).toEqual([]);
  });

  it('the scan sees instrument lookups at all (guards against a broken walk/regex)', () => {
    const n = walk(SRC).reduce((k, p) => k + (readFileSync(p, 'utf8').match(/\binstrument\.find\w*\(/g)?.length ?? 0), 0);
    expect(n).toBeGreaterThan(20);
  });

  it('flags the shapes it should and passes the ones it should', () => {
    const f = (s: string) => offendersIn('x.ts', `class A {\n  async m() {\n    ${s}\n  }\n}`);
    expect(f('await this.prisma.instrument.findFirst({ where: { exchange, token }, select: { id: true } })')).toHaveLength(1);
    expect(f('await this.prisma.instrument.findMany({\n  where: { OR: refs.map((r) => ({ exchange: r.exchange, token: r.token })) },\n})')).toHaveLength(1);
    expect(f("await this.prisma.instrument.findMany({ where: { exchange: 'NFO', token: { in: tokens } } })")).toHaveLength(1);
    expect(f('await this.prisma.instrument.findFirst({ where: { exchange, symbol, token } })')).toHaveLength(0);
    expect(f("await this.prisma.instrument.findFirst({ where: { symbol, exchange: 'NSE' }, select: { token: true } })")).toHaveLength(0);
    expect(f('await this.prisma.instrument.findMany({ where: { name: n, isActive: true, token: LISTED_TOKEN } })')).toHaveLength(0);
    expect(f('const r = await this.prisma.$queryRaw`SELECT 1 FROM t LEFT JOIN "instruments" i ON i.token = t.token AND i.exchange = t.exchange\n WHERE x`')).toHaveLength(1);
    expect(f('const r = await this.prisma.$queryRaw`SELECT 1 FROM t LEFT JOIN "instruments" i ON i.token = t.token AND i.symbol = t.symbol\n WHERE x`')).toHaveLength(0);
  });
});
