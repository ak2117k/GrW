import { Logger } from '@nestjs/common';
import type { Claim } from '../../message-reader/domain/reading.types';
import type { ReadingStoredEvent } from '../../message-reader/services/message-reader.service';
import { parseAiSetupsConfig } from '../ai-setups.config';
import { SETUP_PROMPT_VERSION } from '../domain/setup-prompt';
import type { SetupPlan, SetupReply } from '../domain/setup.types';
import type { AiSetupWrite } from '../repositories/ai-setups.repository';
import { AiSetupsService, setupCandidates } from './ai-setups.service';
import type { SetupPacket } from './setup-packet.service';

const NOW = new Date('2026-11-25T08:48:00Z'); // 14:18 IST
const MIN = 60_000;

const DABUR_CLAIM: Claim = {
  text: 'Dabur breakout',
  subject: 'DABUR',
  bias: 'BULL',
  horizon: 'INTRADAY',
  claimType: 'DIRECTION',
  verdict: 'CONFIRMED',
  evidence: [{ fact: 'ltp above 60d high', value: '431.3', source: 'instruments.DABUR.quote' }],
};

const claimOn = (subject: string, over: Partial<Claim> = {}): Claim => ({ ...DABUR_CLAIM, subject, text: `${subject} breakout`, ...over });

const event = (over: Partial<ReadingStoredEvent> = {}): ReadingStoredEvent => ({
  messageId: 'msg-1',
  channelId: 'ch-sg',
  postedAt: new Date(NOW.getTime() - 2 * MIN),
  readAt: new Date(NOW.getTime() - MIN),
  status: 'READ',
  kind: 'INFO',
  scope: 'INSTRUMENT',
  claims: [DABUR_CLAIM],
  summary: 'Dabur breakout, confirmed at 431.3',
  postText: 'Dabur breakout 🚀',
  ...over,
});

/** The DABUR packet in SetupPacket's shape: LTP 431.3, ATR15m 3, Dec 430 CE delta 0.5 / spread 1.2 % / OI 1480, lot 500. */
function packetFor(u: string, over: Partial<Record<'quote' | 'bars15m' | 'chain', unknown>> = {}, ce: Record<string, unknown> = {}): SetupPacket {
  return {
    at: NOW.toISOString(),
    underlying: u,
    optionExchange: 'NFO',
    claim: { subject: u, bias: 'BULL', horizon: 'INTRADAY', claimType: 'DIRECTION', verdict: 'CONFIRMED' },
    rules: { optionBuysOnly: true, minRewardRisk: 1.2, antiChaseAtr15m: 1.5, maxSpreadPct: 2, minOi: 500, maxSetupsPerDay: 3 },
    quote: { status: 'present', source: 'q', value: { exchange: 'NSE', ltp: 431.3, open: 405.2, dayHigh: 433.6, dayLow: 404.8, volume: 8_400_000 } },
    daily60: { status: 'present', source: 'd', value: { high60d: 403, prevClose: 399.4 } },
    bars15m: { status: 'present', source: 'b', value: { atr15m: 3, vwap: 424.8, bars: [] } },
    chain: {
      status: 'present',
      source: 'c',
      value: {
        expiry: '2026-12-29',
        exchange: 'NFO',
        lotSize: 500,
        rows: [{ strike: 430, ce: { ltp: 9.8, oi: 1480, volume: 900, bid: 9.75, ask: 9.87, spreadPct: 1.2, delta: 0.5, iv: 22, ...ce }, pe: null }],
      },
    },
    news60m: { status: 'present', source: 'n', value: { count: 0, headlines: [] } },
    channelRecord: { status: 'unavailable', source: 'r', reason: 'no record' },
    deskToday: { status: 'present', source: 'k', value: { setupsToday: 0, openTrades: [] } },
    timeToClose: { status: 'present', source: 't', value: { nowIst: '14:18', lastValidIst: '15:15', minutesLeft: 57 } },
    ...over,
  } as SetupPacket;
}

const DABUR_PLAN: SetupPlan = {
  instrument: { kind: 'OPT', symbol: 'DABUR', strike: 430, optionType: 'CE', expiry: '2026-12-29' },
  side: 'BUY',
  entry: { type: 'LIMIT_PULLBACK', low: 424, high: 425, trigger: null, level: null },
  sl: 419.5,
  targets: [433.5, 440],
  validUntil: '15:00',
  confidence: 62,
  evidence: [{ fact: 'LTP', value: '431.3', source: 'quote' }],
};
const setupReply = (u = 'DABUR', plan: Partial<SetupPlan> = {}): SetupReply => ({
  decision: 'SETUP',
  reason: 'breakout real but late: buy the pullback',
  setup: { ...DABUR_PLAN, ...plan, instrument: { ...DABUR_PLAN.instrument, symbol: u, ...(plan.instrument ?? {}) } },
});

type Row = AiSetupWrite & { createdAt: Date };

function make(o: { aiCap?: string; mode?: string; open?: Record<string, string>; rows?: Row[]; reply?: (u: string) => Promise<SetupReply>; packet?: (u: string) => Promise<SetupPacket>; isOpen?: boolean } = {}) {
  const rows: Row[] = [...(o.rows ?? [])];
  let now = NOW;
  const repo = {
    insert: jest.fn(async (r: AiSetupWrite) => {
      rows.push({ ...r, createdAt: now });
    }),
    setupsToday: jest.fn(async (at: Date) => {
      const dayStart = new Date(Date.UTC(2026, 10, 24, 18, 30));
      return rows.filter((r) => ['PENDING', 'FILLED', 'EXITED', 'EXPIRED'].includes(r.status) && r.createdAt >= dayStart && r.createdAt <= at).length;
    }),
    recentOnUnderlying: jest.fn(async (u: string, since: Date) => rows.filter((r) => r.underlying === u && r.createdAt >= since).map((r) => ({ status: r.status, checks: r.checks, createdAt: r.createdAt }))),
    openOnUnderlying: jest.fn(async (u: string) => {
      if (o.open?.[u]) return o.open[u];
      const s = rows.find((r) => r.underlying === u && (r.status === 'PENDING' || r.status === 'FILLED'));
      return s ? `AI setup ${s.status} on ${u}` : null;
    }),
    aiCallsToday: jest.fn(async (at: Date) => {
      const dayStart = new Date(Date.UTC(2026, 10, 24, 18, 30));
      const stage = (c: unknown) => (c && typeof c === 'object' ? (c as { stage?: unknown }).stage : undefined);
      return rows.filter((r) => ['ai', 'checks'].includes(String(stage(r.checks))) && r.createdAt >= dayStart && r.createdAt <= at).length;
    }),
    channelTitle: jest.fn(async () => 'Stock Gainers'),
  };
  const packet = { build: jest.fn(async (i: { underlying: string }) => ({ packet: await (o.packet ?? (async (u: string) => packetFor(u)))(i.underlying), ms: 40 })) };
  let inFlight = 0;
  let maxInFlight = 0;
  const llm = {
    build: jest.fn(async (i: { packet: SetupPacket }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const reply = await (o.reply ?? (async (u: string) => setupReply(u)))(i.packet.underlying);
        return { reply, ms: 900, model: 'claude-opus-test' };
      } finally {
        inFlight--;
      }
    }),
  };
  const cfg = parseAiSetupsConfig({ AI_SETUPS: o.mode ?? 'paper', AI_SETUP_MODEL: 'claude-opus-test', AI_SETUP_MAX_AI_CALLS_PER_DAY: o.aiCap });
  const clock = { isOpen: jest.fn(() => o.isOpen ?? true) };
  const svc = new AiSetupsService(repo, packet, llm, cfg, () => now, clock);
  return { svc, repo, packet, llm, rows, clock, maxInFlight: () => maxInFlight, setNow: (d: Date) => (now = d) };
}

describe('setupCandidates (eligibility)', () => {
  it('a READ INSTRUMENT reading with a CONFIRMED BULL / BEAR claim → one job per underlying', () => {
    const c = setupCandidates(event({ claims: [DABUR_CLAIM, { ...DABUR_CLAIM, text: 'again' }, claimOn('ITC', { bias: 'BEAR' })] }));
    expect(c.jobs.map((j) => j.underlying)).toEqual(['DABUR', 'ITC']);
    expect(c.sectorSkips).toEqual([]);
  });

  it.each([
    ['a CALL post', { kind: 'CALL' as const }],
    ['an UPDATE post', { kind: 'UPDATE' as const }],
    ['MARKET scope', { scope: 'MARKET' as const }],
    ['an UNCLEAR claim', { claims: [{ ...DABUR_CLAIM, verdict: 'UNCLEAR' as const }] }],
    ['a CONTRADICTED claim', { claims: [{ ...DABUR_CLAIM, verdict: 'CONTRADICTED' as const }] }],
    ['a NEUTRAL claim', { claims: [{ ...DABUR_CLAIM, bias: 'NEUTRAL' as const }] }],
    ['a CAUTION claim', { claims: [{ ...DABUR_CLAIM, bias: 'CAUTION' as const }] }],
    ['a MARKET subject', { claims: [claimOn('MARKET')] }],
    ['no claims', { claims: [] }],
  ])('%s → nothing', (_name, over) => {
    expect(setupCandidates(event(over))).toEqual({ jobs: [], sectorSkips: [] });
  });

  it('SECTOR scope → a sector skip (v1), never a job', () => {
    const c = setupCandidates(event({ scope: 'SECTOR', claims: [claimOn('FMCG')] }));
    expect(c.jobs).toEqual([]);
    expect(c.sectorSkips.map((j) => j.underlying)).toEqual(['FMCG']);
  });
});

describe('AiSetupsService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('a confirmed DABUR claim → one PENDING setup with validUntil, the checks, the packet and the prompt version', async () => {
    const m = make();
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.packet.build).toHaveBeenCalledWith({ underlying: 'DABUR', claim: DABUR_CLAIM, reading: { channelId: 'ch-sg' }, now: NOW });
    expect(m.llm.build).toHaveBeenCalledWith(
      expect.objectContaining({ claim: DABUR_CLAIM, channelTitle: 'Stock Gainers', postText: 'Dabur breakout 🚀', postedAtIst: '2026-11-25 14:16 IST', readAtIst: '2026-11-25 14:17 IST', readingSummary: 'Dabur breakout, confirmed at 431.3' }),
    );
    expect(m.rows).toHaveLength(1);
    const r = m.rows[0];
    expect(r).toMatchObject({ readingId: 'msg-1', underlying: 'DABUR', channelId: 'ch-sg', decision: 'SETUP', status: 'PENDING', reason: 'breakout real but late: buy the pullback' });
    expect(r.validUntil).toEqual(new Date('2026-11-25T09:30:00Z')); // 15:00 IST
    expect(r.setup).toEqual(setupReply().setup);
    expect(r.packet).toMatchObject({ underlying: 'DABUR' });
    expect(r.checks).toMatchObject({ stage: 'checks', result: { ok: true }, promptVersion: SETUP_PROMPT_VERSION, model: 'claude-opus-test', context: { ltpUnderlying: 431.3, atr15m: 3, delta: 0.5, lotSize: 500, spreadPct: 1.2, oi: 1480, ceiling: 2000, exchange: 'NFO' } });
  });

  it.each(['CALL', 'UPDATE'] as const)('a %s post → nothing stored, no packet, no AI', async (kind) => {
    const m = make();
    m.svc.onReadingStored(event({ kind }));
    await m.svc.whenIdle();
    expect(m.packet.build).not.toHaveBeenCalled();
    expect(m.llm.build).not.toHaveBeenCalled();
    expect(m.rows).toHaveLength(0);
  });

  it('mode off → the listener returns at once (nothing stored)', async () => {
    const m = make({ mode: 'off' });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.repo.openOnUnderlying).not.toHaveBeenCalled();
    expect(m.rows).toHaveLength(0);
  });

  it('SECTOR scope → SKIPPED with the v1 reason (visible), no AI', async () => {
    const m = make();
    m.svc.onReadingStored(event({ scope: 'SECTOR', claims: [claimOn('FMCG')] }));
    await m.svc.whenIdle();
    expect(m.llm.build).not.toHaveBeenCalled();
    expect(m.rows).toEqual([expect.objectContaining({ underlying: 'FMCG', status: 'SKIPPED', decision: 'SKIPPED', reason: expect.stringContaining('SECTOR') })]);
  });

  it('cap: 3 setups already today → SKIPPED daily cap; NO_TRADE / SKIPPED rows do not count', async () => {
    const earlier = (u: string, status: string): Row => ({ readingId: 'x', underlying: u, channelId: 'c', decision: 'SETUP', reason: 'r', status, createdAt: new Date(NOW.getTime() - 120 * MIN) });
    const m = make({ rows: [earlier('ITC', 'EXITED'), earlier('TCS', 'EXPIRED'), earlier('INFY', 'NO_TRADE'), earlier('SBIN', 'SKIPPED')] });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.rows[4]).toMatchObject({ underlying: 'DABUR', status: 'PENDING' });
    m.rows.push(earlier('HDFC', 'FILLED'));
    m.svc.onReadingStored(event({ messageId: 'msg-2', claims: [claimOn('WIPRO')] }));
    await m.svc.whenIdle();
    expect(m.llm.build).toHaveBeenCalledTimes(1);
    expect(m.rows[6]).toMatchObject({ underlying: 'WIPRO', status: 'SKIPPED', reason: expect.stringContaining('daily cap') });
  });

  it('a burst of 5 confirmed claims → at most 3 setups, never more than 2 AI calls at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = make({ reply: async (u) => (await gate, setupReply(u)) });
    for (const [i, u] of ['DABUR', 'ITC', 'TCS', 'INFY', 'SBIN'].entries()) m.svc.onReadingStored(event({ messageId: `m${i}`, claims: [claimOn(u)] }));
    await new Promise((r) => setImmediate(r));
    release();
    await m.svc.whenIdle();
    expect(m.maxInFlight()).toBeLessThanOrEqual(2);
    expect(m.rows.filter((r) => r.status === 'PENDING')).toHaveLength(3);
    expect(m.rows.filter((r) => r.status === 'SKIPPED')).toHaveLength(2);
    expect(m.rows.filter((r) => r.status === 'SKIPPED').every((r) => /daily cap/.test(r.reason))).toBe(true);
  });

  it('one in-flight job per underlying: a second DABUR claim while the first is building → SKIPPED, one setup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = make({ reply: async (u) => (await gate, setupReply(u)) });
    m.svc.onReadingStored(event());
    m.svc.onReadingStored(event({ messageId: 'msg-2' }));
    await new Promise((r) => setImmediate(r));
    release();
    await m.svc.whenIdle();
    expect(m.llm.build).toHaveBeenCalledTimes(1);
    expect(m.rows.filter((r) => r.status === 'PENDING')).toHaveLength(1);
    expect(m.rows.find((r) => r.readingId === 'msg-2')).toMatchObject({ status: 'SKIPPED', reason: expect.stringContaining('in flight') });
  });

  it('cooldown: any setup row on the underlying in the last 30 min → SKIPPED; guard skips do not extend it', async () => {
    const at = (min: number, status: string, checks: unknown = { stage: 'ai' }): Row => ({ readingId: 'x', underlying: 'DABUR', channelId: 'c', decision: 'NO_TRADE', reason: 'r', status, checks, createdAt: new Date(NOW.getTime() - min * MIN) });
    const m = make({ rows: [at(20, 'NO_TRADE')] });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.llm.build).not.toHaveBeenCalled();
    expect(m.rows[1]).toMatchObject({ status: 'SKIPPED', reason: expect.stringContaining('cooldown') });

    const m2 = make({ rows: [at(31, 'NO_TRADE'), at(10, 'SKIPPED', { stage: 'guard' })] });
    m2.svc.onReadingStored(event());
    await m2.svc.whenIdle();
    expect(m2.rows[2]).toMatchObject({ status: 'PENDING' });
  });

  it('an open signal trade on the underlying → SKIPPED with that reason, no AI', async () => {
    const m = make({ open: { DABUR: 'open signal trade on DABUR (paper TELEGRAM_SIGNAL_NO_FUNDS DABUR29DEC25430CE)' } });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.llm.build).not.toHaveBeenCalled();
    expect(m.rows).toEqual([expect.objectContaining({ status: 'SKIPPED', reason: expect.stringContaining('open signal trade on DABUR'), checks: expect.objectContaining({ stage: 'guard' }) })]);
  });

  it('a market that is closed → SKIPPED, no packet', async () => {
    const m = make({ isOpen: false });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.packet.build).not.toHaveBeenCalled();
    expect(m.rows[0]).toMatchObject({ status: 'SKIPPED', reason: expect.stringContaining('closed') });
  });

  it('a check failure → NO_TRADE naming the failed check (the AI decision stays SETUP)', async () => {
    const m = make({ packet: async (u) => packetFor(u, {}, { spreadPct: 2.5 }) });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.rows[0]).toMatchObject({ decision: 'SETUP', status: 'NO_TRADE', reason: expect.stringContaining('spread_too_wide'), validUntil: null });
    expect(m.rows[0].checks).toMatchObject({ stage: 'checks', result: { ok: false, failed: 'spread_too_wide' } });
  });

  it('a setup naming an option not in the chain block → NO_TRADE option_not_in_chain', async () => {
    const m = make({ reply: async (u) => setupReply(u, { instrument: { ...DABUR_PLAN.instrument, expiry: '2027-01-27' } }) });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.rows[0]).toMatchObject({ status: 'NO_TRADE', checks: expect.objectContaining({ result: expect.objectContaining({ failed: 'option_not_in_chain' }) }) });
  });

  it('a validUntil already past → NO_TRADE valid_until_past', async () => {
    const m = make({ reply: async (u) => setupReply(u, { validUntil: '14:00' }) });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.rows[0]).toMatchObject({ status: 'NO_TRADE', checks: expect.objectContaining({ result: expect.objectContaining({ failed: 'valid_until_past' }) }) });
  });

  it("the AI's NO_TRADE → NO_TRADE with its reason", async () => {
    const m = make({ reply: async () => ({ decision: 'NO_TRADE', reason: 'move is stale', setup: null }) });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.rows[0]).toMatchObject({ decision: 'NO_TRADE', status: 'NO_TRADE', reason: 'move is stale', setup: null, validUntil: null });
  });

  it.each(['quote', 'bars15m', 'chain'] as const)('missing %s → NO_TRADE with the reason, no AI call', async (block) => {
    const m = make({ packet: async (u) => packetFor(u, { [block]: { status: 'unavailable', source: 's', reason: 'timed out' } }) });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.llm.build).not.toHaveBeenCalled();
    expect(m.rows[0]).toMatchObject({ decision: 'NO_TRADE', status: 'NO_TRADE', reason: expect.stringContaining(`${block} unavailable (timed out)`) });
    expect(m.rows[0].checks).toMatchObject({ stage: 'packet', result: { ok: false, failed: 'data_unavailable' } });
  });

  it('an LLM error → SKIPPED with the error (visible), never thrown', async () => {
    const m = make({ reply: async () => Promise.reject(new Error('setup AI timed out after 120000 ms')) });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.rows[0]).toMatchObject({ status: 'SKIPPED', reason: expect.stringContaining('setup AI timed out'), checks: expect.objectContaining({ stage: 'ai' }) });
    expect(m.rows[0].packet).toMatchObject({ underlying: 'DABUR' });
  });

  it('a packet failure → SKIPPED with the error', async () => {
    const m = make({ packet: async () => Promise.reject(new Error('broker down')) });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.llm.build).not.toHaveBeenCalled();
    expect(m.rows[0]).toMatchObject({ status: 'SKIPPED', reason: expect.stringContaining('broker down') });
  });

  it('a throw while building (unexpected reply shape) → one SKIPPED row (stage checks), and the cooldown then blocks the next claim', async () => {
    const m = make({ reply: async (u) => setupReply(u, { validUntil: 1500 as unknown as string }) });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ underlying: 'DABUR', decision: 'SKIPPED', status: 'SKIPPED', reason: expect.stringMatching(/^setup build failed: /), checks: expect.objectContaining({ stage: 'checks' }) });
    m.setNow(new Date(NOW.getTime() + 5 * MIN));
    m.svc.onReadingStored(event({ messageId: 'msg-2' }));
    await m.svc.whenIdle();
    expect(m.llm.build).toHaveBeenCalledTimes(1);
    expect(m.rows[1]).toMatchObject({ status: 'SKIPPED', reason: expect.stringContaining('cooldown') });
  });

  it('AI call cap: rows that reached the AI today (stage ai / checks) count, NO_TRADE included; at the cap → SKIPPED ai_daily_cap, no packet, no AI', async () => {
    const earlier = (u: string, status: string, stage: string): Row => ({ readingId: 'x', underlying: u, channelId: 'c', decision: 'NO_TRADE', reason: 'r', status, checks: { stage }, createdAt: new Date(NOW.getTime() - 120 * MIN) });
    const m = make({ aiCap: '3', rows: [earlier('ITC', 'NO_TRADE', 'ai'), earlier('TCS', 'NO_TRADE', 'checks'), earlier('INFY', 'NO_TRADE', 'packet'), earlier('SBIN', 'SKIPPED', 'guard')] });
    m.svc.onReadingStored(event());
    await m.svc.whenIdle();
    expect(m.rows[4]).toMatchObject({ underlying: 'DABUR', status: 'PENDING' });
    m.svc.onReadingStored(event({ messageId: 'msg-2', claims: [claimOn('WIPRO')] }));
    await m.svc.whenIdle();
    expect(m.llm.build).toHaveBeenCalledTimes(1);
    expect(m.packet.build).toHaveBeenCalledTimes(1);
    expect(m.rows[5]).toMatchObject({ underlying: 'WIPRO', decision: 'SKIPPED', status: 'SKIPPED', reason: expect.stringMatching(/^ai_daily_cap/), checks: expect.objectContaining({ stage: 'guard' }) });
  });

  it('AI call cap counts jobs in flight: a burst never makes more AI calls than the cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = make({ aiCap: '2', reply: async () => (await gate, { decision: 'NO_TRADE', reason: 'stale', setup: null }) });
    for (const [i, u] of ['DABUR', 'ITC', 'TCS', 'INFY'].entries()) m.svc.onReadingStored(event({ messageId: `m${i}`, claims: [claimOn(u)] }));
    await new Promise((r) => setImmediate(r));
    release();
    await m.svc.whenIdle();
    expect(m.llm.build).toHaveBeenCalledTimes(2);
    expect(m.rows.filter((r) => r.status === 'NO_TRADE')).toHaveLength(2);
    expect(m.rows.filter((r) => /^ai_daily_cap/.test(r.reason))).toHaveLength(2);
  });

  it('never throws into the reader: a store or guard failure is logged only', async () => {
    const m = make();
    m.repo.insert.mockRejectedValue(new Error('db down'));
    m.repo.openOnUnderlying.mockRejectedValueOnce(new Error('db down'));
    expect(() => m.svc.onReadingStored(event())).not.toThrow();
    expect(() => m.svc.onReadingStored(null as unknown as ReadingStoredEvent)).not.toThrow();
    await m.svc.whenIdle();
    expect(m.llm.build).not.toHaveBeenCalled();
  });
});
