import { describe, it, expect } from 'vitest';
import {
  deriveProjectionZonesView,
  formatHitRate,
  projectionBoxLines,
  DOWN_COLOR,
  UP_COLOR,
  type ProjectionBox,
  type ProjectionZones,
} from './projectionBoxView';

function box(over: Partial<ProjectionBox> = {}): ProjectionBox {
  return {
    side: 'UP',
    state: 'confirmed',
    breakLevel: 24_630,
    entryNear: 24_630,
    entryFar: 24_672,
    stop: 24_590,
    target: 24_800,
    targetSource: 'ZONE',
    cappedByHtf: false,
    rr: 2,
    hitRate: { pct: 63, sample: 41, scope: 'symbol' },
    reason: 'Broke the 24,630 resistance zone on above-average volume.',
    ...over,
  };
}

const DOWN_BOX = box({
  side: 'DOWN',
  breakLevel: 24_522,
  entryNear: 24_522,
  entryFar: 24_480,
  stop: 24_562,
  target: 24_350,
  rr: 2.2,
  hitRate: { pct: 58, sample: 2_140, scope: 'cohort' },
  reason: 'Lost the 24,522 support zone.',
});

function zones(over: Partial<ProjectionZones> = {}): ProjectionZones {
  return { up: null, down: null, ...over };
}

const OK = { source: 'ok' as const, loading: false, symbol: 'SBIN', exchange: 'NSE' };

describe('deriveProjectionZonesView', () => {
  it('says loading while no response has landed', () => {
    const view = deriveProjectionZonesView({
      zones: undefined,
      source: undefined,
      loading: true,
    });
    expect(view.kind).toBe('loading');
  });

  it('distinguishes a failed projection source from "no break projected"', () => {
    const failed = deriveProjectionZonesView({ ...OK, zones: null, source: 'failed' });
    const empty = deriveProjectionZonesView({ ...OK, zones: zones(), source: 'empty' });

    expect(failed.kind).toBe('unavailable');
    expect(empty.kind).toBe('none');
    // "we don't know" must never read as "there is nothing there".
    if (failed.kind !== 'unavailable') throw new Error('expected unavailable');
    expect(failed.message).toMatch(/unavailable/i);
    if (empty.kind !== 'none') throw new Error('expected none');
    expect(empty.message).toMatch(/no break projection/i);
  });

  it('renders BOTH boxes when both sides qualify', () => {
    const view = deriveProjectionZonesView({
      ...OK,
      zones: zones({ up: box(), down: DOWN_BOX }),
    });
    if (view.kind !== 'boxes') throw new Error(`expected boxes, got ${view.kind}`);
    expect(view.up).toMatchObject({
      side: 'UP',
      headline: 'Break above 24,630 — confirmed',
      entryText: '24,630 – 24,672',
      stopText: '24,590',
      targetText: '24,800',
      rrText: '1:2.0',
    });
    expect(view.down).toMatchObject({
      side: 'DOWN',
      headline: 'Break below 24,522 — confirmed',
      entryText: '24,522 – 24,480',
      rrText: '1:2.2',
    });
  });

  it('renders one side when only one qualifies, and fabricates nothing on the other', () => {
    const view = deriveProjectionZonesView({ ...OK, zones: zones({ up: box() }) });
    if (view.kind !== 'boxes') throw new Error(`expected boxes, got ${view.kind}`);
    expect(view.up?.box.breakLevel).toBe(24_630);
    expect(view.down).toBeNull();
  });

  it('says so in words when neither side qualifies', () => {
    const view = deriveProjectionZonesView({ ...OK, zones: zones(), source: 'empty' });
    if (view.kind !== 'none') throw new Error(`expected none, got ${view.kind}`);
    expect(view.message).not.toContain('{');
  });

  it('drops a box whose geometry has not warmed (price 0) rather than drawing it', () => {
    const view = deriveProjectionZonesView({
      ...OK,
      zones: zones({ up: box({ target: 0 }) }),
    });
    expect(view.kind).toBe('none');
  });

  it('colours up green and down red, taking hue from the shared chart tokens', () => {
    const view = deriveProjectionZonesView({
      ...OK,
      zones: zones({ up: box(), down: DOWN_BOX }),
    });
    if (view.kind !== 'boxes') throw new Error('expected boxes');
    expect(view.up?.style.base).toBe(UP_COLOR);
    expect(view.down?.style.base).toBe(DOWN_COLOR);
  });

  it('makes armed and confirmed distinguishable without reading the label', () => {
    const view = deriveProjectionZonesView({
      ...OK,
      zones: zones({ up: box({ state: 'armed' }), down: DOWN_BOX }),
    });
    if (view.kind !== 'boxes') throw new Error('expected boxes');
    const armed = view.up!;
    const confirmed = view.down!;

    expect(armed.style.dashed).toBe(true);
    expect(armed.style.edgeLineStyle).toBe(2);
    expect(armed.style.opacity).toBeLessThan(confirmed.style.opacity);
    // Faded, not recoloured: hue still encodes direction.
    expect(armed.style.edgeColor.startsWith(UP_COLOR)).toBe(true);
    expect(armed.style.edgeColor).not.toBe(confirmed.style.edgeColor);

    expect(confirmed.style.dashed).toBe(false);
    expect(confirmed.style.edgeLineStyle).toBe(0);
    expect(confirmed.style.edgeColor).toBe(DOWN_COLOR);
  });

  it('states an HTF cap in the reason — a capped target is a weaker claim', () => {
    const capped = deriveProjectionZonesView({
      ...OK,
      zones: zones({ up: box({ cappedByHtf: true }) }),
    });
    const uncapped = deriveProjectionZonesView({ ...OK, zones: zones({ up: box() }) });
    if (capped.kind !== 'boxes' || uncapped.kind !== 'boxes') throw new Error('expected boxes');

    expect(capped.up?.reason).toMatch(/capped by the higher timeframe/i);
    expect(capped.up?.cappedByHtf).toBe(true);
    expect(uncapped.up?.reason).not.toMatch(/capped/i);
    expect(uncapped.up?.cappedByHtf).toBe(false);
  });

  it('still states the cap when the engine reason was unsafe to render', () => {
    const view = deriveProjectionZonesView({
      ...OK,
      zones: zones({
        up: box({ cappedByHtf: true, reason: 'reject:confirmation {"type":"ROUND"}' }),
      }),
    });
    if (view.kind !== 'boxes') throw new Error('expected boxes');
    // The rendered sentence carries the cap and nothing else — the engine's
    // debug payload survives only on the untouched wire object the chart draws
    // its geometry from, which is never rendered as text.
    expect(view.up?.reason).toBe('Target capped by the higher timeframe.');
    expect(view.up?.reason).not.toContain('{');
    expect(projectionBoxLines(view).map((l) => l.label).join(' ')).not.toContain('reject');
  });

  it('labels an ATR target as a fallback and never as structure', () => {
    const view = deriveProjectionZonesView({
      ...OK,
      zones: zones({ up: box({ targetSource: 'ATR' }), down: DOWN_BOX }),
    });
    if (view.kind !== 'boxes') throw new Error('expected boxes');
    expect(view.up?.targetSourceText).toMatch(/fallback/i);
    expect(view.down?.targetSourceText).toMatch(/zone/i);
  });
});

describe('hit-rate rendering', () => {
  it('always shows a percentage WITH its sample size and scope', () => {
    expect(formatHitRate({ pct: 63, sample: 41, scope: 'symbol' }, 'SBIN', 'NSE')).toBe(
      '63% · 41 breaks · SBIN',
    );
    expect(formatHitRate({ pct: 58, sample: 2140, scope: 'cohort' }, 'SBIN', 'NSE')).toBe(
      '58% · 2,140 breaks · all NSE equities',
    );
  });

  it('renders a null hit-rate as "no measured history yet" — never blank, never 0%', () => {
    const text = formatHitRate(null, 'SBIN', 'NSE');
    expect(text).toBe('no measured history yet');
    expect(text).not.toBe('');
    expect(text).not.toMatch(/%/);
  });

  it('refuses to report a percentage with no sample behind it', () => {
    expect(formatHitRate({ pct: 63, sample: 0, scope: 'symbol' }, 'SBIN')).toBe(
      'no measured history yet',
    );
    expect(formatHitRate({ pct: Number.NaN, sample: 41, scope: 'cohort' }, 'SBIN')).toBe(
      'no measured history yet',
    );
  });

  it('singularises a sample of one rather than saying "1 breaks"', () => {
    expect(formatHitRate({ pct: 100, sample: 1, scope: 'symbol' }, 'SBIN')).toBe(
      '100% · 1 break · SBIN',
    );
  });

  it('names the symbol scope even when the caller passed no symbol', () => {
    expect(formatHitRate({ pct: 63, sample: 41, scope: 'symbol' })).toBe(
      '63% · 41 breaks · this symbol',
    );
  });

  it('carries the text and the "measured?" flag onto every box view', () => {
    const view = deriveProjectionZonesView({
      ...OK,
      zones: zones({ up: box({ hitRate: null }), down: DOWN_BOX }),
    });
    if (view.kind !== 'boxes') throw new Error('expected boxes');
    expect(view.up?.hitRateText).toBe('no measured history yet');
    expect(view.up?.hasMeasuredHistory).toBe(false);
    expect(view.down?.hitRateText).toBe('58% · 2,140 breaks · all NSE equities');
    expect(view.down?.hasMeasuredHistory).toBe(true);
  });
});

describe('projectionBoxLines', () => {
  it('draws the box edges and the target from the SAME view the card reads', () => {
    const view = deriveProjectionZonesView({ ...OK, zones: zones({ up: box() }) });
    if (view.kind !== 'boxes') throw new Error('expected boxes');
    const lines = projectionBoxLines(view);

    expect(lines.map((l) => l.role)).toEqual(['break', 'entryFar', 'stop', 'target']);
    expect(lines[0].value).toBe(view.up!.box.breakLevel);
    expect(lines[1].value).toBe(view.up!.box.entryFar);
    expect(lines[3].value).toBe(view.up!.box.target);
  });

  it('draws the target as a distinct dashed line, not as a box edge', () => {
    const view = deriveProjectionZonesView({ ...OK, zones: zones({ up: box() }) });
    if (view.kind !== 'boxes') throw new Error('expected boxes');
    const lines = projectionBoxLines(view);
    const edges = lines.filter((l) => l.role === 'break' || l.role === 'entryFar');
    const target = lines.find((l) => l.role === 'target')!;

    expect(target.lineStyle).toBe(2);
    for (const edge of edges) {
      // A confirmed box's edges are solid; the target never shares their style.
      expect(edge.lineStyle).toBe(0);
      expect(edge.value).not.toBe(target.value);
    }
  });

  it('says on the target label when the higher timeframe capped it', () => {
    const view = deriveProjectionZonesView({
      ...OK,
      zones: zones({ up: box({ cappedByHtf: true }) }),
    });
    if (view.kind !== 'boxes') throw new Error('expected boxes');
    expect(projectionBoxLines(view).find((l) => l.role === 'target')!.label).toContain(
      'HTF cap',
    );
  });

  it('draws both sides, and nothing at all when the view is not "boxes"', () => {
    const both = deriveProjectionZonesView({
      ...OK,
      zones: zones({ up: box(), down: DOWN_BOX }),
    });
    expect(projectionBoxLines(both)).toHaveLength(8);

    expect(projectionBoxLines({ kind: 'loading' })).toHaveLength(0);
    expect(projectionBoxLines({ kind: 'unavailable', message: 'x' })).toHaveLength(0);
    expect(projectionBoxLines({ kind: 'none', message: 'x' })).toHaveLength(0);
  });
});
