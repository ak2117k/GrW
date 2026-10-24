import {
  atr,
  buildSetup,
  evaluateOutcome,
  pickFuture,
  sizeCash,
  sizeFutures,
  stopDistance,
  STOP_ATR_MIN,
  triggerFor,
  type IntradayBar,
  type SetupInput,
} from './trade-setup.logic';
import { futuresFromMaster, masterExpiry } from '../adapters/futures-source';

describe('triggerFor (news AND model must agree)', () => {
  const stock = (bucket: string, resultsInWindow = false) => ({ bucket, resultsInWindow });
  it('stock: TOP20 or results in window, with a directional idea', () => {
    expect(triggerFor({ idea: 'CE_IDEA', isIndex: false, stock: stock('TOP20'), mbmActive: false })).toMatchObject({ ok: true, side: 'LONG' });
    expect(triggerFor({ idea: 'PE_IDEA', isIndex: false, stock: stock('MID', true), mbmActive: false })).toMatchObject({ ok: true, side: 'SHORT' });
    expect(triggerFor({ idea: 'CE_IDEA', isIndex: false, stock: stock('MID'), mbmActive: true }).ok).toBe(false);
    expect(triggerFor({ idea: 'CE_IDEA', isIndex: false, stock: stock('BOTTOM20'), mbmActive: false }).ok).toBe(false);
    expect(triggerFor({ idea: 'CE_IDEA', isIndex: false, stock: null, mbmActive: true }).ok).toBe(false);
    expect(triggerFor({ idea: 'NO_TRADE', isIndex: false, stock: stock('TOP20'), mbmActive: false }).ok).toBe(false);
  });
  it('index: only with the NIFTY MBM regime ACTIVE', () => {
    expect(triggerFor({ idea: 'PE_IDEA', isIndex: true, stock: null, mbmActive: true })).toMatchObject({ ok: true, side: 'SHORT' });
    expect(triggerFor({ idea: 'PE_IDEA', isIndex: true, stock: stock('TOP20'), mbmActive: false }).ok).toBe(false);
  });
});

describe('ATR and stop', () => {
  it('ATR(14) uses true range with the previous close; null when short', () => {
    const bars = Array.from({ length: 15 }, (_, i) => ({ high: 110 + i, low: 100 + i, close: 105 + i }));
    expect(atr(bars)).toBeCloseTo(10);
    expect(atr(bars.slice(0, 10))).toBeNull();
    // a gap makes TR exceed high-low
    const gap = [...bars.slice(0, 14), { high: 140, low: 135, close: 138 }];
    expect(atr(gap)!).toBeGreaterThan(10);
  });
  it('stop = 1× daily ATR: floor 1× ATR (a tighter opening range no longer tightens it), cap 1× ATR', () => {
    expect(STOP_ATR_MIN).toBe(1);
    expect(stopDistance(20)).toBe(20);
    expect(stopDistance(20, 30)).toBe(20);
    expect(stopDistance(20, 14)).toBe(20);
    expect(stopDistance(20, 4)).toBe(20);
  });
});

describe('pickFuture (roll at ≤ 3 sessions)', () => {
  const c = (expiry: string) => ({ tradingSymbol: `X${expiry}FUT`, token: expiry, expiry, lotSize: 100 });
  const contracts = [c('2026-11-24'), c('2026-10-27'), c('2026-12-29')];
  it('near month normally', () => {
    expect(pickFuture(contracts, '2026-10-23', () => 5)).toMatchObject({ contract: { expiry: '2026-10-27' }, rolled: false });
  });
  it('rolls to next month with ≤ 3 sessions left', () => {
    expect(pickFuture(contracts, '2026-10-23', (e) => (e === '2026-10-27' ? 3 : 20))).toMatchObject({ contract: { expiry: '2026-11-24' }, rolled: true });
  });
  it('drops expired contracts; none ⇒ null', () => {
    expect(pickFuture(contracts, '2026-10-28', () => 20)?.contract.expiry).toBe('2026-11-24');
    expect(pickFuture([], '2026-10-23', () => 20)).toBeNull();
  });
  it('reads the Angel master (FUTSTK/FUTIDX by name, DDMMMYYYY expiry)', () => {
    expect(masterExpiry('27OCT2026')).toBe('2026-10-27');
    const rows = futuresFromMaster(
      [
        { instrumenttype: 'FUTSTK', name: 'RELIANCE', symbol: 'RELIANCE24NOV26FUT', token: '2', expiry: '24NOV2026', lotsize: '500' },
        { instrumenttype: 'OPTSTK', name: 'RELIANCE', symbol: 'RELIANCE27OCT261400CE', token: '9', expiry: '27OCT2026', lotsize: '500' },
        { instrumenttype: 'FUTSTK', name: 'RELIANCE', symbol: 'RELIANCE27OCT26FUT', token: '1', expiry: '27OCT2026', lotsize: '500' },
        { instrumenttype: 'FUTSTK', name: 'TCS', symbol: 'TCS27OCT26FUT', token: '3', expiry: '27OCT2026', lotsize: '175' },
      ],
      'reliance',
    );
    expect(rows.map((r) => r.token)).toEqual(['1', '2']);
    expect(rows[0]).toEqual({ tradingSymbol: 'RELIANCE27OCT26FUT', token: '1', expiry: '2026-10-27', lotSize: 500 });
  });
});

describe('sizing', () => {
  it('cash: 1 % risk ÷ stop distance', () => {
    // ₹2,00,000 margin → ₹2,000 risk; stop 20 → 100 shares; 100 × 500 = 50k ≤ 5 × 2L
    const s = sizeCash(200_000, 500, 20);
    expect(s).toMatchObject({ qty: 100, lots: null, riskRs: 2000, riskPct: 1, rewardT1Rs: 3000, rewardT2Rs: 5000, marginUsed: 10_000, exceedsRisk: false });
  });
  it('cash: capped at 5× leverage', () => {
    // ₹1L → ₹1,000 risk; stop 0.5 → 2000 shares; cap 5L / 400 = 1250
    const s = sizeCash(100_000, 400, 0.5);
    expect(s.qty).toBe(1250);
    expect(s.qty * 400).toBeLessThanOrEqual(5 * 100_000);
    expect(s.riskRs).toBe(625);
    expect(s.notes[0]).toContain('5x');
  });
  it('futures: whole lots within 1 %', () => {
    // ₹5L → ₹5,000; lot 250 × stop 8 = ₹2,000 per lot → 2 lots
    const s = sizeFutures(500_000, 1000, 8, 250);
    expect(s).toMatchObject({ lots: 2, qty: 500, riskRs: 4000, riskPct: 0.8, exceedsRisk: false });
    expect(s.marginUsed).toBe(500 * 1000 * 0.2);
  });
  it('futures: one lot over 1 % is still shown, flagged with ₹ and %', () => {
    // ₹1L → ₹1,000; lot 500 × stop 30 = ₹15,000
    const s = sizeFutures(100_000, 2500, 30, 500);
    expect(s.lots).toBe(1);
    expect(s.exceedsRisk).toBe(true);
    expect(s.riskRs).toBe(15_000);
    expect(s.notes[0]).toBe('exceeds 1% risk — 1 lot risks ₹15000 (15.0%)');
  });
});

describe('buildSetup', () => {
  const base: SetupInput = {
    sessionDate: '2026-10-23',
    symbol: 'RELIANCE',
    isIndex: false,
    side: 'LONG',
    triggerWhy: 'news idea + big-move model TOP20',
    close: 1400,
    priceAsOf: '2026-10-22',
    atr: 28,
    future: { contract: { tradingSymbol: 'RELIANCE27OCT26FUT', token: '1', expiry: '2026-10-27', lotSize: 500 }, rolled: false },
    margin: { value: 1_000_000, asOf: '2026-10-22T09:30:00.000Z', source: 'LAST_KNOWN' },
    context: [{ label: 'FII / DII', text: 'unavailable: x', available: false }],
    headlines: ['Reliance wins a big order'],
    newsIdeaId: 'idea1',
    vixLast: 12.5,
  };
  it('futures long: 1× ATR stop, 1.5R / 2.5R targets, lots, margin as of, advisory + direction notes', () => {
    const d = buildSetup(base);
    expect(d).toMatchObject({
      instrumentKind: 'FUTURES', exchange: 'NFO', expiry: '2026-10-27', lotSize: 500, side: 'LONG',
      entryRef: 1400, stop: 1372, stopDistance: 28, target1: 1442, target2: 1470,
      lots: 1, qty: 500, riskRs: 14_000, marginSource: 'LAST_KNOWN', exceedsRisk: true,
    });
    expect(d.inputs.sizingBasis).toContain('as of 2026-10-22T09:30');
    expect(d.inputs.sizingNotes[0]).toContain('exceeds 1% risk — 1 lot risks ₹14000 (1.4%)');
    expect(d.entryRule).toContain('break of its high');
    expect(d.inputs.direction).toContain('news idea');
    expect(d.inputs.advisory).toContain('you place the order');
    expect(d.inputs.skipIf.some((s) => s.includes('ban list'))).toBe(true);
    expect(d.inputs.skipIf[0]).toContain('below 1400');
  });
  it('no futures ⇒ intraday cash (MIS), short side mirrored; no margin ⇒ per ₹1 lakh', () => {
    const d = buildSetup({ ...base, side: 'SHORT', future: null, margin: { value: null, asOf: null, source: null } });
    expect(d).toMatchObject({ instrumentKind: 'CASH_MIS', exchange: 'NSE', stop: 1428, target1: 1358, target2: 1330, marginSource: 'PER_LAKH', marginAvailable: null });
    // ₹1L → ₹1,000 / 28 = 35 shares
    expect(d.qty).toBe(35);
    expect(d.instrument).toBe('RELIANCE intraday cash (MIS)');
    expect(d.inputs.sizingBasis).toContain('per ₹1 lakh');
    expect(d.entryRule).toContain('break of its low');
    expect(d.inputs.timeExit).toContain('15:10');
  });
});

describe('evaluateOutcome (15-min replay)', () => {
  // 2026-10-23 09:15 IST = 03:45Z
  const t0 = Date.parse('2026-10-23T03:45:00Z');
  const bar = (i: number, o: number, h: number, l: number, c: number): IntradayBar => ({ ts: t0 + i * 15 * 60_000, open: o, high: h, low: l, close: c });
  const setup = { side: 'LONG' as const, atr: 20, prevClose: 1000 };

  it('long: breaks the range high then reaches 1.5R first → TARGET1', () => {
    // OR 1000–1010; stop dist = 1× ATR = 20; entry 1010; T1 1040; stop 990
    const o = evaluateOutcome(setup, '2026-10-23', [bar(0, 1002, 1010, 1000, 1008), bar(1, 1008, 1012, 1005, 1011), bar(2, 1011, 1041, 1009, 1039)]);
    expect(o).toMatchObject({ status: 'TARGET1', entryPrice: 1010, exitPrice: 1040, r: 1.5, hitT1: true });
  });
  it('stop first (a bar touching both counts as the stop)', () => {
    const o = evaluateOutcome(setup, '2026-10-23', [bar(0, 1002, 1010, 1000, 1008), bar(1, 1008, 1045, 989, 1011)]);
    expect(o).toMatchObject({ status: 'STOP', r: -1, hitT1: false });
  });
  it('a dip to the opening-range low (inside 1× ATR) no longer stops the trade out', () => {
    // old rule: stop at the OR low 1000 (0.5 ATR floor = 10) → stopped at 999; now stop is 990
    const o = evaluateOutcome(setup, '2026-10-23', [bar(0, 1002, 1010, 1000, 1008), bar(1, 1008, 1012, 999, 1005), bar(2, 1005, 1041, 1004, 1039)]);
    expect(o).toMatchObject({ status: 'TARGET1', r: 1.5 });
    expect(o.details.stopDistance).toBe(20);
  });
  it('never breaks → NOT_TRIGGERED; no 09:15 bar → NO_DATA', () => {
    expect(evaluateOutcome(setup, '2026-10-23', [bar(0, 1002, 1010, 1000, 1008), bar(1, 1008, 1009, 1001, 1005)]).status).toBe('NOT_TRIGGERED');
    expect(evaluateOutcome(setup, '2026-10-23', [bar(1, 1008, 1009, 1001, 1005)]).status).toBe('NO_DATA');
    expect(evaluateOutcome(setup, '2026-10-24', [bar(0, 1002, 1010, 1000, 1008)]).status).toBe('NO_DATA');
  });
  it('time exit at 15:10 with neither hit; short side mirrored', () => {
    const late = (i: number) => bar(i, 1004, 1006, 1002, 1005);
    const o = evaluateOutcome({ ...setup, side: 'SHORT' }, '2026-10-23', [bar(0, 1004, 1010, 1003, 1005), bar(1, 1004, 1006, 1001, 1002), late(5), late(23), bar(24, 1, 1, 1, 1)]);
    // entry 1003 (break of the low), stop dist 1× ATR = 20; bar 24 (15:15) is after the time exit
    expect(o.status).toBe('TIME_EXIT');
    expect(o.entryPrice).toBe(1003);
    expect(o.r).toBeCloseTo(-0.1);
  });
});
