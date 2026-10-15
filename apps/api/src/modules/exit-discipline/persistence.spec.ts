import { parseExitDisciplineConfig } from './config';
import { evaluatePersistence, type HistoryVerdict } from './persistence';

const CFG = parseExitDisciplineConfig({});
const T = new Date('2026-10-14T11:01:00Z');
const ago = (s: number) => new Date(T.getTime() - s * 1000);
const h = (verdict: string, s: number, id = `${verdict}-${s}`): HistoryVerdict =>
  ({ id, verdict, createdAt: ago(s), underlying: null, support: null, resistance: null });
const run = (history: HistoryVerdict[], bypass = false) =>
  evaluatePersistence({ current: { id: 'cur', createdAt: T }, history, bypass, cfg: CFG });

describe('evaluatePersistence (spec §7)', () => {
  it('bypass confirms at once', () => {
    expect(run([], true)).toMatchObject({ confirmed: true, rule: 'BYPASS' });
  });
  it('first EXIT_NOW after a HOLD is not confirmed', () => {
    expect(run([h('HOLD', 60)])).toMatchObject({ confirmed: false, rule: null, streakStart: { id: 'cur', ageSec: 0 } });
  });
  it('previous verdict EXIT_NOW within the window ⇒ CONSECUTIVE', () => {
    expect(run([h('EXIT_NOW', 90), h('HOLD', 400)])).toMatchObject({ confirmed: true, rule: 'CONSECUTIVE', previous: { verdict: 'EXIT_NOW', ageSec: 90 } });
  });
  it('previous EXIT_NOW outside the window but streak >= PERSIST_MIN_SEC ⇒ SUSTAINED', () => {
    expect(run([h('EXIT_NOW', 400)])).toMatchObject({ confirmed: true, rule: 'SUSTAINED', streakStart: { ageSec: 400 } });
  });
  it('EXIT_ARMED and ESCALATE do not break a streak', () => {
    expect(run([h('EXIT_ARMED', 60), h('ESCALATE', 100), h('EXIT_NOW', 150), h('HOLD', 200)]))
      .toMatchObject({ confirmed: true, rule: 'SUSTAINED', streakStart: { id: 'EXIT_NOW-150', ageSec: 150 } });
  });
  it('streak younger than PERSIST_MIN_SEC with a non-EXIT_NOW previous ⇒ not confirmed', () => {
    expect(run([h('EXIT_ARMED', 60), h('EXIT_NOW', 100), h('HOLD', 300)])).toMatchObject({ confirmed: false, rule: null });
  });
  it('a HOLD in between resets the streak (the six flip-flops of 2026-10-14 need a fresh confirmation)', () => {
    expect(run([h('HOLD', 100), h('EXIT_NOW', 500)])).toMatchObject({ confirmed: false, streakStart: { id: 'cur' } });
  });
  it('empty history ⇒ the current verdict starts the streak', () => {
    expect(run([])).toMatchObject({ confirmed: false, previous: null, streakStart: { id: 'cur', ageSec: 0 } });
  });
  it('history is filtered to strictly-before-current (a row at the same instant is ignored)', () => {
    expect(run([{ ...h('EXIT_NOW', 0), id: 'same' }])).toMatchObject({ confirmed: false });
  });
});
