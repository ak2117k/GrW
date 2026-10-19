import {
  __configureBootLane, BOOT_LANE_GAP_MS, BOOT_LANE_MAX_WAIT_MS, BOOT_LANE_START_DELAY_MS, runInBootLane,
} from './boot-lane';

/** Fake clock: sleep resolves when `advance` passes its deadline. */
function fakeTimers() {
  let t = 0;
  const waiting: { at: number; r: () => void }[] = [];
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((r) => waiting.push({ at: t + ms, r })),
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await flush();
        waiting.sort((a, b) => a.at - b.at);
        const next = waiting[0];
        if (!next || next.at > end) break;
        waiting.shift(); t = next.at; next.r();
      }
      t = end; await flush();
    },
  };
}

describe('runInBootLane (prod 2026-10-19: six boot jobs throttled each other at Angel)', () => {
  let ft: ReturnType<typeof fakeTimers>;
  beforeEach(() => { ft = fakeTimers(); __configureBootLane({ timers: ft, immediate: false }); });
  afterAll(() => __configureBootLane({ timers: null, immediate: true }));

  it('runs jobs one at a time, lowest priority number first, after the start delay', async () => {
    const order: string[] = [];
    let active = 0; let maxActive = 0;
    const job = (n: string) => async () => { active++; maxActive = Math.max(maxActive, active); order.push(n); await ft.sleep(1000); active--; };
    void runInBootLane('gap-scan', 60, job('gap'));
    void runInBootLane('universe', 10, job('universe'));
    void runInBootLane('mbm', 20, job('mbm'));
    await ft.advance(BOOT_LANE_START_DELAY_MS - 1);
    expect(order).toEqual([]);
    await ft.advance(10 * (BOOT_LANE_GAP_MS + 1000));
    expect(order).toEqual(['universe', 'mbm', 'gap']);
    expect(maxActive).toBe(1);
  });

  it('a failing job is logged and the lane carries on; its promise still resolves', async () => {
    const ran: string[] = [];
    const failed = runInBootLane('bad', 10, async () => { throw new Error('boom'); });
    void runInBootLane('good', 20, async () => { ran.push('good'); });
    await ft.advance(BOOT_LANE_START_DELAY_MS + BOOT_LANE_GAP_MS + 10);
    await expect(failed).resolves.toBeUndefined();
    expect(ran).toEqual(['good']);
  });

  it('a stuck job holds the lane at most MAX_WAIT, then the next job starts', async () => {
    const ran: string[] = [];
    void runInBootLane('stuck', 10, () => new Promise(() => undefined));
    void runInBootLane('next', 20, async () => { ran.push('next'); });
    await ft.advance(BOOT_LANE_START_DELAY_MS + BOOT_LANE_MAX_WAIT_MS - 10);
    expect(ran).toEqual([]);
    await ft.advance(BOOT_LANE_GAP_MS + 20);
    expect(ran).toEqual(['next']);
  });

  it('immediate mode (the Jest default for other specs) runs the job right away', async () => {
    __configureBootLane({ timers: ft, immediate: true });
    const ran: string[] = [];
    await runInBootLane('x', 10, async () => { ran.push('x'); });
    expect(ran).toEqual(['x']);
  });
});
