import { SOURCE_DOWN_AFTER, SourceHealthBook } from './source-health';

it('tracks failures, names a source down after 6, logs only on state changes', () => {
  const lines: string[] = [];
  const h = new SourceHealthBook((l) => lines.push(l));
  const t = (m: number) => new Date(Date.UTC(2026, 9, 16, 4, m));
  h.ok('ET', 12, t(0));
  for (let i = 1; i <= SOURCE_DOWN_AFTER; i++) h.fail('MoneyControl', 'HTTP 403', t(i));
  expect(h.down()).toEqual(['MoneyControl']);
  expect(h.lastOkAt()).toBe(t(0).toISOString());
  expect(lines).toEqual([
    '[news-source] ET OK (12 items)',
    '[news-source] MoneyControl failing (1 consecutive): HTTP 403',
    '[news-source] MoneyControl DOWN (6 consecutive): HTTP 403',
  ]);
  h.ok('MoneyControl', 3, t(9));
  expect(h.down()).toEqual([]);
  expect(lines[3]).toBe('[news-source] MoneyControl OK (3 items)');
  h.ok('ET', 10, t(10)); // no state change, no line
  expect(lines).toHaveLength(4);
  expect(h.lastOkAt()).toBe(t(10).toISOString());
});
