import { Logger } from '@nestjs/common';
import {
  ChartContextService,
  deriveChartContextStatus,
  type ChartContextSources,
  type SourceState,
} from './chart-context.service';

const KEY = { token: '1594', exchange: 'NSE', interval: '15m' };

const LEVELS = { pdh: 110, pdl: 90, vwap: 100 } as never;
const ZONE = { id: 'z1' } as never;
const EVIDENCE = { price: 105, side: 'resistance' } as never;

function loaders(over: Partial<Record<'levels' | 'zones' | 'evidence', () => Promise<never>>> = {}) {
  return {
    levels: over.levels ?? (async () => LEVELS),
    zones: over.zones ?? (async () => [ZONE] as never),
    evidence: over.evidence ?? (async () => [EVIDENCE] as never),
  } as never;
}

describe('deriveChartContextStatus — full truth table', () => {
  const states: SourceState[] = ['ok', 'empty', 'failed'];

  /**
   * Exhaustive over all 3^4 source-state combinations, because the three
   * outcomes are exactly what the chip renders and a wrong one is the bug this
   * change exists to kill (claiming "no levels" while broken).
   */
  it('is ready iff nothing failed, unavailable iff everything failed, partial otherwise', () => {
    for (const levels of states)
      for (const zones of states)
        for (const evidence of states)
          for (const trend of states) {
            const sources: ChartContextSources = { levels, zones, evidence, trend };
            const failed = [levels, zones, evidence, trend].filter((s) => s === 'failed').length;
            const expected =
              failed === 0 ? 'ready' : failed === 4 ? 'unavailable' : 'partial';
            expect(deriveChartContextStatus(sources)).toBe(expected);
          }
  });

  it('treats an all-empty response as ready — "genuinely no levels" is an answer', () => {
    expect(
      deriveChartContextStatus({
        levels: 'empty',
        zones: 'empty',
        evidence: 'empty',
        trend: 'empty',
      }),
    ).toBe('ready');
  });
});

describe('ChartContextService', () => {
  let svc: ChartContextService;
  beforeEach(() => {
    svc = new ChartContextService();
    // Per-source failures are logged by design; keep the test output readable.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('composes all three sources on the happy path', async () => {
    const dto = await svc.build(KEY, loaders());
    expect(dto).toEqual({
      interval: '15m',
      levels: LEVELS,
      zones: [ZONE],
      evidence: [EVIDENCE],
      trend: null,
      status: 'ready',
      sources: { levels: 'ok', zones: 'ok', evidence: 'ok', trend: 'empty' },
    });
  });

  it('keeps the surviving sources intact when ONE source throws', async () => {
    const dto = await svc.build(
      KEY,
      loaders({
        zones: async () => {
          throw new Error('zone detector exploded');
        },
      }),
    );
    expect(dto.status).toBe('partial');
    expect(dto.sources).toEqual({
      levels: 'ok',
      zones: 'failed',
      evidence: 'ok',
      trend: 'empty',
    });
    // The whole point: a failed source must not take the others with it.
    expect(dto.levels).toBe(LEVELS);
    expect(dto.evidence).toEqual([EVIDENCE]);
    expect(dto.zones).toEqual([]);
  });

  it('returns unavailable — not a throw — when every source fails', async () => {
    const boom = async () => {
      throw new Error('down');
    };
    const dto = await svc.build(KEY, loaders({ levels: boom, zones: boom, evidence: boom }) );
    expect(dto.status).toBe('unavailable');
    expect(dto.sources).toEqual({
      levels: 'failed',
      zones: 'failed',
      evidence: 'failed',
      trend: 'empty',
    });
    expect(dto.levels).toBeNull();
    expect(dto.zones).toEqual([]);
    expect(dto.evidence).toEqual([]);
  });

  it('marks a successful-but-empty source empty, not failed, and stays ready', async () => {
    const dto = await svc.build(KEY, loaders({
      levels: async () => null as never,
      zones: async () => [] as never,
      evidence: async () => [] as never,
    }));
    expect(dto.status).toBe('ready');
    expect(dto.sources).toEqual({
      levels: 'empty',
      zones: 'empty',
      evidence: 'empty',
      trend: 'empty',
    });
  });

  it('serves a second call for the same key from cache (collapses the poll)', async () => {
    const levels = jest.fn(async () => LEVELS);
    const first = await svc.build(KEY, loaders({ levels: levels as never }));
    const second = await svc.build(KEY, loaders({ levels: levels as never }));
    expect(second).toBe(first);
    expect(levels).toHaveBeenCalledTimes(1);
  });

  it('caches per token:exchange:interval, so switching timeframe recomputes', async () => {
    const dto15 = await svc.build(KEY, loaders());
    const dto1h = await svc.build({ ...KEY, interval: '1h' }, loaders());
    expect(dto15.interval).toBe('15m');
    expect(dto1h.interval).toBe('1h');
  });

  it('never caches a total outage — the next poll retries', async () => {
    const boom = async () => {
      throw new Error('down');
    };
    await svc.build(KEY, loaders({ levels: boom, zones: boom, evidence: boom }));
    const recovered = await svc.build(KEY, loaders());
    expect(recovered.status).toBe('ready');
  });
});
