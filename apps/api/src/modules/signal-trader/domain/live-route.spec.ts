import { liveRouteBlock, liveRouteSummary, parseSignalTraderConfig } from './signal-trader.config';

/** 2026-11-04 at HH:MM IST, as a UTC instant. */
const ist = (hm: string) => new Date(`2026-11-04T${hm}:00+05:30`);

describe('live routing (SIGNAL_LIVE_KINDS / SIGNAL_LIVE_FROM_IST, owner 2026-11-03)', () => {
  it('defaults: options only (CE + PE), from 09:45 IST', () => {
    const c = parseSignalTraderConfig({});
    expect(c.liveKinds.sort()).toEqual(['CE', 'PE']);
    expect(c.liveFromIstMin).toBe(585);
    expect(c.problems).toEqual([]);
    expect(liveRouteSummary(c)).toBe('liveUnderlyings=all liveKinds=CE,PE liveFrom=09:45 IST');
  });

  it('parses a comma list; a typo is reported and never widens past the default', () => {
    expect(parseSignalTraderConfig({ SIGNAL_LIVE_KINDS: 'opt, fut' }).liveKinds.sort()).toEqual(['CE', 'FUT', 'PE']);
    const bad = parseSignalTraderConfig({ SIGNAL_LIVE_KINDS: 'OPTION' });
    expect(bad.liveKinds.sort()).toEqual(['CE', 'PE']);
    expect(bad.problems.join(' ')).toMatch(/SIGNAL_LIVE_KINDS/);
    const t = parseSignalTraderConfig({ SIGNAL_LIVE_FROM_IST: '9.45' });
    expect(t.liveFromIstMin).toBe(585);
    expect(t.problems.join(' ')).toMatch(/SIGNAL_LIVE_FROM_IST/);
    expect(parseSignalTraderConfig({ SIGNAL_LIVE_FROM_IST: '10:05' }).liveFromIstMin).toBe(605);
  });

  it('blocks FUT / EQ under the default, and anything before the start time; a listed option after it passes', () => {
    const c = parseSignalTraderConfig({});
    expect(liveRouteBlock(c, { underlying: 'NIFTY', instrumentKind: 'CE' }, ist('09:45'))).toBeNull();
    expect(liveRouteBlock(c, { underlying: 'NIFTY', instrumentKind: 'PE' }, ist('14:00'))).toBeNull();
    expect(liveRouteBlock(c, { underlying: 'NIFTY', instrumentKind: 'FUT' }, ist('10:00'))?.reason).toBe('live_kind');
    expect(liveRouteBlock(c, { underlying: 'RELIANCE', instrumentKind: 'EQ' }, ist('10:00'))?.reason).toBe('live_kind');
    const early = liveRouteBlock(c, { underlying: 'NIFTY', instrumentKind: 'CE' }, ist('09:44'));
    expect(early).toEqual({ reason: 'live_before_start', detail: '09:44 IST is before SIGNAL_LIVE_FROM_IST 09:45 — paper-traded' });
    // MCX: the same rule (an evening crude call after 09:45 passes).
    expect(liveRouteBlock(c, { underlying: 'CRUDEOIL', instrumentKind: 'CE' }, ist('19:30'))).toBeNull();
  });

  it('the underlying allowlist is checked first', () => {
    const c = { ...parseSignalTraderConfig({}), liveUnderlyings: ['BANKNIFTY'] };
    expect(liveRouteBlock(c, { underlying: 'NIFTY', instrumentKind: 'FUT' }, ist('09:00'))?.reason).toBe('live_underlying');
  });
});
