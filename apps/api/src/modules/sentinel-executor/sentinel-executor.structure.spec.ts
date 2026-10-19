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

  it('cancelOrder has exactly one call site in executor source (the intent-recorded `cancelProtective`), classified only', () => {
    const sites = source().flatMap((f) =>
      [...code(f).matchAll(/\.cancelOrder(Classified)?\(/g)].map((m) => `${relative(__dirname, f).replace(/\\/g, '/')}:${m[0]}`));
    expect(sites).toEqual(['services/sentinel-exit-executor.service.ts:.cancelOrderClassified(']);
    const modify = source().filter((f) => /\.modifyOrder\(/.test(code(f)));
    expect(modify).toEqual([]);
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

describe('exit gate shape (exit discipline, Review Focus 1)', () => {
  it('the executor consults the gate only on trigger === \'AI\' (positive match, never !== MANUAL)', () => {
    const src = code(join(__dirname, 'services', 'sentinel-exit-executor.service.ts'));
    const sites = [...src.matchAll(/this\.gate\.(load|decide|enabled)\(/g)];
    expect(sites.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/const gated = trigger === 'AI'/);
  });
  it('the gate decides before the dry-run branch and before any protective cancel', () => {
    const src = code(join(__dirname, 'services', 'sentinel-exit-executor.service.ts'));
    // execute() asks for the gate record (gateRecord → gate.decide) exactly once.
    expect([...src.matchAll(/this\.gateRecord\(/g)]).toHaveLength(1);
    expect(src).toMatch(/const gate = gated \? await this\.gateRecord\(/);
    const decide = src.indexOf('this.gateRecord(');
    expect(decide).toBeLessThan(src.indexOf("cfg.mode === 'dry-run'"));
    expect(decide).toBeLessThan(src.indexOf('this.cancelProtective('));
    expect(decide).toBeLessThan(src.indexOf("this.place(s, run, o, 'M')"));
  });
  it('no new exit-discipline file in this module writes to the broker', () => {
    for (const f of ['services/exit-gate.service.ts', 'repositories/exit-gate.repository.ts']) {
      expect(code(join(__dirname, f))).not.toMatch(/placeOrder|cancelOrder|modifyOrder|withOwnerSession/);
    }
  });
});

describe('manual exits stay out of the AI corpus (owner Exit button)', () => {
  const all = () => files(MODULES).filter((f) => !f.endsWith('.spec.ts'));
  /**
   * The one sanctioned reader outside the executor: the sentinel's futile
   * re-judge rule reads ONLY the latest attempt's status / reason / createdAt per
   * open tracker, to stop asking the judge for exits that cannot run. It is not a
   * corpus and never writes; the two modules still meet only in the database.
   */
  const SANCTIONED_READERS = ['trade-sentinel/repositories/exit-attempt.reader.ts'];

  it('only sentinel-executor reads ai_exit_executions — no corpus writer can mistake a manual exit for an AI decision', () => {
    const offenders = all()
      .filter((f) => !f.includes(`${join('modules', 'sentinel-executor')}`))
      .filter((f) => !SANCTIONED_READERS.includes(relative(MODULES, f).replace(/\\/g, '/')))
      .filter((f) => /aiExitExecution|ai_exit_executions/.test(code(f)))
      .map((f) => relative(MODULES, f).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('the sanctioned reader stays read-only and selects no corpus fields', () => {
    for (const rel of SANCTIONED_READERS) {
      const src = code(join(MODULES, rel));
      expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|aiExitExecution\s*\.\s*(create|update|upsert|delete)/i);
      expect(src).not.toMatch(/"(fillPrice|orderLtp|decisionLtp|verdictId|brokerOrderId)"/);
    }
  });

  it('the executor never writes a sentinel_verdicts row (a manual exit is not fabricated as a verdict)', () => {
    const offenders = source().filter((f) => /sentinelVerdict\s*\.\s*(create|createMany|upsert|update|updateMany)\(/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

describe('price triggers stay inside the executor (price-triggers plan, Review Focus 7)', () => {
  const all = () => files(MODULES).filter((f) => !f.endsWith('.spec.ts'));

  it('only sentinel-executor names sentinel_exit_triggers — trade-sentinel never reads or writes it', () => {
    const offenders = all()
      .filter((f) => !f.includes(join('modules', 'sentinel-executor')))
      .filter((f) => /sentinelExitTrigger|sentinel_exit_triggers/.test(code(f)))
      .map((f) => relative(MODULES, f).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('the tick path (trigger-book, confirmation) imports nothing but its own domain files', () => {
    for (const name of ['trigger-book.ts', 'confirmation.ts']) {
      const specs = specifiers(join(__dirname, 'domain', name));
      expect(specs.every((s) => s.startsWith('./'))).toBe(true);
    }
  });

  it('the trigger watcher reaches orders only through the executor (no placeOrder of its own)', () => {
    const w = code(join(__dirname, 'services', 'trigger-watch.service.ts'));
    expect(w).not.toMatch(/placeOrder|getPositionsEnvelope|getOrderBookEnvelope|withOwnerSession/);
    expect(w).toMatch(/bootJobsEnabled\(\)/);
  });
});
