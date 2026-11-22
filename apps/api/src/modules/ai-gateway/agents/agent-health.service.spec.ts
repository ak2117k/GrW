import { EventEmitter } from 'node:events';
import { AGENT_PROTOCOL } from './agent-protocol';
import { AgentLinkState } from './agent-provider';
import {
  AGENT_HEALTH_FAILS_TO_ALERT,
  AGENT_HEALTH_INTERVAL_MS,
  AGENT_HEALTH_TIMEOUT_MS,
  AGENT_RSS_WARN_MB,
  AgentHealthService,
  type HealthFetch,
} from './agent-health.service';

const ON = { AI_AGENTS: 'on', SENTINEL_JUDGE: 'vertex' } as NodeJS.ProcessEnv;

/** Monday 2026-11-23 10:00 IST (04:30 UTC): every market open. */
const MON_10_IST = Date.parse('2026-11-23T04:30:00Z');
/** Sunday 2026-11-22 10:00 IST: closed. */
const SUN_10_IST = Date.parse('2026-11-22T04:30:00Z');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Reply = { ok: boolean; status: number; body?: unknown } | Error;

function healthy(group: string, rssMb = 60) {
  return { ok: true, status: 200, body: { group, protocol: AGENT_PROTOCOL, rssMb, agents: {} } };
}

function setup(opts: { env?: NodeJS.ProcessEnv; now?: number } = {}) {
  const links = new AgentLinkState();
  let now = opts.now ?? MON_10_IST;
  const replies: Record<string, Reply> = {
    trading: healthy('trading'),
    reading: healthy('reading'),
    background: healthy('background'),
  };
  const calls: Array<{ url: string; signal: AbortSignal | undefined }> = [];
  const fetch: HealthFetch = async (url, init) => {
    calls.push({ url, signal: init.signal });
    const group = /grw-agents-(\w+)/.exec(url)?.[1] ?? '';
    const r = replies[group];
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
  const sent: Array<{ key: string; text: string }> = [];
  const send = jest.fn(async (key: string, text: string) => {
    sent.push({ key, text });
    return true;
  });
  const events = new EventEmitter();
  const svc = new AgentHealthService({
    env: opts.env ?? ON,
    fetch,
    send,
    now: () => now,
    events,
    log: { log: () => undefined, warn: () => undefined },
    links,
  });
  return {
    svc,
    links,
    replies,
    calls,
    sent,
    send,
    events,
    setNow: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('AgentHealthService', () => {
  afterEach(() => jest.useRealTimers());

  describe('agents off', () => {
    it.each([
      ['AI_AGENTS unset', { SENTINEL_JUDGE: 'vertex' }],
      ['AI_AGENTS=off', { AI_AGENTS: 'off', SENTINEL_JUDGE: 'vertex' }],
      ['SENTINEL_JUDGE=cli', { AI_AGENTS: 'on', SENTINEL_JUDGE: 'cli' }],
    ])('%s: never polls, never subscribes, never alerts', async (_l, env) => {
      jest.useFakeTimers();
      const t = setup({ env: env as NodeJS.ProcessEnv });
      t.svc.onModuleInit();
      jest.advanceTimersByTime(AGENT_HEALTH_INTERVAL_MS * 5);
      await t.svc.checkAll();
      t.events.emit('fallback', { group: 'trading', job: 'sentinel.judge', reason: 'ECONNREFUSED' });
      t.events.emit('quota', { job: 'news.impact' });
      expect(t.calls).toHaveLength(0);
      expect(t.events.listenerCount('fallback')).toBe(0);
      expect(t.events.listenerCount('quota')).toBe(0);
      expect(t.send).not.toHaveBeenCalled();
      t.svc.onModuleDestroy();
    });
  });

  describe('polling', () => {
    it('polls every group /health every 60 s with a 5 s timeout signal once started', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.svc.onModuleInit();
      expect(t.calls).toHaveLength(0);
      jest.advanceTimersByTime(AGENT_HEALTH_INTERVAL_MS);
      await flush();
      expect(t.calls.map((c) => c.url).sort()).toEqual([
        'http://grw-agents-background:5300/health',
        'http://grw-agents-reading:5300/health',
        'http://grw-agents-trading:5300/health',
      ]);
      expect(t.calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
      jest.advanceTimersByTime(AGENT_HEALTH_INTERVAL_MS);
      await flush();
      expect(t.calls).toHaveLength(6);
      t.svc.onModuleDestroy();
      jest.advanceTimersByTime(AGENT_HEALTH_INTERVAL_MS * 3);
      expect(t.calls).toHaveLength(6);
      expect(AGENT_HEALTH_TIMEOUT_MS).toBe(5_000);
    });

    it('honours AGENT_URL_<GROUP>', async () => {
      const t = setup({ env: { ...ON, AGENT_URL_TRADING: 'http://localhost:9999/' } });
      t.replies.trading = healthy('trading');
      await t.svc.checkAll();
      expect(t.calls.map((c) => c.url)).toContain('http://localhost:9999/health');
    });
  });

  describe('down / recovery', () => {
    it('alerts once after 3 consecutive failures, once on recovery', async () => {
      const t = setup();
      t.replies.trading = new Error('connect ECONNREFUSED');
      for (let i = 0; i < AGENT_HEALTH_FAILS_TO_ALERT - 1; i++) await t.svc.checkAll();
      expect(t.send).not.toHaveBeenCalled();
      await t.svc.checkAll();
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0].key).toMatch(/^AGENT_DOWN:trading:/);
      expect(t.sent[0].text).toContain('grw-agents-trading');
      expect(t.sent[0].text).toContain('ECONNREFUSED');
      // still down: no repeats
      for (let i = 0; i < 10; i++) await t.svc.checkAll();
      expect(t.sent).toHaveLength(1);
      t.replies.trading = healthy('trading');
      await t.svc.checkAll();
      expect(t.sent).toHaveLength(2);
      expect(t.sent[1].key).toMatch(/^AGENT_RECOVERED:trading:/);
      await t.svc.checkAll();
      expect(t.sent).toHaveLength(2);
    });

    it('a success in between resets the streak (no alert, no recovery message)', async () => {
      const t = setup();
      t.replies.reading = new Error('timeout');
      await t.svc.checkAll();
      await t.svc.checkAll();
      t.replies.reading = healthy('reading');
      await t.svc.checkAll();
      t.replies.reading = new Error('timeout');
      await t.svc.checkAll();
      await t.svc.checkAll();
      expect(t.send).not.toHaveBeenCalled();
    });

    it('counts non-2xx and a different protocol version as failures', async () => {
      const t = setup();
      t.replies.background = { ok: false, status: 503 };
      t.replies.reading = { ok: true, status: 200, body: { group: 'reading', protocol: AGENT_PROTOCOL + 1, rssMb: 50, agents: {} } };
      for (let i = 0; i < AGENT_HEALTH_FAILS_TO_ALERT; i++) await t.svc.checkAll();
      const keys = t.sent.map((s) => s.key);
      expect(keys.some((k) => k.startsWith('AGENT_DOWN:background:'))).toBe(true);
      expect(keys.some((k) => k.startsWith('AGENT_DOWN:reading:'))).toBe(true);
      expect(t.sent.find((s) => s.key.startsWith('AGENT_DOWN:reading:'))!.text).toContain('protocol');
    });

    it('a second outage gets fresh keys (not swallowed by the ops-alert cooldown)', async () => {
      const t = setup();
      const cycle = async () => {
        t.replies.trading = new Error('down');
        for (let i = 0; i < AGENT_HEALTH_FAILS_TO_ALERT; i++) await t.svc.checkAll();
        t.replies.trading = healthy('trading');
        await t.svc.checkAll();
      };
      await cycle();
      await cycle();
      const keys = t.sent.map((s) => s.key);
      expect(keys).toHaveLength(4);
      expect(new Set(keys).size).toBe(4);
    });

    it('alerts outside market hours too (a dead agent is a dead agent)', async () => {
      const t = setup({ now: SUN_10_IST });
      t.replies.trading = new Error('down');
      for (let i = 0; i < AGENT_HEALTH_FAILS_TO_ALERT; i++) await t.svc.checkAll();
      expect(t.sent).toHaveLength(1);
    });

    it('a throwing send never breaks the check', async () => {
      const t = setup();
      t.send.mockImplementation(() => {
        throw new Error('telegram broke');
      });
      t.replies.trading = new Error('down');
      for (let i = 0; i < AGENT_HEALTH_FAILS_TO_ALERT + 1; i++) await expect(t.svc.checkAll()).resolves.toBeUndefined();
    });
  });

  describe('failed checks route the group in-process (review fix: health must move calls)', () => {
    it('the FIRST failed check marks the group down for the AgentProviders, and keeps it down while unhealthy', async () => {
      const t = setup();
      t.replies.trading = new Error('The operation was aborted due to timeout');
      await t.svc.checkAll();
      expect(t.links.isDown('trading', MON_10_IST)).toBe(true);
      expect(t.links.isDown('reading', MON_10_IST)).toBe(false);
      // Still down just before the next poll would run, and re-marked by it.
      expect(t.links.isDown('trading', MON_10_IST + AGENT_HEALTH_INTERVAL_MS + AGENT_HEALTH_TIMEOUT_MS)).toBe(true);
      t.advance(AGENT_HEALTH_INTERVAL_MS);
      await t.svc.checkAll();
      expect(t.links.isDown('trading', MON_10_IST + 2 * AGENT_HEALTH_INTERVAL_MS + AGENT_HEALTH_TIMEOUT_MS)).toBe(true);
    });

    it('a failed check cuts off calls already in flight to that group (markDead listeners fire)', async () => {
      const t = setup();
      const cut = jest.fn();
      t.links.onDead('trading', cut);
      t.replies.trading = new Error('stalled');
      await t.svc.checkAll();
      expect(cut).toHaveBeenCalledTimes(1);
    });

    it('a healthy check after failures clears the mark', async () => {
      const t = setup();
      t.replies.trading = new Error('stalled');
      await t.svc.checkAll();
      t.replies.trading = healthy('trading');
      await t.svc.checkAll();
      expect(t.links.isDown('trading', MON_10_IST)).toBe(false);
    });

    it('the DOWN alert says what actually happens', async () => {
      const t = setup();
      t.replies.trading = new Error('stalled');
      for (let i = 0; i < AGENT_HEALTH_FAILS_TO_ALERT; i++) await t.svc.checkAll();
      const down = t.sent.find((x) => x.key.startsWith('AGENT_DOWN:trading'));
      expect(down?.text).toContain('Since its first failed check');
      expect(down?.text).toContain('cut off and re-served in-process');
    });
  });

  describe('memory', () => {
    it(`warns once per IST day per group when rssMb > ${AGENT_RSS_WARN_MB}`, async () => {
      const t = setup();
      t.replies.reading = healthy('reading', AGENT_RSS_WARN_MB + 1);
      t.replies.trading = healthy('trading', AGENT_RSS_WARN_MB); // at the line: no warning
      await t.svc.checkAll();
      await t.svc.checkAll();
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0].key).toBe('AGENT_RSS:reading:2026-11-23');
      expect(t.sent[0].text).toContain(String(AGENT_RSS_WARN_MB + 1));
      t.advance(24 * 3_600_000);
      await t.svc.checkAll();
      expect(t.sent).toHaveLength(2);
      expect(t.sent[1].key).toBe('AGENT_RSS:reading:2026-11-24');
    });
  });

  describe('fallback events', () => {
    it('one alert per group per IST session during market hours', () => {
      const t = setup();
      t.svc.onModuleInit();
      t.events.emit('fallback', { group: 'trading', job: 'sentinel.judge', reason: 'ECONNREFUSED' });
      t.events.emit('fallback', { group: 'trading', job: 'entry.judge', reason: 'ECONNREFUSED' });
      t.events.emit('fallback', { group: 'reading', job: 'news.impact', reason: 'agent marked down' });
      expect(t.sent.map((s) => s.key)).toEqual(['AGENT_FALLBACK:trading:2026-11-23', 'AGENT_FALLBACK:reading:2026-11-23']);
      expect(t.sent[0].text).toContain('sentinel.judge');
      t.advance(24 * 3_600_000); // Tuesday 10:00 IST: a new session
      t.events.emit('fallback', { group: 'trading', job: 'sentinel.judge', reason: 'x' });
      expect(t.sent).toHaveLength(3);
      t.svc.onModuleDestroy();
      expect(t.events.listenerCount('fallback')).toBe(0);
    });

    it('no fallback alert outside market hours (weekend, or after the MCX close)', () => {
      const t = setup({ now: SUN_10_IST });
      t.svc.onModuleInit();
      t.events.emit('fallback', { group: 'trading', job: 'sentinel.judge', reason: 'x' });
      t.setNow(Date.parse('2026-11-23T18:30:00Z')); // Tue 00:00 IST
      t.events.emit('fallback', { group: 'trading', job: 'sentinel.judge', reason: 'x' });
      expect(t.send).not.toHaveBeenCalled();
      t.svc.onModuleDestroy();
    });
  });

  describe('quota events', () => {
    it('one alert per IST session', () => {
      const t = setup();
      t.svc.onModuleInit();
      t.events.emit('quota', { job: 'news.impact' });
      t.events.emit('quota', { job: 'signal.parse' });
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0].key).toBe('AGENT_QUOTA:2026-11-23');
      expect(t.sent[0].text).toContain('news.impact');
      t.advance(24 * 3_600_000);
      t.events.emit('quota', { job: 'news.impact' });
      expect(t.sent).toHaveLength(2);
      t.svc.onModuleDestroy();
    });
  });

  it('a malformed event payload never throws', () => {
    const t = setup();
    t.svc.onModuleInit();
    expect(() => t.events.emit('fallback', undefined)).not.toThrow();
    expect(() => t.events.emit('quota', null)).not.toThrow();
    t.svc.onModuleDestroy();
  });
});
