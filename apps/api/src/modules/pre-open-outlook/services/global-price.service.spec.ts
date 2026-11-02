import { readFileSync } from 'fs';
import { join } from 'path';
import type { FetchLike } from '../../market-cues/fetchers/cue-http';
import type { SnapshotRow } from '../pre-open-outlook.repository';
import { GlobalPriceService } from './global-price.service';

const body = readFileSync(join(__dirname, '..', '__fixtures__', 'yahoo-clf-1h-2026-11-02.json'), 'utf8');
const NOW = new Date('2026-11-02T03:00:00Z');

function make(fetchImpl: FetchLike) {
  const rows: SnapshotRow[] = [];
  const repo = { insertSnapshot: jest.fn(async (r: SnapshotRow) => void rows.push(r)) };
  const svc = new GlobalPriceService(repo as never, fetchImpl);
  svc.retryDelayMs = 0;
  return { svc, rows };
}

describe('GlobalPriceService', () => {
  it('stores one OK row per symbol with the price, its own time and the hourly bars', async () => {
    const fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => body })) as unknown as FetchLike;
    const { svc, rows } = make(fetch);
    const out = await svc.snapshot(NOW);
    expect(out.map((o) => o.status)).toEqual(['OK', 'OK', 'OK']);
    expect(rows[0]).toMatchObject({ symbol: 'CL=F', status: 'OK', price: 100.71, intervalMs: 3_600_000 });
    expect(rows[0].priceTime).toBeInstanceOf(Date);
    expect(rows[0].bars?.length).toBeGreaterThan(10);
  });

  it('a failing fetch is a NO_DATA row with the reason — never a zero, never a throw', async () => {
    const fetch = jest.fn(async () => ({ ok: false, status: 429, text: async () => '' })) as unknown as FetchLike;
    const { svc, rows } = make(fetch);
    const r = await svc.chart('CL=F');
    expect(r).toEqual({ ok: false, reason: 'HTTP 429', source: 'Yahoo chart CL=F' });
    const out = await svc.snapshot(NOW);
    expect(out.every((o) => o.status === 'NO_DATA')).toBe(true);
    expect(rows[0]).toMatchObject({ status: 'NO_DATA', price: null, priceTime: null, reason: 'HTTP 429', bars: null });
  });

  it('a non-JSON or result-less payload is NO_DATA too', async () => {
    const html = jest.fn(async () => ({ ok: true, status: 200, text: async () => '<html>blocked</html>' })) as unknown as FetchLike;
    expect((await make(html).svc.chart('BZ=F')).ok).toBe(false);
    const empty = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }) })) as unknown as FetchLike;
    const r = await make(empty).svc.chart('XX=F');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('No data found');
  });
});
