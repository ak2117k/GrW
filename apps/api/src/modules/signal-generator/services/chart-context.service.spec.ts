import { Logger } from '@nestjs/common';
import {
  ChartContextService,
  deriveChartContextStatus,
  type ChartContextSources,
  type SourceState,
} from './chart-context.service';

const KEY = { token: '1594', exchange: 'NSE', interval: '15m' };

const LEVELS = { pdh: 110, pdl: 90, vwap: 100 };
const ANALYSIS = { kind: 'no-setup', levels: LEVELS } as never;
const ZONE = { id: 'z1' } as never;
const EVIDENCE = { price: 105, side: 'resistance' } as never;
const TREND = {
  kind: 'uptrend',
  slope: 0.001,
  intercept: 100,
  fromTime: 1_700_000_000,
  toTime: 1_700_020_000,
  touches: 4,
  r2: 0.9,
} as never;

function loaders(
  over: Partial<Record<'analysis' | 'zones' | 'evidence' | 'trend', () => Promise<never>>> = {},
) {
  return {
    analysis: over.analysis ?? (async () => ANALYSIS),
    zones: over.zones ?? (async () => [ZONE] as never),
    evidence: over.evidence ?? (async () => [EVIDENCE] as never),
    trend: over.trend ?? (async () => TREND),
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
    for (const analysis of states)
      for (const zones of states)
        for (const evidence of states)
          for (const trend of states) {
            const sources: ChartContextSources = { analysis, zones, evidence, trend };
            const failed = [analysis, zones, evidence, trend].filter((s) => s === 'failed').length;
            const expected =
              failed === 0 ? 'ready' : failed === 4 ? 'unavailable' : 'partial';
            expect(deriveChartContextStatus(sources)).toBe(expected);
          }
  });

  it('treats an all-empty response as ready — "genuinely no levels" is an answer', () => {
    expect(
      deriveChartContextStatus({
        analysis: 'empty',
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

  it('composes all four sources on the happy path', async () => {
    const dto = await svc.build(KEY, loaders());
    expect(dto).toEqual({
      interval: '15m',
      analysis: ANALYSIS,
      zones: [ZONE],
      evidence: [EVIDENCE],
      trend: TREND,
      status: 'ready',
      sources: { analysis: 'ok', zones: 'ok', evidence: 'ok', trend: 'ok' },
    });
  });

  /**
   * "No clear trend" is an answer, not an outage. A null line must read as
   * 'empty' and leave the response 'ready' — the same distinction the whole
   * endpoint exists to preserve for levels.
   */
  it('reports a null trend line as empty, not failed, and stays ready', async () => {
    const dto = await svc.build(KEY, loaders({ trend: async () => null as never }));
    expect(dto.trend).toBeNull();
    expect(dto.sources.trend).toBe('empty');
    expect(dto.status).toBe('ready');
  });

  it('marks the trend failed — and only partial — when the fit throws', async () => {
    const dto = await svc.build(
      KEY,
      loaders({
        trend: async () => {
          throw new Error('candle fetch exploded');
        },
      }),
    );
    expect(dto.status).toBe('partial');
    expect(dto.sources.trend).toBe('failed');
    expect(dto.trend).toBeNull();
    expect(dto.evidence).toEqual([EVIDENCE]);
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
      analysis: 'ok',
      zones: 'failed',
      evidence: 'ok',
      trend: 'ok',
    });
    // The whole point: a failed source must not take the others with it.
    expect(dto.analysis).toBe(ANALYSIS);
    expect(dto.evidence).toEqual([EVIDENCE]);
    expect(dto.zones).toEqual([]);
  });

  it('returns unavailable — not a throw — when every source fails', async () => {
    const boom = async () => {
      throw new Error('down');
    };
    const dto = await svc.build(
      KEY,
      loaders({ analysis: boom, zones: boom, evidence: boom, trend: boom }),
    );
    expect(dto.status).toBe('unavailable');
    expect(dto.sources).toEqual({
      analysis: 'failed',
      zones: 'failed',
      evidence: 'failed',
      trend: 'failed',
    });
    expect(dto.analysis).toBeNull();
    expect(dto.zones).toEqual([]);
    expect(dto.evidence).toEqual([]);
    expect(dto.trend).toBeNull();
  });

  /**
   * Trend used to be excluded from the derivation because it was hard-wired to
   * 'empty'; leaving that exclusion in place would make 'unavailable'
   * unreachable the moment trend shipped, since three failures out of four
   * would read as 'partial'. This pins that it does not.
   */
  it('a surviving trend keeps a three-source outage merely partial', async () => {
    const boom = async () => {
      throw new Error('down');
    };
    const dto = await svc.build(KEY, loaders({ analysis: boom, zones: boom, evidence: boom }));
    expect(dto.status).toBe('partial');
    expect(dto.trend).toBe(TREND);
  });

  it('marks a successful-but-empty source empty, not failed, and stays ready', async () => {
    const dto = await svc.build(KEY, loaders({
      analysis: async () => null as never,
      zones: async () => [] as never,
      evidence: async () => [] as never,
      trend: async () => null as never,
    }));
    expect(dto.status).toBe('ready');
    expect(dto.sources).toEqual({
      analysis: 'empty',
      zones: 'empty',
      evidence: 'empty',
      trend: 'empty',
    });
  });

  it('serves a second call for the same key from cache (collapses the poll)', async () => {
    const analysis = jest.fn(async () => ANALYSIS);
    const first = await svc.build(KEY, loaders({ analysis: analysis as never }));
    const second = await svc.build(KEY, loaders({ analysis: analysis as never }));
    expect(second).toBe(first);
    expect(analysis).toHaveBeenCalledTimes(1);
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
    await svc.build(KEY, loaders({ analysis: boom, zones: boom, evidence: boom, trend: boom }));
    const recovered = await svc.build(KEY, loaders());
    expect(recovered.status).toBe('ready');
  });
});
