import { Logger } from '@nestjs/common';
import { ContextPacketService, type TickSnapshot } from './context-packet.service';
import { SentinelAgentService } from './sentinel-agent.service';
import {
  AUTHORITY_SECTION,
  AUTHORITY_VERSION_SUFFIX,
  sentinelPromptVersion,
  sentinelSystemPrompt,
} from '../prompts/sentinel-system-prompt';
import { THESIS_PROMPT_VERSION } from '../prompts/thesis-prompt';
import { alarmLookFire, leadAlarm, packetAlarm } from './alarm-look';
import type { AlarmRow } from '../../exit-authority/exit-authority.tokens';

/** Trade agent exit authority: the packet's alarm / brief and the +x1 "ALARMS AND BRIEF" prompt section. */
const T0 = new Date('2026-10-16T05:00:00.000Z');
const ENTRY = {
  exchange: 'NFO', userId: 'u1', trackerId: 't1', symbol: 'NIFTY28OCT2625000CE', kind: 'POSITION' as const,
  ownership: 'SENTINEL' as const, watched: true, reason: '',
};
const TICK = {
  segment: 'OPT', side: 'LONG', structureSymbol: 'NIFTY', entryPrice: 100, qty: 75, ltp: 120, underlyingLtp: 25100,
  underlyingLtpAt: null, underlyingLtpSource: 'hub', underlyingLtpReason: null,
  nearestSupport: null, nearestResistance: null, structureReason: null, structureAt: null, structureSource: 'level book',
  holdingHigh: 125, holdingLow: 98, entryTime: new Date('2026-10-16T04:00:00Z'), expiry: '2026-10-28', volumeRatio: null, freshNewsCount: 1,
  factorValues: {}, factorsReason: null, oiWallNow: null, oiWallPrev: null, oiWallsAt: null, greenFloorArmedLatched: false,
} as unknown as TickSnapshot;

const packets = () =>
  new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never,
    { levelsFor: jest.fn().mockResolvedValue(null) } as never,
    { recentFor: jest.fn().mockResolvedValue(null) } as never,
  );

const row = (over: Partial<AlarmRow> = {}): AlarmRow => ({
  id: 'a1', userId: 'u1', trackerId: 't1', symbol: 'X', rule: 'FLOOR', urgency: 'normal', reason: 'r', wouldHave: 'EXIT_NOW x',
  deadline: null, severityN: null, sourceRef: null, payload: {}, status: 'OPEN', raisedAt: new Date(1_000), lastRaisedAt: new Date(1_000),
  answeredAt: null, answerVerdictId: null, answer: null, alertedAt: null, alertCount: 0, telegramMessageId: null, snoozedUntil: null, ...over,
});

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(T0);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('packet: alarm and brief', () => {
  const alarm = { rule: 'HARD_LOSS' as const, reason: 'net ₹-2100 past ₹2000', urgency: 'urgent' as const, deadline: null, raisedAt: '2026-10-16T04:59:00.000Z' };

  it('carries alarm and brief exactly as the cycle passed them (JSON-safe)', async () => {
    const p = await packets().build(ENTRY as never, TICK, null, [], { authority: { alarm, brief: 'plan: hold to 25200' } });
    expect(p.alarm).toEqual(alarm);
    expect(p.brief).toBe('plan: hold to 25200');
    expect(JSON.parse(JSON.stringify(p)).alarm).toEqual(alarm);
  });

  it('null alarm / brief are present as null (the agent can see "none")', async () => {
    const p = await packets().build(ENTRY as never, TICK, null, [], { authority: { alarm: null, brief: null } });
    expect('alarm' in p && p.alarm === null).toBe(true);
    expect('brief' in p && p.brief === null).toBe(true);
  });

  it('off: neither key (byte-identical packets)', async () => {
    const svc = packets();
    for (const p of [await svc.build(ENTRY as never, TICK, null), await svc.build(ENTRY as never, TICK, null, [], {})]) {
      expect('alarm' in p).toBe(false);
      expect('brief' in p).toBe(false);
    }
  });

  it('packetAlarm: ISO times, the latest raise', () => {
    expect(packetAlarm(row({ urgency: 'deadline', deadline: new Date(9_000), lastRaisedAt: new Date(5_000) }))).toEqual({
      rule: 'FLOOR', reason: 'r', urgency: 'deadline', deadline: new Date(9_000).toISOString(), raisedAt: new Date(5_000).toISOString(),
    });
  });

  it('leadAlarm: urgent first, then the newest; ignores answered and live snoozes', () => {
    const now = 10_000;
    expect(leadAlarm([row({ id: 'n' }), row({ id: 'u', urgency: 'urgent' })], now)?.id).toBe('u');
    expect(leadAlarm([row({ id: 'old' }), row({ id: 'new', lastRaisedAt: new Date(2_000) })], now)?.id).toBe('new');
    expect(leadAlarm([row({ status: 'ANSWERED' }), row({ status: 'SNOOZED', snoozedUntil: new Date(20_000) })], now)).toBeNull();
    expect(leadAlarm([row({ id: 's', status: 'SNOOZED', snoozedUntil: new Date(5_000) })], now)?.id).toBe('s');
  });

  it('alarmLookFire: owed only after the agent\'s last verdict and TRACKER_WAKE_MIN_GAP_MS apart', () => {
    expect(alarmLookFire(row(), null, null, 10_000)).toMatchObject({ name: 'alarm', kind: 'alarm', alarmId: 'a1', rule: 'FLOOR' });
    expect(alarmLookFire(row(), 1_000, null, 10_000)).toBeNull();
    expect(alarmLookFire(row(), null, 0, 10_000)).toBeNull();
    expect(alarmLookFire(row(), null, 0, 20_000)).not.toBeNull();
  });
});

describe('prompt: ALARMS AND BRIEF (+x1)', () => {
  const base = { cues: false, triggers: false, discipline: true, lessons: true, delta: true, equity: true, squareOff: true, anchors: true };

  it('authority on: the section is appended, nothing else changes, and the stamp gains +x1', () => {
    const on = sentinelSystemPrompt({ ...base, authority: true });
    expect(on).toContain('ALARMS AND BRIEF:');
    expect(on).toContain('Verify it on alarm.chart');
    expect(on).toContain('HOLD, TIGHTEN (EXIT_ARMED');
    expect(on).toContain('EXIT_NOW. Your reason must address the alarm directly');
    expect(on).toContain("brief, when not null, is the supreme agent's plan and skills for this trade");
    expect(on).toBe(`${sentinelSystemPrompt(base)}${AUTHORITY_SECTION}`);
    expect(sentinelPromptVersion({ ...base, authority: true })).toBe(`${sentinelPromptVersion(base)}${AUTHORITY_VERSION_SUFFIX}`);
  });

  it('authority off / absent: byte-identical text and stamp', () => {
    expect(sentinelSystemPrompt({ ...base, authority: false })).toBe(sentinelSystemPrompt(base));
    expect(sentinelSystemPrompt(base)).not.toContain('ALARMS AND BRIEF');
    expect(sentinelPromptVersion({ ...base, authority: false })).toBe(sentinelPromptVersion(base));
  });

  const junk = () => jest.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] });
  const agentWith = (authority?: { isLive: () => boolean }) => {
    const create = junk();
    return { create, agent: new SentinelAgentService({ messages: { create } } as never, { get: () => undefined } as never, authority) };
  };
  /** The system text the agent sent for `packet` (the reply is junk; only the request matters). */
  const systemFor = async (a: ReturnType<typeof agentWith>, packet: object) => {
    a.create.mockClear();
    await a.agent.judge(packet as never).catch(() => undefined);
    return a.create.mock.calls[0][0].system[0].text as string;
  };
  const livePacket = { position: {}, money: {}, alarm: null, brief: 'plan' };
  const paperPacket = { position: {}, money: {} };

  it('the agent renders it only for a live packet (alarm / brief keys) while AUTHORITY_STATE is live — read per call', async () => {
    const live = { isLive: jest.fn(() => false) };
    const a = agentWith(live);
    const base = agentWith().agent.promptVersion;
    const plus = `${base.replace(`/${THESIS_PROMPT_VERSION}`, '')}${AUTHORITY_VERSION_SUFFIX}/${THESIS_PROMPT_VERSION}`;
    expect(a.agent.promptVersionFor(livePacket as never)).toBe(base);
    expect(await systemFor(a, livePacket)).not.toContain('ALARMS AND BRIEF');
    live.isLive.mockReturnValue(true);
    expect(a.agent.promptVersionFor(livePacket as never)).toBe(plus);
    expect(await systemFor(a, livePacket)).toContain('ALARMS AND BRIEF');
    // The process-wide stamp never carries +x1 (it has no packet to judge by).
    expect(a.agent.promptVersion).toBe(base);
  });

  it('a PAPER judgement under live (no alarm / brief keys): no section, the original stamp and text', async () => {
    const a = agentWith({ isLive: () => true });
    const off = agentWith();
    expect(a.agent.promptVersionFor(paperPacket as never)).toBe(off.agent.promptVersion);
    const text = await systemFor(a, paperPacket);
    expect(text).not.toContain('ALARMS AND BRIEF');
    expect(text).toBe(await systemFor(off, paperPacket));
  });

  it('the section names only fields the packet has, and says what to do when the chart is unavailable', () => {
    expect(AUTHORITY_SECTION).toContain('If alarm.chart is unavailable (alarm.chart.unavailable says why), say so in the reason and judge on what the packet has');
    for (const f of ['closes5', 'closes15', 'vwap', 'n15', 'supertrend15', 'supertrendLine15', 'adverseFromBest', 'needPts', 'known', 'against', 'reasons']) {
      expect(AUTHORITY_SECTION).toContain(f);
    }
    expect(AUTHORITY_SECTION).not.toMatch(/money and its anchors|readChart/);
  });
});
