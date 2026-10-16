import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const MODULES = join(__dirname, '..');
const FORBIDDEN = /execution|order|broker|angel|smart-?api|trade-engine|auto-trade|sentinel-executor|exit-discipline|trade-core/i;
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) && !/\.spec\.ts$/.test(n) ? [p] : [];
  });
}

describe('spec §13: news context code imports nothing that can trade', () => {
  const all = [...files(join(MODULES, 'news-events')), ...files(join(MODULES, 'night-jobs'))];
  it('finds the files it checks', () => expect(all.length).toBeGreaterThan(30));
  it.each(all.map((f) => [f.slice(MODULES.length + 1)]))('%s', (rel) => {
    const src = readFileSync(join(MODULES, rel), 'utf8');
    const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specs.filter((s) => FORBIDDEN.test(s))).toEqual([]);
  });
});
