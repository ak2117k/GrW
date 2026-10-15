import { exitConfirmFire, withExitConfirm } from './exit-confirm';

const NOW = new Date('2026-10-14T11:03:00Z');
const v = (verdict: string, secAgo: number) => ({ verdict, createdAt: new Date(NOW.getTime() - secAgo * 1000) });
const run = (recent: ReturnType<typeof v>[]) => exitConfirmFire({ recent, now: NOW, relookMs: 120_000, maxRelooks: 3 });

describe('exitConfirmFire', () => {
  it('latest EXIT_NOW, >= relook ago ⇒ fires with the count', () => {
    expect(run([v('EXIT_NOW', 130), v('HOLD', 600)])).toEqual({
      name: 'exit-confirm', detail: expect.stringMatching(/EXIT_NOW.*1 in a row.*judge it afresh/),
    });
  });
  it('the wording is neutral: it never tells the judge that repeating EXIT_NOW executes the exit', () => {
    const d = run([v('EXIT_NOW', 130), v('HOLD', 600)])!.detail;
    expect(d).not.toMatch(/second EXIT_NOW|confirms it|executes/i);
    expect(d).toMatch(/not a reason to repeat it/);
  });
  it('too soon ⇒ null', () => expect(run([v('EXIT_NOW', 60)])).toBeNull());
  it('latest is not EXIT_NOW ⇒ null', () => expect(run([v('EXIT_ARMED', 300), v('EXIT_NOW', 400)])).toBeNull());
  it('stops after 3 consecutive EXIT_NOWs (cost cap)', () => {
    expect(run([v('EXIT_NOW', 130), v('EXIT_NOW', 260), v('EXIT_NOW', 390)])).not.toBeNull();
    expect(run([v('EXIT_NOW', 130), v('EXIT_NOW', 260), v('EXIT_NOW', 390), v('EXIT_NOW', 520)])).toBeNull();
  });
  it('no history ⇒ null', () => expect(run([])).toBeNull());
});

describe('withExitConfirm', () => {
  const quiet = { fires: [], heartbeat: false, shouldEvaluate: false, trigger: null } as never;
  it('adds the fire and wakes the agent as a FIRE', () => {
    expect(withExitConfirm(quiet, { name: 'exit-confirm', detail: 'd' })).toEqual({
      fires: [{ name: 'exit-confirm', detail: 'd' }], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE',
    });
  });
  it('null fire ⇒ unchanged object', () => expect(withExitConfirm(quiet, null)).toBe(quiet));
});
