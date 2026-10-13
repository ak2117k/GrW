// apps/api/src/modules/sentinel-executor/sentinel-executor.structure.spec.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const MODULES = join(__dirname, '..');
const IMPORT = /from\s+['"]([^'"]+)['"]/g;

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const specifiers = (f: string) => [...readFileSync(f, 'utf8').matchAll(IMPORT)].map((m) => m[1]);
const source = () => files(__dirname).filter((f) => !f.endsWith('.spec.ts'));
/** Source text with line and block comments removed, so prose cannot trip a check. */
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('sentinel-executor is decoupled from trade-sentinel (spec §4, plan R14)', () => {
  it('no executor file imports anything from trade-sentinel', () => {
    const own = files(__dirname);
    expect(own.length).toBeGreaterThan(8);
    const offenders = own.filter((f) => specifiers(f).some((s) => s.includes('trade-sentinel')));
    expect(offenders).toEqual([]);
  });

  it('no trade-sentinel file imports the executor', () => {
    const sentinel = files(join(MODULES, 'trade-sentinel'));
    expect(sentinel.length).toBeGreaterThan(10);
    const offenders = sentinel.filter((f) => specifiers(f).some((s) => s.includes('sentinel-executor')));
    expect(offenders).toEqual([]);
  });

  it('the sentinel shadow-mode spec this module relies on still exists', () => {
    expect(existsSync(join(MODULES, 'trade-sentinel', 'services', 'sentinel-cycle.service.spec.ts'))).toBe(true);
  });
});

describe('sentinel-executor safety shape (plan Global Constraints, Review Focus)', () => {
  it('placeOrder has exactly one call site in executor source (the claimed, single-leg `place`)', () => {
    const sites = source().flatMap((f) =>
      [...code(f).matchAll(/\.placeOrder(Classified)?\(/g)].map(() => relative(__dirname, f).replace(/\\/g, '/')));
    expect(sites).toEqual(['services/sentinel-exit-executor.service.ts']);
  });

  it('only the classified placement is used (review fix 1: the legacy mapping turns an SDK `{}` into REJECTED)', () => {
    const legacy = source().filter((f) => /\.placeOrder\(/.test(code(f)));
    expect(legacy).toEqual([]);
  });

  it('never consults the core kill switch (exits are never blocked) and never uses the env-first feed login', () => {
    const offenders = source().filter((f) => /coreEntryAllowed|KillSwitch|AngelOneAuthService/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('adds no @Cron (background work is a bootJobsEnabled-gated setInterval)', () => {
    const offenders = source().filter((f) => /@Cron\(/.test(code(f)));
    expect(offenders).toEqual([]);
    const poller = code(join(__dirname, 'services', 'sentinel-exit-poller.service.ts'));
    expect(poller).toMatch(/bootJobsEnabled\(\)/);
  });
});
