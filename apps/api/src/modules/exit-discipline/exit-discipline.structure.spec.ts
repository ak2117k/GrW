import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const IMPORT = /from\s+['"]([^'"]+)['"]/g;
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

describe('exit-discipline is pure and self-contained', () => {
  it('no source file imports anything outside exit-discipline (type-only @prisma/client excepted)', () => {
    const root = __dirname;
    const offenders: string[] = [];
    for (const f of files(root)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(IMPORT)) {
        const spec = m[1];
        if (spec.startsWith('.')) {
          if (!resolve(join(f, '..'), spec).startsWith(root)) offenders.push(`${f}: ${spec}`);
        } else if (!(spec === '@prisma/client' && /import\s+type/.test(text.slice(Math.max(0, m.index! - 200), m.index)))) {
          offenders.push(`${f}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source file touches Nest, Prisma at runtime, timers or the broker', () => {
    const bad = files(__dirname).filter((f) =>
      /@nestjs|new PrismaClient|setInterval|setTimeout|placeOrder|cancelOrder|getCandles/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
