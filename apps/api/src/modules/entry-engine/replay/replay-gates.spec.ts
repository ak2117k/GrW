import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { replayGates, type GateFixtureV1 } from './replay-gates';

const MIN = 60_000;
const DAY0 = Date.parse('2026-11-11T03:45:00Z'); // 09:15 IST, Wednesday

/** Session 1m bars for `days` NSE sessions ending on DAY0's day, rising `step` a minute from 25000; then a steep 35-min run. */
function bars(days: number, step: number, run: number): Array<[number, number, number, number, number]> {
  const out: Array<[number, number, number, number, number]> = [];
  let px = 25_000;
  for (let d = days; d >= 0; d--) {
    const open = DAY0 - d * 86_400_000;
    const wd = new Date(open + 330 * MIN).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const mins = d === 0 ? 35 : 375;
    for (let i = 0; i < mins; i++) {
      const wiggle = i % 2 === 0 ? 3 : -2;
      const next = px + (d === 0 ? run : step) + wiggle;
      out.push([open + i * MIN, px, Math.max(px, next) + 2, Math.min(px, next) - 2, next]);
      px = next;
    }
  }
  return out;
}

const dec = (o: Partial<GateFixtureV1['decisions'][number]> = {}): GateFixtureV1['decisions'][number] => ({
  id: 'd1',
  underlying: 'NIFTY',
  at: new Date(DAY0 + 35 * MIN).toISOString(), // 09:50 IST
  action: 'ENTER_CE',
  tradeId: 't1',
  pnl: -1622,
  line: { exchange: 'NSE', token: '99926000' },
  materialPath: 'STORY',
  preOpen: null,
  ...o,
});

describe('gate replay over recorded ENTER decisions', () => {
  it('an ENTER at the top of a steep opening run waits (chase); NO_TRADE rows are not replayed', () => {
    const fx: GateFixtureV1 = { v: 1, decisions: [dec(), dec({ id: 'n', action: 'NO_TRADE' })], m1: { 'NSE:99926000': bars(9, 0.05, 3) }, s15: {} };
    const rows = replayGates(fx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'd1', oldAction: 'ENTER_CE', newAction: 'WAIT', ist: '11-11 09:50' });
    expect(rows[0].why).toContain('already extended');
    expect(rows[0].extension!.fromSwingN15!).toBeGreaterThan(1.5);
  });

  it('a PRE_OPEN-material ENTER on an NSE index after 09:30 becomes NO_TRADE (pre-open gap priced in)', () => {
    const fx: GateFixtureV1 = { v: 1, decisions: [dec({ underlying: 'BANKNIFTY', line: { exchange: 'NSE', token: '99926009' }, materialPath: 'PRE_OPEN', preOpen: { bias: 'BULLISH', confidence: 0.75, at: '2026-11-11T03:00:00.000Z' } })], m1: {}, s15: {} };
    const [r] = replayGates(fx);
    expect(r.newAction).toBe('NO_TRADE');
    expect(r.why).toContain('expired at 09:30');
  });

  it('index cluster: the second cluster ENTER of the same scan pass is not opened; MCX is outside the cluster', () => {
    // No price line → the gates read UNKNOWN (never block), so only the cluster cap acts here.
    const fx: GateFixtureV1 = {
      v: 1,
      decisions: [
        dec({ id: 'a', underlying: 'NIFTY', line: null }),
        dec({ id: 'b', underlying: 'SENSEX', at: new Date(DAY0 + 35 * MIN + 4_000).toISOString(), line: null }),
        dec({ id: 'c', underlying: 'CRUDEOIL', line: null }),
      ],
      m1: {},
      s15: {},
    };
    const rows = replayGates(fx);
    expect(rows.find((r) => r.id === 'a')!.newAction).toBe('ENTER_CE');
    expect(rows.find((r) => r.id === 'b')!.newAction).toBe('ENTER_CE (cluster: not opened)');
    expect(rows.find((r) => r.id === 'c')!.newAction).toBe('ENTER_CE');
  });

  // The real prod export is git-ignored (fixtures/gates.real.json, sql/export-gate-replay.sql); replayed when present.
  const real = join(__dirname, 'fixtures', 'gates.real.json');
  (existsSync(real) ? it : it.skip)('prod 2026-11-11 (export): the three 09:50 losers wait; the 10:28 BANKNIFTY re-entry minute would not', () => {
    const rows = replayGates(JSON.parse(readFileSync(real, 'utf8')) as GateFixtureV1);
    const losers = ['d384c614-b1da-482e-bf8b-53f99cdbb04a', 'a5a5af0b-7263-4f1f-9db9-d538c05f0bd2', '24b85c4c-b8d7-4d4b-9a7f-78dce3f4fda0'];
    for (const id of losers) expect(['WAIT', 'NO_TRADE']).toContain(rows.find((r) => r.id === id)?.newAction);
    const fx = JSON.parse(readFileSync(real, 'utf8')) as GateFixtureV1;
    const reentry = replayGates({ ...fx, decisions: [{ id: 'reentry', underlying: 'BANKNIFTY', at: '2026-11-11T04:58:00.000Z', action: 'ENTER_CE', tradeId: null, pnl: null, line: { exchange: 'NSE', token: '99926009' }, materialPath: 'STORY', preOpen: null }] });
    expect(reentry[0].newAction).toBe('ENTER_CE');
    // eslint-disable-next-line no-console
    if (process.env.GATE_REPLAY_PRINT) console.log([...rows, ...reentry].map((r) => `${r.ist} ${r.underlying.padEnd(9)} ${r.traded ? `T ${String(r.pnl).padStart(7)}` : '-        '} ${r.oldAction} -> ${r.newAction.padEnd(28)} ind ${r.indicators?.tag ?? '-'} macd ${r.indicators?.macdHist ?? '-'}/${r.indicators?.macdPrevHist ?? '-'} rsi ${r.indicators?.rsi ?? '-'} | swing ${r.extension?.fromSwingN15 ?? '-'} ema ${r.extension?.fromEma20N15 ?? '-'} N15 ${r.extension?.n15 ?? '-'} | ${r.id.slice(0, 8)} ${r.why.slice(0, 90)}`).join('\n'));
  });
});
