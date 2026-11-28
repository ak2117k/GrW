import { parseDeskManagerConfig } from '../desk-manager.config';
import type { ActionResult, DeskPacket, ManagerDecision } from '../domain/desk.types';
import { ManagerRunnerService } from './manager-runner.service';

const T0 = new Date('2026-11-26T04:30:00.000Z'); // 10:00 IST
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const sec = (n: number) => new Date(T0.getTime() + n * 1000);

const blk = <T>(value: T) => ({ status: 'present' as const, value, source: 'test' });
const PACKET = {
  at: T0.toISOString(),
  mode: 'shadow',
  positions: blk([
    { trackerId: 't1', symbol: 'BSE25NOV2850CE', exchange: 'BFO', underlying: 'BSE', qty: 75, entry: 40, ltp: 45, pnl: 375, ageMin: 20, origin: 'manager', held: false, sentinel: null, managerStop: 2820, managerTargets: [2900] },
  ]),
  instruments: blk({ BSE: { underlying: 'BSE', ltp: 2860 }, NIFTY: { underlying: 'NIFTY', ltp: 24000 } }),
} as unknown as DeskPacket;

const ev = { reason: 'r', evidence: ['ltp 2860'] };
const OPEN = { action: 'OPEN', underlying: 'NIFTY', side: 'BUY_CE', strikePolicy: 'ATM', expiryPolicy: 'NEAREST', entry: { type: 'NOW', low: null, high: null, triggerAbove: null, triggerBelow: null, validMin: 10 }, stop: { underlying: 23950 }, targets: { underlying: [24100] }, proposalRef: null, confidence: 'medium', ...ev };
const EXIT = { action: 'EXIT', trackerId: 't1', ...ev };
const TIGHTEN = { action: 'TIGHTEN', trackerId: 't1', underlyingStop: 2840, ...ev };
const PAUSE = { action: 'PAUSE_ENTRIES', scope: 'all', minutes: 30, ...ev };
const NO_ACTION = { action: 'NO_ACTION', ...ev };
const reply = (...decisions: unknown[]) => JSON.stringify({ summary: 'ok', decisions });

function make(o: { env?: Record<string, string>; busy?: boolean; text?: string; venueOpen?: boolean; calls?: number } = {}) {
  const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'shadow', HUB_OWNER_USER_ID: 'owner', ...o.env });
  const builder = { build: jest.fn(async () => PACKET), busy: jest.fn(async () => o.busy ?? false) };
  const actions = { execute: jest.fn(async (_d: ManagerDecision): Promise<ActionResult> => ({ status: 'RECORDED', detail: 'ok' })) };
  const llm = { decide: jest.fn(async () => ({ text: o.text ?? reply(NO_ACTION), ms: 5, model: 'm' })) };
  let n = 0;
  const repo = {
    createRun: jest.fn(async () => `run${++n}`),
    finishRun: jest.fn(async () => undefined),
    insertDecision: jest.fn(async (w: { decision: ManagerDecision }) => `dec-${w.decision.action}-${++n}`),
    setDecisionResult: jest.fn(async () => undefined),
    countAiCallsSince: jest.fn(async () => o.calls ?? 0),
  };
  const svc = new ManagerRunnerService(cfg, builder, actions, llm as never, repo as never);
  const alerts: string[] = [];
  const texts: string[] = [];
  svc.venueOpen = () => o.venueOpen ?? true;
  svc.alert = async (key: string, text: string) => {
    alerts.push(key);
    texts.push(text);
  };
  return { svc, cfg, builder, actions, llm, repo, alerts, texts };
}
const silent = (keys: string[]) => keys.filter((k) => k.startsWith('desk-manager-silent'));
const failedAlerts = (keys: string[]) => keys.filter((k) => k.startsWith('desk-manager-run-failed'));

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('ManagerRunnerService', () => {
  it('cadence 3 min when busy, 10 when idle', async () => {
    const idle = make({ busy: false });
    await idle.svc.tick(T0);
    await idle.svc.tick(min(3));
    await idle.svc.tick(min(9));
    expect(idle.llm.decide).toHaveBeenCalledTimes(1);
    await idle.svc.tick(min(10));
    expect(idle.llm.decide).toHaveBeenCalledTimes(2);

    const busy = make({ busy: true });
    await busy.svc.tick(T0);
    await busy.svc.tick(min(2));
    expect(busy.llm.decide).toHaveBeenCalledTimes(1);
    await busy.svc.tick(min(3));
    expect(busy.llm.decide).toHaveBeenCalledTimes(2);
  });

  it('wake debounces 20 s into one run', async () => {
    const { svc, llm, repo } = make();
    await svc.tick(T0);
    svc.wake('tracker_opened', sec(60));
    svc.wake('reading_call', sec(65));
    svc.wake('tracker_opened', sec(70));
    await svc.tick(sec(75));
    expect(llm.decide).toHaveBeenCalledTimes(1);
    await svc.tick(sec(80));
    expect(llm.decide).toHaveBeenCalledTimes(2);
    expect((repo.createRun.mock.calls[1] as unknown as [{ wakeReasons: string[] }])[0].wakeReasons.sort()).toEqual(['reading_call', 'tracker_opened']);
    await svc.tick(sec(110));
    expect(llm.decide).toHaveBeenCalledTimes(2);
  });

  it('the debounce timer fires the run by itself', async () => {
    const { svc, llm } = make();
    await svc.tick(T0);
    svc.wake('sentinel_exit', sec(60));
    await jest.advanceTimersByTimeAsync(20_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(llm.decide).toHaveBeenCalledTimes(2);
  });

  it('single-flight', async () => {
    const m = make();
    let release!: (v: { text: string; ms: number; model: string }) => void;
    m.llm.decide.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const first = m.svc.runOnce(['manual'], T0);
    await jest.advanceTimersByTimeAsync(0);
    expect(await m.svc.runOnce(['manual'], T0)).toBeNull();
    await m.svc.tick(min(30));
    expect(m.llm.decide).toHaveBeenCalledTimes(1);
    release({ text: reply(NO_ACTION), ms: 1, model: 'm' });
    expect(await first).toEqual({ runId: 'run1', decisions: 1 });
  });

  it('a run over 150 s is abandoned: recorded, nothing acted on', async () => {
    const m = make();
    let release!: (v: { text: string; ms: number; model: string }) => void;
    m.llm.decide.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const run = m.svc.runOnce(['manual'], T0);
    await jest.advanceTimersByTimeAsync(150_000);
    expect(await run).toEqual({ runId: 'run1', decisions: 0 });
    expect(m.repo.finishRun).toHaveBeenCalledWith('run1', expect.objectContaining({ error: expect.stringMatching(/abandoned/) }));
    release({ text: reply(EXIT), ms: 1, model: 'm' });
    await jest.advanceTimersByTimeAsync(0);
    expect(m.actions.execute).not.toHaveBeenCalled();
    expect(m.repo.insertDecision).not.toHaveBeenCalled();
    expect(m.svc.lastCompletedAt()).toBeNull();
  });

  it('call cap stops runs and alerts once', async () => {
    const m = make({ env: { DESK_MANAGER_MAX_CALLS: '2' }, calls: 1 });
    await m.svc.tick(T0);
    expect(m.llm.decide).toHaveBeenCalledTimes(1);
    expect(m.svc.opensBlocked()).toBe(true); // 2 of 2 used: no more opening
    await m.svc.tick(min(10));
    await m.svc.tick(min(20));
    await m.svc.tick(min(40));
    expect(m.llm.decide).toHaveBeenCalledTimes(1);
    expect(m.alerts.filter((k) => k === 'desk-manager-call-cap')).toHaveLength(1);
    expect(m.alerts).not.toContain('desk-manager-silent');
    expect(m.svc.opensBlocked()).toBe(true);
    expect(m.repo.countAiCallsSince).toHaveBeenCalledWith('owner', new Date('2026-11-25T18:30:00.000Z'));
  });

  it('health blocks opens after silence (idle 10 + 5 min) and a completed run clears it', async () => {
    const m = make();
    m.llm.decide.mockRejectedValue(new Error('vertex 529'));
    await m.svc.tick(T0);
    await m.svc.tick(min(10));
    await m.svc.tick(min(14));
    expect(m.svc.opensBlocked()).toBe(false);
    expect(silent(m.alerts)).toEqual([]);
    await m.svc.tick(min(15));
    expect(m.svc.opensBlocked()).toBe(true);
    expect(silent(m.alerts)).toHaveLength(1);
    expect(m.repo.finishRun).toHaveBeenCalledWith('run1', expect.objectContaining({ error: 'ai: vertex 529' }));
    m.llm.decide.mockResolvedValue({ text: reply(NO_ACTION), ms: 1, model: 'm' });
    await m.svc.tick(min(20));
    expect(m.svc.opensBlocked()).toBe(false);
    expect(m.svc.lastCompletedAt()).toEqual(min(20));
  });

  it('silence counts from when the venue opened, not from yesterday', async () => {
    const m = make();
    let open = false;
    m.svc.venueOpen = () => open;
    await m.svc.tick(T0);
    open = true;
    m.llm.decide.mockRejectedValue(new Error('down'));
    await m.svc.tick(min(600));
    expect(silent(m.alerts)).toEqual([]);
  });

  it('missed-run alert: once per gap (> 15 min without a completed run while a venue is open), again for a new gap', async () => {
    const m = make();
    m.llm.decide.mockRejectedValue(new Error('vertex 529'));
    for (let t = 0; t <= 60; t += 1) await m.svc.tick(min(t));
    expect(silent(m.alerts)).toHaveLength(1);
    m.llm.decide.mockResolvedValue({ text: reply(NO_ACTION), ms: 1, model: 'm' });
    await m.svc.tick(min(70));
    expect(m.svc.lastCompletedAt()).toEqual(min(70));
    m.llm.decide.mockRejectedValue(new Error('down again'));
    for (let t = 71; t <= 84; t += 1) await m.svc.tick(min(t));
    expect(silent(m.alerts)).toHaveLength(1);
    for (let t = 85; t <= 120; t += 1) await m.svc.tick(min(t));
    expect(silent(m.alerts)).toHaveLength(2);
    expect(new Set(silent(m.alerts)).size).toBe(2); // distinct keys: the ops-alert cooldown never swallows a new gap
  });

  it('failed-run alert: any run error alerts, at most once per 30 min', async () => {
    const m = make();
    m.llm.decide.mockRejectedValue(new Error('vertex 529'));
    await m.svc.tick(T0);
    expect(failedAlerts(m.alerts)).toHaveLength(1);
    expect(m.texts.find((t) => t.includes('vertex 529'))).toBeDefined();
    await m.svc.tick(min(10));
    await m.svc.tick(min(20));
    expect(failedAlerts(m.alerts)).toHaveLength(1);
    await m.svc.tick(min(30));
    expect(failedAlerts(m.alerts)).toHaveLength(2);
    m.builder.build.mockRejectedValueOnce(new Error('db timeout'));
    await m.svc.tick(min(40));
    expect(failedAlerts(m.alerts)).toHaveLength(2);
    await m.svc.tick(min(60));
    expect(failedAlerts(m.alerts)).toHaveLength(3);
  });

  it('a malformed reply is a failed run too', async () => {
    const m = make({ text: 'not json' });
    await m.svc.runOnce(['cadence'], T0);
    expect(failedAlerts(m.alerts)).toHaveLength(1);
  });

  it('exits executed before opens; invalid decisions stored INVALID and never executed', async () => {
    const badOpen = { ...OPEN, underlying: 'BSE', stop: { underlying: 2900 } }; // stop above entry for a CE
    const m = make({ text: reply(OPEN, NO_ACTION, PAUSE, badOpen, TIGHTEN, EXIT) });
    const out = await m.svc.runOnce(['cadence'], T0);
    expect(out).toEqual({ runId: 'run1', decisions: 6 });
    expect(m.actions.execute.mock.calls.map((c) => c[0].action)).toEqual(['TIGHTEN', 'EXIT', 'PAUSE_ENTRIES', 'OPEN', 'NO_ACTION']);
    const problems = m.repo.insertDecision.mock.calls.map((c) => (c[0] as unknown as { problems: string[] }).problems);
    expect(problems[3].join()).toMatch(/wrong side/);
    expect(problems.filter((p) => p.length > 0)).toHaveLength(1);
    expect(m.repo.setDecisionResult).toHaveBeenCalledTimes(5);
    const ctx = (m.actions.execute.mock.calls[0] as unknown as [unknown, { runId: string; decisionId: string; packet: unknown }])[1];
    expect(ctx).toMatchObject({ runId: 'run1', packet: PACKET });
    expect(ctx.decisionId).toMatch(/^dec-TIGHTEN/);
    expect(m.repo.finishRun).toHaveBeenCalledWith('run1', expect.objectContaining({ summary: 'ok' }));
  });

  it('an action that throws is stored FAILED and the rest still run', async () => {
    const m = make({ text: reply(EXIT, OPEN) });
    m.actions.execute.mockRejectedValueOnce(new Error('broker down'));
    await m.svc.runOnce(['cadence'], T0);
    expect((m.repo.setDecisionResult.mock.calls[0] as unknown as [string, unknown])[1]).toEqual({ result: { status: 'FAILED', detail: 'broker down' } });
    expect(m.actions.execute).toHaveBeenCalledTimes(2);
  });

  it('malformed reply acts on nothing (error recorded with the raw text)', async () => {
    const m = make({ text: 'Sure! I would buy NIFTY here.' });
    expect(await m.svc.runOnce(['cadence'], T0)).toEqual({ runId: 'run1', decisions: 0 });
    expect(m.actions.execute).not.toHaveBeenCalled();
    expect(m.repo.insertDecision).not.toHaveBeenCalled();
    expect(m.repo.finishRun).toHaveBeenCalledWith('run1', expect.objectContaining({ error: expect.stringMatching(/^reply: /), reply: { raw: 'Sure! I would buy NIFTY here.' } }));
    expect(m.svc.lastCompletedAt()).toBeNull();
  });

  it('a packet failure records the error and skips the AI', async () => {
    const m = make();
    m.builder.build.mockRejectedValueOnce(new Error('db timeout'));
    await m.svc.runOnce(['cadence'], T0);
    expect(m.llm.decide).not.toHaveBeenCalled();
    expect(m.repo.finishRun).toHaveBeenCalledWith('run1', expect.objectContaining({ error: 'packet: db timeout' }));
  });

  it('a WATCH schedules a watch_recheck wake after recheckMin', async () => {
    const m = make({ text: reply({ action: 'WATCH', underlying: 'NIFTY', note: 'n', recheckMin: 6, ...ev }) });
    await m.svc.runOnce(['cadence'], T0);
    const wake = jest.spyOn(m.svc, 'wake');
    await jest.advanceTimersByTimeAsync(6 * 60_000);
    expect(wake).toHaveBeenCalledWith('watch_recheck');
  });

  it('no run while every venue is closed', async () => {
    const m = make({ venueOpen: false });
    await m.svc.tick(T0);
    m.svc.wake('manual', T0);
    await m.svc.tick(min(1));
    expect(m.llm.decide).not.toHaveBeenCalled();
  });

  it('mode off never calls the LLM', async () => {
    const m = make({ env: { DESK_MANAGER: 'off' } });
    m.svc.onModuleInit();
    m.svc.wake('manual', T0);
    await m.svc.tick(T0);
    await m.svc.tick(min(30));
    expect(await m.svc.runOnce(['manual'], min(31))).toBeNull();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(m.llm.decide).not.toHaveBeenCalled();
    expect(m.builder.build).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('no owner configured → no run', async () => {
    const m = make({ env: { HUB_OWNER_USER_ID: '' } });
    await m.svc.tick(T0);
    expect(m.llm.decide).not.toHaveBeenCalled();
  });
});
