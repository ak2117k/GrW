import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { buildVocabulary } from '../../signal-intake/domain/vocabulary';
import { SIGNAL_READY_EVENT, SIGNAL_VISION_DONE_EVENT, TELEGRAM_MESSAGE_EVENT } from '../../signal-intake/domain/types';
import type { ReaderReply } from '../domain/reading.types';
import { parseMessageReaderConfig } from '../message-reader.config';
import type { CachedReading, ReadingWrite, RuleClass } from '../repositories/message-reader.repository';
import type { ReaderInput } from './message-reader-llm.service';
import type { ReaderPacket } from './reader-packet.service';
import { MessageReaderService, READER_READING_STORED_EVENT } from './message-reader.service';
import { __resetOpsAlerts, sendOpsAlert } from '../../../common/utils/ops-alert';

const NOW = new Date('2026-11-25T04:01:00Z'); // 09:31 IST
const vocab = buildVocabulary(['RELIANCE-EQ']);

const INFO: ReaderReply = {
  kind: 'INFO',
  scope: 'MARKET',
  claims: [{ text: 'stocks weak, index strong', subject: 'MARKET', bias: 'CAUTION', horizon: 'INTRADAY', claimType: 'RELATIVE_BREADTH', verdict: 'CONFIRMED', evidence: [{ fact: 'A/D', value: '0.6', source: 'breadth' }] }],
  call: null,
  summary: 'stay cautious',
};
const CALL: ReaderReply = {
  kind: 'CALL',
  scope: 'INSTRUMENT',
  claims: [],
  call: { underlying: ' nifty ', side: 'BUY', optionType: 'CE', strike: 24000, entryLow: 120, entryHigh: 120, stopLoss: 100, targets: [140, 160] },
  summary: 'buy nifty 24000 ce',
};

type Fakes = {
  mode?: 'off' | 'shadow' | 'on';
  agents?: boolean;
  read?: (i: ReaderInput) => Promise<{ reply: ReaderReply; ms: number; model: string }>;
  rule?: RuleClass | null;
  alert?: (key: string, text: string) => Promise<boolean>;
  env?: Record<string, string>;
  events?: { emit: (event: string, payload: unknown) => boolean };
};

function make(o: Fakes = {}) {
  const rule = { current: o.rule ?? null };
  const rows = new Map<string, ReadingWrite>();
  const upserts: ReadingWrite[] = [];
  const repo = {
    upsertReading: jest.fn(async (r: ReadingWrite) => {
      upserts.push(r);
      rows.set(r.messageId, r);
    }),
    readingOf: jest.fn(async (id: string) => {
      const r = rows.get(id);
      return r ? { status: r.status, textHash: r.textHash } : null;
    }),
    cachedByHash: jest.fn(async (hash: string, since: Date, exclude?: string): Promise<CachedReading | null> => {
      const hit = [...rows.values()].reverse().find((r) => r.textHash === hash && r.status === 'READ' && r.readAt >= since && r.messageId !== exclude);
      return hit ? { messageId: hit.messageId, kind: hit.kind!, scope: hit.scope!, claims: hit.claims, call: hit.call ?? null, summary: hit.summary ?? null, model: hit.model ?? null } : null;
    }),
    ruleClassOf: jest.fn(async () => rule.current),
    updateRuleComparison: jest.fn(async (id: string, hash: string, c: { parseAgrees: boolean | null; missedByRules: boolean; ruleStatus: string | null }) => {
      const r = rows.get(id);
      if (r && r.textHash === hash) rows.set(id, { ...r, ...c });
    }),
    channelTitle: jest.fn(async () => 'Stock Gainers (SEBI Registered)'),
  };
  const packet = { build: jest.fn(async () => ({ packet: { at: NOW.toISOString() } as unknown as ReaderPacket, ms: 7 })) };
  const llm = { read: jest.fn(o.read ?? (async () => ({ reply: INFO, ms: 900, model: 'claude-sonnet-5' }))) };
  let now = NOW;
  const cfg = parseMessageReaderConfig({ MESSAGE_READER: o.mode ?? 'shadow', ...(o.env ?? {}) });
  const alert = jest.fn(o.alert ?? (async () => true));
  const svc = new MessageReaderService(repo, packet, llm, { get: async () => vocab }, cfg, () => now, () => o.agents ?? true, alert, o.events);
  const post = (id: string, text: string, agoMin = 1, extra: Record<string, unknown> = {}) => ({
    messageId: id, channelId: 'ch1', text, postedAt: new Date(NOW.getTime() - agoMin * 60_000), hasMedia: false, ...extra,
  });
  return { svc, repo, packet, llm, alert, rows, upserts, post, rule, setNow: (d: Date) => (now = d) };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('MessageReaderService', () => {
  // Failure paths log a warning by design; keep the test output clean.
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('reads a burst of 10 with at most 8 in flight', async () => {
    let inFlight = 0;
    let max = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = make({
      read: async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await gate;
        inFlight--;
        return { reply: INFO, ms: 900, model: 'claude-sonnet-5' };
      },
    });
    for (let i = 0; i < 10; i++) m.svc.onTelegramMessage(m.post(`m${i}`, `post number ${i}`));
    for (let i = 0; i < 10; i++) await tick();
    expect(m.llm.read).toHaveBeenCalledTimes(8);
    release();
    await m.svc.whenIdle();
    expect(max).toBe(8);
    expect(m.llm.read).toHaveBeenCalledTimes(10);
    expect([...m.rows.values()].map((r) => r.status)).toEqual(Array(10).fill('READ'));
  });

  it('MESSAGE_READER_MAX_IN_FLIGHT caps the reads in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = make({ env: { MESSAGE_READER_MAX_IN_FLIGHT: '3' }, read: async () => (await gate, { reply: INFO, ms: 900, model: 'claude-sonnet-5' }) });
    for (let i = 0; i < 5; i++) m.svc.onTelegramMessage(m.post(`m${i}`, `post number ${i}`));
    for (let i = 0; i < 10; i++) await tick();
    expect(m.llm.read).toHaveBeenCalledTimes(3);
    release();
    await m.svc.whenIdle();
    expect(m.llm.read).toHaveBeenCalledTimes(5);
  });

  it('the same messageId twice while queued is read once', async () => {
    const m = make();
    m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
    m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
    await m.svc.whenIdle();
    expect(m.llm.read).toHaveBeenCalledTimes(1);
    expect(m.repo.upsertReading).toHaveBeenCalledTimes(1);
  });

  it('re-reads an edited post into the same row', async () => {
    const m = make();
    m.llm.read
      .mockImplementationOnce(async () => ({ reply: INFO, ms: 900, model: 'claude-sonnet-5' }))
      .mockImplementationOnce(async () => ({ reply: { ...INFO, summary: 'edited: be careful' }, ms: 900, model: 'claude-sonnet-5' }));
    m.svc.onTelegramMessage(m.post('m1', 'Stay cautious'));
    await m.svc.whenIdle();
    m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, edited', 1, { edited: true }));
    await m.svc.whenIdle();
    expect(m.upserts.map((u) => u.messageId)).toEqual(['m1', 'm1']);
    expect(m.upserts[1]).toMatchObject({ status: 'READ', summary: 'edited: be careful' });
  });

  it('an edit that arrives while the post is being read is read after it', async () => {
    const m = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    m.llm.read
      .mockImplementationOnce(async () => {
        await gate;
        return { reply: INFO, ms: 900, model: 'claude-sonnet-5' };
      })
      .mockImplementationOnce(async () => ({ reply: { ...INFO, summary: 'second' }, ms: 900, model: 'claude-sonnet-5' }));
    m.svc.onTelegramMessage(m.post('m1', 'first text'));
    for (let i = 0; i < 5; i++) await tick();
    m.svc.onTelegramMessage(m.post('m1', 'second text', 1, { edited: true }));
    release();
    await m.svc.whenIdle();
    expect(m.llm.read).toHaveBeenCalledTimes(2);
    expect(m.rows.get('m1')).toMatchObject({ summary: 'second' });
  });

  it('a post older than 30 min at dequeue is STALE and not read', async () => {
    const m = make();
    m.svc.onTelegramMessage(m.post('m1', 'Nifty looks strong', 31));
    await m.svc.whenIdle();
    expect(m.llm.read).not.toHaveBeenCalled();
    expect(m.rows.get('m1')).toMatchObject({ status: 'STALE', claims: [] });
  });

  it('a forwarded duplicate within 15 min is CACHED, no AI call', async () => {
    const m = make();
    m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
    await m.svc.whenIdle();
    m.svc.onTelegramMessage({ ...m.post('m2', '  Stay cautious, only index showing strength  '), channelId: 'ch2' });
    await m.svc.whenIdle();
    expect(m.llm.read).toHaveBeenCalledTimes(1);
    expect(m.rows.get('m2')).toMatchObject({ status: 'CACHED', channelId: 'ch2', summary: 'stay cautious', claims: INFO.claims });
  });

  it('an AI failure stores FAILED and retries once while fresh', async () => {
    const m = make();
    m.llm.read.mockImplementationOnce(async () => {
      throw new Error('message reader timed out after 25000 ms');
    });
    m.svc.onTelegramMessage(m.post('m1', 'Stay cautious', 1));
    await m.svc.whenIdle();
    expect(m.llm.read).toHaveBeenCalledTimes(2);
    expect(m.upserts.map((u) => u.status)).toEqual(['FAILED', 'READ']);
    expect(m.upserts[0]).toMatchObject({ claims: [], error: expect.stringContaining('timed out') });
  });

  it('does not retry a post older than 5 min', async () => {
    const m = make({
      read: async () => {
        throw new Error('busy');
      },
    });
    m.svc.onTelegramMessage(m.post('m1', 'Stay cautious', 6));
    await m.svc.whenIdle();
    expect(m.llm.read).toHaveBeenCalledTimes(1);
    expect(m.upserts.map((u) => u.status)).toEqual(['FAILED']);
  });

  it('a CALL the rules dropped as NOISE is missedByRules', async () => {
    const m = make({ read: async () => ({ reply: CALL, ms: 900, model: 'claude-sonnet-5' }), rule: { status: 'NOISE', signal: null } });
    m.svc.onTelegramMessage(m.post('m1', 'nifty 24000 ce buy now 120 sl 100'));
    await m.svc.whenIdle();
    expect(m.rows.get('m1')).toMatchObject({ status: 'READ', kind: 'CALL', missedByRules: true, parseAgrees: null });
  });

  it('a CALL matching the rule parse has parseAgrees true (underlying stored trimmed + uppercase)', async () => {
    const rule: RuleClass = {
      status: 'SIGNAL',
      signal: { underlying: 'NIFTY', side: 'BUY', optionType: 'CE', strike: 24000, entryLow: 120, entryHigh: 120, stopLoss: 100, targets: [140, 160] },
    };
    const m = make({ read: async () => ({ reply: CALL, ms: 900, model: 'claude-sonnet-5' }), rule });
    m.svc.onTelegramMessage(m.post('m1', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160'));
    await m.svc.whenIdle();
    expect(m.rows.get('m1')).toMatchObject({ status: 'READ', parseAgrees: true, missedByRules: false, call: expect.objectContaining({ underlying: 'NIFTY' }) });
  });

  it('passes the named underlyings, channel title and IST time to the packet and the AI; stores latencies', async () => {
    const m = make();
    m.svc.onTelegramMessage(m.post('m1', 'Reliance looking weak below 1400', 1));
    await m.svc.whenIdle();
    expect(m.packet.build).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'ch1', underlyings: ['RELIANCE'] }));
    expect(m.llm.read).toHaveBeenCalledWith(expect.objectContaining({ channelTitle: 'Stock Gainers (SEBI Registered)', postedAtIst: '2026-11-25 09:30 IST' }));
    expect(m.rows.get('m1')).toMatchObject({ status: 'READ', packetMs: 7, aiMs: 900, model: 'claude-sonnet-5', queuedMs: 0 });
  });

  it('image posts are read only after vision done', async () => {
    const m = make();
    const media = { kind: 'photo', path: '/x.jpg', sha256: 'a'.repeat(64), mimeType: 'image/jpeg', bytes: 1 };
    m.svc.onTelegramMessage(m.post('m1', 'Crude chart', 1, { hasMedia: true, media }));
    await m.svc.whenIdle();
    expect(m.llm.read).not.toHaveBeenCalled();
    const reading = { kind: 'INFO', isSignal: false, signals: [], imageSha256: 'a'.repeat(64) };
    m.svc.onVisionDone({ messageId: 'm1', channelId: 'ch1', postedAt: new Date(NOW.getTime() - 60_000), text: 'Crude chart', reading });
    await m.svc.whenIdle();
    expect(m.llm.read).toHaveBeenCalledWith(expect.objectContaining({ text: 'Crude chart', imageReading: reading }));
    expect(m.rows.get('m1')).toMatchObject({ status: 'READ' });
  });

  it('off mode reads nothing', async () => {
    const m = make({ mode: 'off' });
    m.svc.onTelegramMessage(m.post('m1', 'Stay cautious'));
    m.svc.onVisionDone({ messageId: 'm2', channelId: 'ch1', postedAt: NOW, text: '', reading: {} });
    await m.svc.whenIdle();
    expect(m.llm.read).not.toHaveBeenCalled();
    expect(m.repo.upsertReading).not.toHaveBeenCalled();
  });

  it('agents off reads nothing', async () => {
    const m = make({ agents: false });
    m.svc.onTelegramMessage(m.post('m1', 'Stay cautious'));
    m.svc.onVisionDone({ messageId: 'm2', channelId: 'ch1', postedAt: NOW, text: '', reading: {} });
    await m.svc.whenIdle();
    expect(m.llm.read).not.toHaveBeenCalled();
    expect(m.repo.upsertReading).not.toHaveBeenCalled();
  });

  it('never emits signal.ready', async () => {
    const m = make({ read: async () => ({ reply: CALL, ms: 900, model: 'claude-sonnet-5' }), rule: { status: 'NOISE', signal: null } });
    const ee = new EventEmitter2();
    const seen: string[] = [];
    ee.onAny((e) => void seen.push(String(e)));
    ee.on(TELEGRAM_MESSAGE_EVENT, (e) => m.svc.onTelegramMessage(e));
    ee.on(SIGNAL_VISION_DONE_EVENT, (e) => m.svc.onVisionDone(e));
    ee.emit(TELEGRAM_MESSAGE_EVENT, m.post('m1', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    await m.svc.whenIdle();
    expect(m.rows.get('m1')).toMatchObject({ kind: 'CALL' });
    expect(seen).toEqual([TELEGRAM_MESSAGE_EVENT]);
    expect(seen).not.toContain(SIGNAL_READY_EVENT);
  });

  describe('rule comparison while the rules have not decided (ruleStatus PENDING + re-checks)', () => {
    const SIGNAL_RULE: RuleClass = {
      status: 'SIGNAL',
      signal: { underlying: 'NIFTY', side: 'BUY', optionType: 'CE', strike: 24000, entryLow: 120, entryHigh: 120, stopLoss: 100, targets: [140, 160] },
    };
    const callRead = async () => ({ reply: CALL, ms: 900, model: 'claude-sonnet-5' });

    beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }));
    afterEach(() => jest.useRealTimers());

    it('class absent at read time, SIGNAL at +60 s → the row gets parseAgrees and the rule status', async () => {
      const m = make({ read: callRead, rule: null });
      m.svc.onTelegramMessage(m.post('m1', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160'));
      await m.svc.whenIdle();
      expect(m.rows.get('m1')).toMatchObject({ status: 'READ', ruleStatus: 'PENDING', parseAgrees: null, missedByRules: false });
      m.rule.current = SIGNAL_RULE;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(m.repo.updateRuleComparison).toHaveBeenCalledTimes(1);
      expect(m.rows.get('m1')).toMatchObject({ ruleStatus: 'SIGNAL', parseAgrees: true, missedByRules: false });
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(m.repo.ruleClassOf).toHaveBeenCalledTimes(2); // the +5 min check was cancelled
    });

    it('LLM_PENDING at both re-checks → ruleStatus stays PENDING (visible), nothing more scheduled', async () => {
      const m = make({ read: callRead, rule: { status: 'LLM_PENDING', signal: null } });
      m.svc.onTelegramMessage(m.post('m1', 'nifty 24000 ce buy now 120 sl 100'));
      await m.svc.whenIdle();
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(m.repo.ruleClassOf).toHaveBeenCalledTimes(3);
      expect(m.repo.updateRuleComparison).not.toHaveBeenCalled();
      expect(m.rows.get('m1')).toMatchObject({ ruleStatus: 'PENDING', parseAgrees: null, missedByRules: false });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('LLM_PENDING then NOISE at +5 min → missedByRules', async () => {
      const m = make({ read: callRead, rule: { status: 'LLM_PENDING', signal: null } });
      m.svc.onTelegramMessage(m.post('m1', 'nifty 24000 ce buy now 120 sl 100'));
      await m.svc.whenIdle();
      await jest.advanceTimersByTimeAsync(60_000);
      m.rule.current = { status: 'NOISE', signal: null };
      await jest.advanceTimersByTimeAsync(4 * 60_000);
      expect(m.rows.get('m1')).toMatchObject({ ruleStatus: 'NOISE', missedByRules: true });
    });

    it('a final class at read time → stored with its status, no re-check scheduled', async () => {
      const m = make({ read: callRead, rule: SIGNAL_RULE });
      m.svc.onTelegramMessage(m.post('m1', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160'));
      await m.svc.whenIdle();
      expect(m.rows.get('m1')).toMatchObject({ ruleStatus: 'SIGNAL', parseAgrees: true });
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(m.repo.ruleClassOf).toHaveBeenCalledTimes(1);
    });

    it('a non-call reading is not compared (ruleStatus null, no re-check)', async () => {
      const m = make({ rule: null });
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious'));
      await m.svc.whenIdle();
      expect(m.rows.get('m1')).toMatchObject({ ruleStatus: null });
      expect(m.repo.ruleClassOf).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('module destroy clears pending re-checks', async () => {
      const m = make({ read: callRead, rule: null });
      m.svc.onTelegramMessage(m.post('m1', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160'));
      await m.svc.whenIdle();
      expect(jest.getTimerCount()).toBe(2);
      m.svc.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('image posts whose image was not read (vision.done with reading null)', () => {
    it.each([
      ['the caption is a call; the image was not sent'],
      ['daily vision cap 120 reached'],
    ])('reads the caption with the reason (%s)', async (reason) => {
      const m = make();
      m.svc.onVisionDone({ messageId: 'm1', channelId: 'ch1', postedAt: new Date(NOW.getTime() - 60_000), text: 'Crude looks weak below 5600', reading: null, skipped: reason });
      await m.svc.whenIdle();
      expect(m.llm.read).toHaveBeenCalledTimes(1);
      const input = m.llm.read.mock.calls[0][0];
      expect(input).toMatchObject({ text: 'Crude looks weak below 5600', imageSkipped: reason });
      expect(input).not.toHaveProperty('imageReading');
      expect(m.rows.get('m1')).toMatchObject({ status: 'READ' });
    });

    it('empty caption + skipped → no AI call, no row', async () => {
      const m = make();
      m.svc.onVisionDone({ messageId: 'm1', channelId: 'ch1', postedAt: NOW, text: '   ', reading: null, skipped: 'image not read: SIGNAL_VISION=off' });
      await m.svc.whenIdle();
      expect(m.llm.read).not.toHaveBeenCalled();
      expect(m.repo.upsertReading).not.toHaveBeenCalled();
    });

    it('a caption read without its image is not served from a text post’s cache', async () => {
      const m = make();
      m.svc.onTelegramMessage(m.post('m1', 'Crude looks weak below 5600'));
      await m.svc.whenIdle();
      m.svc.onVisionDone({ messageId: 'm2', channelId: 'ch1', postedAt: new Date(NOW.getTime() - 60_000), text: 'Crude looks weak below 5600', reading: null, skipped: 'daily vision cap 120 reached' });
      await m.svc.whenIdle();
      expect(m.llm.read).toHaveBeenCalledTimes(2);
      expect(m.rows.get('m2')).toMatchObject({ status: 'READ' });
    });
  });

  describe('owner market-note alert', () => {
    const BEAR: ReaderReply = {
      ...INFO,
      claims: [
        INFO.claims[0],
        { text: 'weak day ahead', subject: 'MARKET', bias: 'BEAR', horizon: 'INTRADAY', claimType: 'DIRECTION', verdict: 'UNCLEAR', evidence: [] },
      ],
    };

    it('sends a market note alert in on mode', async () => {
      const m = make({ mode: 'on', read: async () => ({ reply: BEAR, ms: 900, model: 'claude-sonnet-5' }) });
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
      await m.svc.whenIdle();
      await tick();
      expect(m.alert).toHaveBeenCalledTimes(1);
      expect(m.alert).toHaveBeenCalledWith('market-note:ch1', 'Stock Gainers (SEBI Registered) 09:30 — stocks weak, index strong → CONFIRMED (A/D 0.6)');
    });

    it('no market note alert in shadow mode', async () => {
      const m = make({ mode: 'shadow' });
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
      await m.svc.whenIdle();
      await tick();
      expect(m.rows.get('m1')).toMatchObject({ status: 'READ' });
      expect(m.alert).not.toHaveBeenCalled();
    });

    it('no alert for an UNCLEAR claim', async () => {
      const unclear: ReaderReply = { ...INFO, claims: [{ ...INFO.claims[0], verdict: 'UNCLEAR', evidence: [] }] };
      const m = make({ mode: 'on', read: async () => ({ reply: unclear, ms: 900, model: 'claude-sonnet-5' }) });
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious'));
      await m.svc.whenIdle();
      await tick();
      expect(m.alert).not.toHaveBeenCalled();
    });

    it('no alert for a CACHED copy (only a fresh READ alerts)', async () => {
      const m = make({ mode: 'on' });
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
      await m.svc.whenIdle();
      m.svc.onTelegramMessage({ ...m.post('m2', 'Stay cautious, only index showing strength'), channelId: 'ch2' });
      await m.svc.whenIdle();
      await tick();
      expect(m.rows.get('m2')).toMatchObject({ status: 'CACHED' });
      expect(m.alert).toHaveBeenCalledTimes(1);
      expect(m.alert).toHaveBeenCalledWith('market-note:ch1', expect.any(String));
    });

    it('an alert that throws leaves the row READ and makes no second AI call', async () => {
      const throwing = [
        async () => {
          throw new Error('telegram down');
        },
        () => {
          throw new Error('sync boom');
        },
      ];
      for (const alert of throwing) {
        const m = make({ mode: 'on', alert: alert as (k: string, t: string) => Promise<boolean> });
        m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
        await m.svc.whenIdle();
        await tick();
        expect(m.alert).toHaveBeenCalledTimes(1);
        expect(m.llm.read).toHaveBeenCalledTimes(1);
        expect(m.upserts.map((u) => u.status)).toEqual(['READ']);
      }
      // The alert step itself throwing synchronously (malformed claims) does not touch the stored row either.
      const bad = { ...INFO, claims: null } as unknown as ReaderReply;
      const m = make({ mode: 'on', read: async () => ({ reply: bad, ms: 900, model: 'claude-sonnet-5' }) });
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
      await m.svc.whenIdle();
      await tick();
      expect(m.llm.read).toHaveBeenCalledTimes(1);
      expect(m.upserts.map((u) => u.status)).toEqual(['READ']);
    });

    it('a second confirmed claim from the same channel within 30 min does not send (ops-alert cooldown)', async () => {
      __resetOpsAlerts();
      const fetch = jest.fn(async () => ({ ok: true, status: 200 }));
      let clock = NOW.getTime();
      const real = (k: string, t: string) =>
        sendOpsAlert(k, t, { env: { TELEGRAM_ALERT_BOT_TOKEN: 't', TELEGRAM_ALERT_CHAT_ID: 'c' }, fetch, now: () => clock });
      const m = make({ mode: 'on', alert: real });
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
      await m.svc.whenIdle();
      await tick();
      clock += 29 * 60_000;
      m.svc.onTelegramMessage(m.post('m2', 'Breadth is poor, careful with longs'));
      await m.svc.whenIdle();
      await tick();
      m.svc.onTelegramMessage({ ...m.post('m3', 'Market weak, index propped up'), channelId: 'ch2' });
      await m.svc.whenIdle();
      await tick();
      expect(m.alert).toHaveBeenCalledTimes(3);
      expect(fetch).toHaveBeenCalledTimes(2); // ch1 once (the second within 30 min is held back), ch2 once
      __resetOpsAlerts();
    });
  });

  describe('reader.reading.stored (the AI setups hook)', () => {
    it('emits once after a READ row is stored, with the reading and the post text', async () => {
      const emit = jest.fn(() => true);
      const m = make({ events: { emit } });
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
      await m.svc.whenIdle();
      expect(READER_READING_STORED_EVENT).toBe('reader.reading.stored');
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(READER_READING_STORED_EVENT, {
        messageId: 'm1',
        channelId: 'ch1',
        postedAt: new Date(NOW.getTime() - 60_000),
        readAt: NOW,
        status: 'READ',
        kind: 'INFO',
        scope: 'MARKET',
        claims: INFO.claims,
        summary: 'stay cautious',
        postText: 'Stay cautious, only index showing strength',
      });
    });

    it('no emit for FAILED, STALE or CACHED rows', async () => {
      const emit = jest.fn(() => true);
      const m = make({ events: { emit }, read: async () => Promise.reject(new Error('boom')) });
      m.svc.onTelegramMessage(m.post('f1', 'a post that fails', 10));
      m.svc.onTelegramMessage(m.post('s1', 'an old post', 45));
      await m.svc.whenIdle();
      expect(m.rows.get('f1')).toMatchObject({ status: 'FAILED' });
      expect(m.rows.get('s1')).toMatchObject({ status: 'STALE' });
      expect(emit).not.toHaveBeenCalled();
      m.llm.read.mockImplementation(async () => ({ reply: INFO, ms: 900, model: 'claude-sonnet-5' }));
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
      await m.svc.whenIdle();
      m.svc.onTelegramMessage({ ...m.post('m2', 'Stay cautious, only index showing strength'), channelId: 'ch2' });
      await m.svc.whenIdle();
      expect(m.rows.get('m2')).toMatchObject({ status: 'CACHED' });
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('an emitter that throws leaves the READ row as stored and makes no second AI call', async () => {
      const emit = jest.fn((): boolean => {
        throw new Error('listener boom');
      });
      const m = make({ events: { emit } });
      m.svc.onTelegramMessage(m.post('m1', 'Stay cautious, only index showing strength'));
      await m.svc.whenIdle();
      expect(emit).toHaveBeenCalledTimes(1);
      expect(m.llm.read).toHaveBeenCalledTimes(1);
      expect(m.upserts.map((u) => u.status)).toEqual(['READ']);
    });
  });
});
