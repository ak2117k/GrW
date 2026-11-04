import { SessionTuningService } from './session-tuning.service';

/** IST wall time → epoch ms. */
const ist = (s: string) => Date.parse(`${s}+05:30`);

describe('SessionTuningService (values fixed per IST session)', () => {
  const make = (rows: () => Array<{ target: string; value: unknown; appliedAt: Date; previousValue?: unknown }>, start: string) => {
    let t = ist(start);
    const source = { overrides: jest.fn(async () => rows()) };
    const svc = new SessionTuningService(source, () => t);
    return { svc, source, set: (s: string) => { t = ist(s); } };
  };

  it('override read at next session open, not mid-session', async () => {
    let rows: Array<{ target: string; value: unknown; appliedAt: Date; previousValue?: unknown }> = [];
    const { svc, set } = make(() => rows, '2026-11-05T09:10:00');
    await svc.load();
    expect(svc.get('exit.floorTrailN', 2)).toBe(2);
    // Applied at 11:00 mid-session (owner) — today keeps serving the value it replaced.
    rows = [{ target: 'exit.floorTrailN', value: 2.5, appliedAt: new Date(ist('2026-11-05T11:00:00')), previousValue: 2 }];
    set('2026-11-05T11:05:00');
    await svc.load(); // even a forced re-read (a restart mid-session) does not move today's value
    expect(svc.get('exit.floorTrailN', 2)).toBe(2);
    // Next IST date: the new value.
    set('2026-11-06T00:01:00');
    svc.get('exit.floorTrailN', 2); // kicks the day's load
    await svc.load();
    expect(svc.get('exit.floorTrailN', 2)).toBe(2.5);
    expect(svc.sessionDate()).toBe('2026-11-06');
  });

  it('a change applied today replaces an older override: today serves the older value, not the default', async () => {
    const rows = [{ target: 'exit.floorTrailN', value: 3, appliedAt: new Date(ist('2026-11-05T19:30:00')), previousValue: 2.5 }];
    const { svc } = make(() => rows, '2026-11-05T21:00:00'); // MCX evening session
    await svc.load();
    expect(svc.get('exit.floorTrailN', 2)).toBe(2.5);
  });

  it('applied today with no known previous value ⇒ the consumer default today', async () => {
    const rows = [{ target: 'signal.judgeMinConfidence', value: 65, appliedAt: new Date(ist('2026-11-05T19:30:00')) }];
    const { svc } = make(() => rows, '2026-11-05T20:00:00');
    await svc.load();
    expect(svc.get('signal.judgeMinConfidence', 60)).toBe(60);
  });

  it('unknown/forbidden target ignored', async () => {
    const old = new Date(ist('2026-11-01T19:30:00'));
    const rows = [
      { target: 'risk.maxDailyLoss', value: 1, appliedAt: old },
      { target: 'signal.maxLots', value: 9, appliedAt: old },
      { target: 'exit.holdList', value: true, appliedAt: old },
      { target: 'exit.floorArmN', value: 9, appliedAt: old }, // out of bounds
      { target: 'signal.judgeDefaultTake', value: 'yes', appliedAt: old }, // wrong type
      { target: 'carry.decideByMin', value: 5, appliedAt: old },
    ];
    const { svc } = make(() => rows, '2026-11-05T10:00:00');
    await svc.load();
    expect(svc.get('risk.maxDailyLoss', 7)).toBe(7);
    expect(svc.get('signal.maxLots', 1)).toBe(1);
    expect(svc.get('exit.holdList', false)).toBe(false);
    expect(svc.get('exit.floorArmN', 1.5)).toBe(1.5);
    expect(svc.get('signal.judgeDefaultTake', true)).toBe(true);
    expect(svc.get('carry.decideByMin', 6)).toBe(5);
  });

  it('never loaded / DB down ⇒ the consumer default; a failed day load keeps the last good snapshot', async () => {
    let fail = true;
    const old = new Date(ist('2026-11-01T19:30:00'));
    const { svc, set } = make(() => {
      if (fail) throw new Error('db down');
      return [{ target: 'exit.floorArmN', value: 2, appliedAt: old }];
    }, '2026-11-05T10:00:00');
    await svc.load();
    expect(svc.get('exit.floorArmN', 1.5)).toBe(1.5);
    fail = false;
    set('2026-11-05T10:02:00');
    await svc.load();
    expect(svc.get('exit.floorArmN', 1.5)).toBe(2);
    fail = true;
    set('2026-11-06T09:00:00');
    await svc.load();
    expect(svc.get('exit.floorArmN', 1.5)).toBe(2);
  });
});
