import { describe, it, expect } from 'vitest';
import { deriveSrChip } from './srChip';
import type { ChartContextDto, SourceState } from '@/hooks/useChartContext';
import type { SRLevel } from '@/components/charts/buildSRView';
import { CHART_TIMEFRAMES, SR_SUPPORTED_INTERVALS } from '@td/shared';

function ctx(
  status: ChartContextDto['status'],
  sources: Partial<Record<keyof ChartContextDto['sources'], SourceState>> = {},
): ChartContextDto {
  return {
    interval: '15m',
    levels: null,
    zones: [],
    evidence: [],
    trend: null,
    status,
    sources: {
      levels: 'ok',
      zones: 'ok',
      evidence: 'ok',
      trend: 'empty',
      ...sources,
    },
  };
}

function level(price: number, side: SRLevel['side'], distancePct: number): SRLevel {
  return { price, side, source: 'PDH', label: 'PDH', tier: 'immediate', distancePct };
}

const R = level(24_680, 'resistance', 0.4);
const S = level(24_510, 'support', -0.3);

describe('deriveSrChip', () => {
  it('says loading while no response has landed', () => {
    const chip = deriveSrChip({
      context: null,
      ltp: 24_580,
      immediateResistance: null,
      immediateSupport: null,
    });
    expect(chip.text).toBe('S/R: loading…');
    expect(chip.warning).toBeNull();
  });

  it('NEVER claims there are no levels while loading', () => {
    // The original bug: empty levels + no response read as a fact.
    for (const ltp of [0, 24_580]) {
      const chip = deriveSrChip({
        context: null,
        ltp,
        immediateResistance: null,
        immediateSupport: null,
      });
      expect(chip.text).not.toMatch(/no levels|none in range/);
    }
  });

  it('says unavailable when every source failed', () => {
    const chip = deriveSrChip({
      context: ctx('unavailable', {
        levels: 'failed',
        zones: 'failed',
        evidence: 'failed',
        trend: 'failed',
      }),
      ltp: 24_580,
      immediateResistance: null,
      immediateSupport: null,
    });
    expect(chip.text).toBe('S/R: unavailable');
  });

  it('renders the R/S readout when levels were found', () => {
    const chip = deriveSrChip({
      context: ctx('ready'),
      ltp: 24_580,
      immediateResistance: R,
      immediateSupport: S,
    });
    expect(chip.text).toBe('R 24,680 (+0.4%) · S 24,510 (-0.3%)');
    expect(chip.warning).toBeNull();
  });

  it('renders a one-sided readout with an em-dash placeholder', () => {
    const chip = deriveSrChip({
      context: ctx('ready'),
      ltp: 24_580,
      immediateResistance: null,
      immediateSupport: S,
    });
    expect(chip.text).toBe('R — · S 24,510 (-0.3%)');
  });

  it('says none in range only for a successful, genuinely empty response', () => {
    const chip = deriveSrChip({
      context: ctx('ready', { levels: 'empty', zones: 'empty', evidence: 'empty' }),
      ltp: 24_580,
      immediateResistance: null,
      immediateSupport: null,
    });
    expect(chip.text).toBe('S/R: none in range');
  });

  it('warns with the failed source names on a partial response, keeping the levels', () => {
    const chip = deriveSrChip({
      context: ctx('partial', { evidence: 'failed' }),
      ltp: 24_580,
      immediateResistance: R,
      immediateSupport: S,
    });
    expect(chip.text).toBe('R 24,680 (+0.4%) · S 24,510 (-0.3%)');
    expect(chip.warning).toContain('evidence');
  });

  it('keeps the partial warning even when the partial response has no levels', () => {
    const chip = deriveSrChip({
      context: ctx('partial', { zones: 'failed', evidence: 'failed' }),
      ltp: 24_580,
      immediateResistance: null,
      immediateSupport: null,
    });
    expect(chip.text).toBe('S/R: none in range');
    expect(chip.warning).toContain('zones');
    expect(chip.warning).toContain('evidence');
  });

  it('reports insufficient data rather than "none in range" when there is no price', () => {
    const chip = deriveSrChip({
      context: ctx('ready'),
      ltp: 0,
      immediateResistance: null,
      immediateSupport: null,
    });
    expect(chip.text).toBe('S/R: insufficient data');
  });
});

describe('timeframe roster invariant', () => {
  it('offers only timeframes the S/R engine supports', () => {
    for (const tf of CHART_TIMEFRAMES) {
      expect(SR_SUPPORTED_INTERVALS as readonly string[]).toContain(tf);
    }
  });

  it('no longer offers 4h, and does offer 1mo', () => {
    expect(CHART_TIMEFRAMES as readonly string[]).not.toContain('4h');
    expect(CHART_TIMEFRAMES as readonly string[]).toContain('1mo');
  });
});
