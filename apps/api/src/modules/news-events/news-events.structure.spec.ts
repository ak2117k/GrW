import { readFileSync } from 'fs';
import { join } from 'path';

/** The files the sentinel imports must stay import-free, so the cycle walk never reaches Prisma, HTTP or the news module. */
it.each(['types.ts', 'config.ts', 'news-context-config.ts'])('%s imports nothing', (f) => {
  expect(readFileSync(join(__dirname, f), 'utf8')).not.toMatch(/^\s*import\s/m);
});
it('keys.ts imports only ./types and ./config', () => {
  const specs = [...readFileSync(join(__dirname, 'keys.ts'), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  expect(specs.every((s) => s === './types' || s === './config')).toBe(true);
});
it('context-types.ts imports only types from ./types', () => {
  const src = readFileSync(join(__dirname, 'context-types.ts'), 'utf8');
  for (const m of src.matchAll(/^import\s+(.*)$/gm)) expect(m[1]).toMatch(/^type\s.*from '\.\/types';$/);
});
it.each(['news-index.port.ts', 'events.port.ts', 'position-news.port.ts', 'news-feedback.port.ts'])('the sentinel port %s is type-only', (f) => {
  const src = readFileSync(join(__dirname, '..', 'trade-sentinel', 'ports', f), 'utf8');
  for (const m of src.matchAll(/^import\s+(.*)$/gm)) expect(m[1]).toMatch(/^type\s/);
});
