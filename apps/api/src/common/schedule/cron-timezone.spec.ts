import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { CronExpression } from '@nestjs/schedule';

/**
 * CRON TIMEZONE RATCHET. The API runs on a UTC host. A `@Cron` without
 * `timeZone: 'Asia/Kolkata'` is evaluated in the host's zone, so a
 * market-time job like '25 15 * * 1-5' (EOD square-off) fires at 20:55 IST.
 *
 * Every `@Cron` whose hour, day-of-month or day-of-week field is not `*` is
 * time-of-day sensitive and must carry `timeZone`. Purely interval-style crons
 * (every N seconds/minutes all day) are exempt. An expression this scan cannot
 * resolve (a non-CronExpression identifier) must carry `timeZone` too.
 */
const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/** The full argument text of each `@Cron(...)` in `src`, balanced parens, multi-line. */
function cronArgs(src: string): Array<{ line: number; args: string }> {
  const found: Array<{ line: number; args: string }> = [];
  const re = /@Cron\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    found.push({
      line: src.slice(0, m.index).split('\n').length,
      args: src.slice(m.index + m[0].length, i - 1),
    });
  }
  return found;
}

/** The cron expression string, or null if it can't be resolved statically. */
function expressionOf(args: string): string | null {
  const literal = /^\s*(['"`])([^'"`]*)\1/.exec(args);
  if (literal) return literal[2];
  const enumRef = /^\s*CronExpression\.(\w+)/.exec(args);
  if (enumRef) return (CronExpression as Record<string, string>)[enumRef[1]] ?? null;
  return null;
}

function isTimeOfDaySensitive(expr: string): boolean {
  const f = expr.trim().split(/\s+/);
  const off = f.length === 6 ? 1 : 0; // six-field form leads with seconds
  const hour = f[off + 1];
  const dom = f[off + 2];
  const dow = f[off + 4];
  return [hour, dom, dow].some((x) => x !== undefined && x !== '*');
}

function offenders(): string[] {
  const out: string[] = [];
  for (const p of walk(SRC)) {
    const rel = relative(SRC, p).split(sep).join('/');
    for (const { line, args } of cronArgs(readFileSync(p, 'utf8'))) {
      const expr = expressionOf(args);
      const sensitive = expr === null || isTimeOfDaySensitive(expr);
      if (sensitive && !/\btimeZone\s*:/.test(args)) {
        out.push(`${rel}:${line} @Cron(${expr ?? args.trim().split(/[,\s]/)[0]})`);
      }
    }
  }
  return out.sort();
}

describe('cron timezone ratchet', () => {
  it('every time-of-day sensitive @Cron pins timeZone (the host clock is UTC)', () => {
    expect(offenders()).toEqual([]);
  });

  it('the scan finds the decorators at all (guards against a broken walk/regex)', () => {
    const total = walk(SRC).reduce(
      (n, p) => n + cronArgs(readFileSync(p, 'utf8')).length,
      0,
    );
    expect(total).toBeGreaterThan(30);
  });

  it('classifies expressions the way the rule says', () => {
    expect(isTimeOfDaySensitive('25 15 * * 1-5')).toBe(true);
    expect(isTimeOfDaySensitive('0 30 2 * * *')).toBe(true);
    expect(isTimeOfDaySensitive('*/15 * * * 1-5')).toBe(true);
    expect(isTimeOfDaySensitive('*/30 * * * * *')).toBe(false);
    expect(isTimeOfDaySensitive('0 */30 * * * *')).toBe(false);
    expect(expressionOf("CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'x' }")).toBe('0 02 * * *');
  });
});
