import type { Bar15m } from '../../ai-setups/domain/setup-watch';
import type { Proposal } from './desk.types';
import { barsWindow, directionOf, gradeDecision, proposalLevels, type GradeDecisionRow, type GradeTrade } from './desk-grade';

const IST = (hhmm: string, day = '2026-11-24') => new Date(`${day}T${hhmm}:00+05:30`);
const NIGHT = IST('23:45');

function bar(hhmm: string, o: number, h: number, l: number, c: number): Bar15m {
  return { ts: IST(hhmm).getTime(), open: o, high: h, low: l, close: c };
}
function flat(from: string, to: string, px: number): Bar15m[] {
  const out: Bar15m[] = [];
  for (let t = IST(from).getTime(); t < IST(to).getTime(); t += 15 * 60_000) out.push({ ts: t, open: px, high: px + 1, low: px - 1, close: px });
  return out;
}

function row(over: Partial<GradeDecisionRow> = {}): GradeDecisionRow {
  return {
    id: 'd1',
    userId: 'u1',
    runId: 'r1',
    action: 'OPEN',
    status: 'DONE',
    underlying: 'NIFTY',
    trackerId: null,
    payload: { action: 'OPEN', underlying: 'NIFTY', side: 'BUY_CE', stop: { underlying: 24000 }, targets: { underlying: [24100, 24200] } },
    createdAt: IST('10:02'),
    ...over,
  };
}

function trade(over: Partial<GradeTrade> = {}): GradeTrade {
  return { id: 't1', status: 'CLOSED', symbol: 'NIFTY25NOV2424050CE', entryAt: IST('10:05'), exitAt: IST('11:20'), pnl: 3000, charges: 120, ...over };
}

describe('gradeDecision — OPEN', () => {
  // Entry bar 10:00 closes 24040 (ref); 10:15 dips to 24020, 10:30 runs to 24110 (T1) — target before stop.
  const WIN_BARS = [bar('10:00', 24030, 24045, 24025, 24040), bar('10:15', 24040, 24050, 24020, 24045), bar('10:30', 24045, 24110, 24040, 24105), bar('10:45', 24105, 24120, 24090, 24100), bar('11:00', 24100, 24105, 24080, 24090), bar('11:15', 24090, 24095, 24070, 24080)];

  it('grades a winning OPEN with net pnl and TARGET', () => {
    const g = gradeDecision({ row: row(), now: NIGHT, trade: trade(), underlying: 'NIFTY', bars: WIN_BARS });
    expect(g).toMatchObject({ kind: 'OPEN', pnl: 3000, netPnl: 2880, hit: 'TARGET', vsHold60: null });
    expect(g!.mfe).toBe(80); // 24120 − 24040
    expect(g!.mae).toBe(20); // 24040 − 24020
    expect(g!.note).toContain('net ₹2880');
  });

  it('a losing OPEN that touches the stop first is STOP', () => {
    const bars = [bar('10:00', 24030, 24045, 24025, 24040), bar('10:15', 24040, 24060, 23990, 24000), bar('10:30', 24000, 24150, 23995, 24140)];
    const g = gradeDecision({ row: row(), now: NIGHT, trade: trade({ exitAt: IST('10:50'), pnl: -2500 }), underlying: 'NIFTY', bars });
    expect(g).toMatchObject({ hit: 'STOP', pnl: -2500, netPnl: -2620 });
  });

  it('a PE is graded with the underlying falling as favourable', () => {
    const r = row({ payload: { action: 'OPEN', side: 'BUY_PE', stop: { underlying: 24100 }, targets: { underlying: [23950] } } });
    const bars = [bar('10:00', 24030, 24045, 24025, 24040), bar('10:15', 24040, 24050, 23940, 23960), bar('10:30', 23960, 23970, 23950, 23955)];
    const g = gradeDecision({ row: r, now: NIGHT, trade: trade({ symbol: 'NIFTY25NOV2424000PE', exitAt: IST('10:40') }), underlying: 'NIFTY', bars });
    expect(g).toMatchObject({ hit: 'TARGET', mfe: 100, mae: 10 });
  });

  it('trade still open → null (retried next night)', () => {
    expect(gradeDecision({ row: row(), now: NIGHT, trade: trade({ status: 'OPEN', exitAt: null, pnl: null }), bars: WIN_BARS })).toBeNull();
  });

  it('pending entry still waiting → null; expired → graded as never filled', () => {
    expect(gradeDecision({ row: row({ status: 'PENDING' }), now: NIGHT, pendingStatus: 'PENDING', trade: null })).toBeNull();
    const g = gradeDecision({ row: row({ status: 'PENDING' }), now: NIGHT, pendingStatus: 'EXPIRED', trade: null });
    expect(g).toMatchObject({ kind: 'OPEN', pnl: null, hit: null });
    expect(g!.note).toContain('never filled');
  });

  it('refused OPEN is recorded as not executed', () => {
    expect(gradeDecision({ row: row({ status: 'REFUSED' }), now: NIGHT })!.note).toContain('not executed (REFUSED)');
  });

  it('missing bars → null fields with a note, never a throw', () => {
    const a = gradeDecision({ row: row(), now: NIGHT, trade: trade(), underlying: 'NIFTY', bars: null, barsError: 'hub down' });
    expect(a).toMatchObject({ kind: 'OPEN', pnl: 3000, netPnl: 2880, mfe: null, mae: null, hit: null });
    expect(a!.note).toContain('hub down');
    const b = gradeDecision({ row: row(), now: NIGHT, trade: trade(), underlying: 'NIFTY', bars: flat('12:00', '13:00', 24000) });
    expect(b).toMatchObject({ mfe: null, mae: null, hit: null });
    expect(b!.note).toContain('no closed 15m bar');
    const garbage = [{ ts: NaN, open: 1, high: 1, low: 1, close: 1 }] as Bar15m[];
    expect(() => gradeDecision({ row: row({ payload: 'junk' }), now: NIGHT, trade: trade(), bars: garbage })).not.toThrow();
  });
});

describe('gradeDecision — EXIT / BOOK', () => {
  const exitRow = row({ action: 'EXIT', trackerId: 'k1', underlying: 'NIFTY', payload: { action: 'EXIT', trackerId: 'k1' } });

  it('EXIT graded vs holding 60 min (CE: underlying fell after the exit → points saved)', () => {
    // Exit 11:05 → bar 11:00 closes 24100; 12:05 → bar 12:00 closes 24060.
    const bars = [...flat('11:00', '11:15', 24100), ...flat('11:15', '12:00', 24080), ...flat('12:00', '12:15', 24060)];
    const g = gradeDecision({ row: exitRow, now: NIGHT, trade: trade({ id: 'k1', exitAt: IST('11:05') }), underlying: 'NIFTY', bars });
    expect(g).toMatchObject({ kind: 'EXIT', vsHold60: 40, pnl: 3000, netPnl: 2880 });
    expect(g!.note).toContain('exit saved 40 pts');
  });

  it('BOOK on a PE: underlying fell after → holding would have made more (negative)', () => {
    const bars = [...flat('11:00', '11:15', 24100), ...flat('12:00', '12:15', 24060)];
    const g = gradeDecision({ row: { ...exitRow, action: 'BOOK' }, now: NIGHT, trade: trade({ id: 'k1', symbol: 'NIFTY25NOV2424000PE', exitAt: IST('11:05') }), underlying: 'NIFTY', bars });
    expect(g).toMatchObject({ kind: 'EXIT', vsHold60: -40 });
  });

  it('the 60-min window not over yet → null', () => {
    expect(gradeDecision({ row: exitRow, now: IST('11:50'), trade: trade({ id: 'k1', exitAt: IST('11:05') }), underlying: 'NIFTY', bars: [] })).toBeNull();
  });

  it('a failed EXIT is recorded as not executed; a missing bar leaves vsHold60 null', () => {
    expect(gradeDecision({ row: { ...exitRow, status: 'FAILED' }, now: NIGHT })!.note).toContain('not executed');
    const g = gradeDecision({ row: exitRow, now: NIGHT, trade: trade({ id: 'k1', exitAt: IST('11:05') }), underlying: 'NIFTY', bars: flat('11:00', '11:15', 24100) });
    expect(g).toMatchObject({ vsHold60: null });
    expect(g!.note).toContain('exit + 60 min');
  });
});

describe('gradeDecision — NO_ACTION', () => {
  const proposal: Proposal = { ref: 'reading:m1', kind: 'reading', at: IST('10:00').toISOString(), underlying: 'NIFTY', text: 'NIFTY buy above 24050', detail: { call: { side: 'BUY', entry: 24050, sl: 24000, targets: [24150] } } };
  const naRow = row({ action: 'NO_ACTION', status: 'VALID', payload: { action: 'NO_ACTION', proposalRef: 'reading:m1', reason: 'late', evidence: ['x'] } });

  it('NO_ACTION graded from the proposal\'s levels', () => {
    // From 10:02: bar 10:00 close 24030; 10:15 reaches 24050 (entry) then 24160 (target) — TARGET.
    const bars = [bar('10:00', 24020, 24035, 24015, 24030), bar('10:15', 24030, 24160, 24025, 24150), ...flat('10:30', '15:30', 24150)];
    const g = gradeDecision({ row: naRow, now: NIGHT, proposal, underlying: 'NIFTY', bars });
    expect(g).toMatchObject({ kind: 'NO_ACTION', hit: 'TARGET', pnl: null, mfe: null });
  });

  it('entry never reached → NEITHER; stop first → STOP', () => {
    const never = gradeDecision({ row: naRow, now: NIGHT, proposal, underlying: 'NIFTY', bars: flat('10:00', '15:30', 24020) });
    expect(never).toMatchObject({ hit: 'NEITHER' });
    expect(never!.note).toContain('never reached');
    const bars = [bar('10:00', 24020, 24035, 24015, 24030), bar('10:15', 24030, 24055, 23990, 24000), ...flat('10:30', '15:30', 24200)];
    expect(gradeDecision({ row: naRow, now: NIGHT, proposal, underlying: 'NIFTY', bars })).toMatchObject({ hit: 'STOP' });
  });

  it('session not over → null; no proposal / no levels → graded with a note', () => {
    expect(gradeDecision({ row: naRow, now: IST('15:00'), proposal, underlying: 'NIFTY', bars: [] })).toBeNull();
    expect(gradeDecision({ row: naRow, now: NIGHT, proposal: null })).toMatchObject({ kind: 'NO_ACTION', hit: null });
    const vague = { ...proposal, detail: { text: 'looks strong' } };
    expect(gradeDecision({ row: naRow, now: NIGHT, proposal: vague })!.note).toContain('no concrete SL / target');
  });

  it('proposalLevels reads zones and infers direction from target vs stop', () => {
    expect(proposalLevels({ ...proposal, detail: { setup: { entry: { low: 100, high: 102 }, sl: 110, targets: [90] } } })).toEqual({ dir: -1, entryLow: 100, entryHigh: 102, stop: 110, target: 90 });
  });
});

describe('gradeDecision — PAUSE / OTHER', () => {
  const pauseRow = row({ action: 'PAUSE_ENTRIES', payload: { action: 'PAUSE_ENTRIES', scope: 'all', minutes: 30 }, createdAt: IST('11:00') });

  it('counts automatic entries blocked while the pause was in force', () => {
    const ev = [
      { at: IST('11:05'), reasons: ['paused all until 11:30'] },
      { at: IST('11:20'), reasons: ['paused all until 11:30'] },
      { at: IST('11:25'), reasons: ['drawdown ₹5200 ≥ ₹5000'] },
      { at: IST('11:40'), reasons: ['paused all until 11:30'] },
    ];
    const g = gradeDecision({ row: pauseRow, now: NIGHT, guardEvents: ev });
    expect(g).toMatchObject({ kind: 'PAUSE', blocked: 2 });
    expect(g!.note).toContain('3 blocked in all');
  });

  it('pause still in force → null; TIGHTEN → OTHER', () => {
    expect(gradeDecision({ row: pauseRow, now: IST('11:10'), guardEvents: [] })).toBeNull();
    expect(gradeDecision({ row: row({ action: 'TIGHTEN' }), now: NIGHT })).toMatchObject({ kind: 'OTHER' });
  });
});

describe('helpers', () => {
  it('directionOf', () => {
    expect(directionOf('BUY_CE')).toBe(1);
    expect(directionOf('BUY_FUT')).toBe(1);
    expect(directionOf('BUY_PE')).toBe(-1);
    expect(directionOf('NIFTY25NOV2424000PE')).toBe(-1);
    expect(directionOf('GOLDM05DEC25FUT')).toBe(1);
    expect(directionOf('?')).toBeNull();
  });

  it('barsWindow: OPEN entry→exit, EXIT exit→+75 min, NO_ACTION to the session end (MCX 23:30)', () => {
    expect(barsWindow({ row: row(), trade: trade() })).toEqual({ from: IST('10:05'), to: IST('11:35') });
    expect(barsWindow({ row: row({ action: 'EXIT' }), trade: trade({ exitAt: IST('11:05') }) })).toEqual({ from: IST('11:05'), to: IST('12:20') });
    expect(barsWindow({ row: row({ action: 'NO_ACTION', underlying: 'GOLD' }) })!.to).toEqual(IST('23:30'));
  });
});
