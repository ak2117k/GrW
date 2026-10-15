import { Logger } from '@nestjs/common';
import { APIConnectionError, RateLimitError } from '@anthropic-ai/sdk';
import { SentinelAgentService, VERDICT_SCHEMA, type Verdict } from './sentinel-agent.service';
import { absent, present, type ContextPacket } from './context-packet.service';
import { createHash } from 'crypto';
import {
  SENTINEL_PROMPT_VERSION,
  SENTINEL_SYSTEM_PROMPT,
  SENTINEL_SYSTEM_PROMPT_NO_CUES,
  SENTINEL_PROMPT_VERSION_NO_CUES,
  EXIT_TRIGGER_RULES,
  V5_OWNERSHIP_LINE,
  V6_OWNERSHIP_LINE,
  PRE_V7_MANDATE_LINE,
  PRE_V7_MONEY_FIELDS,
  PRE_V7_FLOW_FIELDS,
  PRE_V7_BLOCKS_LINE,
  V7_MANDATE_LINES,
  V7_READING_LINES,
  sentinelPromptVersion,
  sentinelSystemPrompt,
  type SentinelPromptOptions,
} from '../prompts/sentinel-system-prompt';
import { THESIS_PROMPT_VERSION } from '../prompts/thesis-prompt';

const AT = '2026-08-14T04:30:00.000Z';

/**
 * A REAL packet, not a stub. The agent's hardest invariant — that every
 * `evidence` citation points at a field the packet actually has — cannot be
 * tested against `{position: {symbol}}`: every legitimate citation would look
 * invented and every test would pass for the wrong reason.
 *
 * ANNOTATED, NOT ASSERTED. `const base: ContextPacket` is checked against the
 * real type; `as ContextPacket` would not be — a type assertion tolerates
 * missing properties, so a rename in `ContextPacket` would leave this fixture
 * compiling, the prompt drift guard below comparing the prompt against a
 * fixture that drifted with it, and the guard green while the packet moved.
 */
const base: ContextPacket = {
  position: {
    symbol: 'INFY',
    kind: 'POSITION',
    ownership: 'SENTINEL',
    segment: 'EQ_DELIVERY',
    side: 'LONG',
    qty: 100,
    entryPrice: 1400,
    ltp: 1462,
    underlyingLtp: present(1462, 'market-data (underlying spot)', AT),
    entryTime: '2026-08-13T04:15:00.000Z',
    expiry: null,
  },
  money: {
    grossPnl: 6200,
    charges: 120,
    netPnl: 6080,
    greenFloorPrice: 1441,
    greenFloorArmed: true,
    floorBasis: 'fixed',
    mfe: 1478,
    mae: 1396,
  },
  thesis: present(
    {
      direction: 'LONG',
      reason: 'breakout above the 1400 shelf',
      levelPrice: 1400,
      targetPrice: 1500,
      invalidation: 1380,
      source: 'AGENT',
    },
    'agent inference',
    AT,
  ),
  structure: {
    levelBook: present([{ price: 1450, kind: 'SUPPORT' }], 'chart-context.service (1d)', AT),
    nearestSupport: present(1450, 'level book (underlying scale)', AT),
    nearestResistance: present(1500, 'level book (underlying scale)', AT),
  },
  flow: {
    volumeRatio: present(1.8, 'market-data', AT),
    oiWalls: present(
      { now: { callWall: 1500, putWall: 1400 }, previous: { callWall: 1520, putWall: 1400 } },
      'oi-wall.service',
      AT,
    ),
    // Exit discipline on (the default): the packet carries both discipline fields.
    noiseUnit: absent('no hub 1-minute bars for this contract in the last 120 minutes (needs MARKET_HUB_ENABLED + HUB_CANDLES_ENABLED and a live feed slot)'),
  },
  macro: {
    fiiDii: absent('stub'),
    sector: absent('stub'),
    globalCues: absent('stub'),
    realFactors: present({ mtfTrend: 0.6 }, 'context-scoring', AT),
  },
  news: {
    headlines: absent('news aggregator returned nothing for this symbol'),
    freshCount: present(0, 'news-aggregator.service', AT),
  },
  session: {
    nowIst: '2026-08-14 10:00:00 IST',
    nowUtc: AT,
    minutesToClose: present(330, 'derived from IST wall clock', AT),
    expiry: null,
  },
  trigger: present([{ name: 'heartbeat', detail: 'scheduled review' }], 'tripwire.service', AT),
  memory: absent('no prior verdicts for this position — this is the first look'),
};

/** The cast lives HERE, on the override spread only — never on `base`. */
function packet(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return { ...base, ...overrides } as ContextPacket;
}

const validVerdict: Verdict = {
  verdict: 'HOLD',
  confidence: 'high',
  thesisStatus: 'INTACT',
  recoveryAvailable: true,
  reason: 'structure holding above the demand zone',
  evidence: ['structure.nearestSupport', 'money.netPnl'],
  invalidationPoint: 'close below 1450',
  reviewIn: 300,
};

const reply = (obj: unknown) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(obj) }],
});

describe('SentinelAgentService', () => {
  const create = jest.fn();
  const client = { messages: { create } } as never;
  const svc = new SentinelAgentService(client);

  beforeEach(() => jest.clearAllMocks());

  /**
   * The stamp has to move when EITHER prompt moves. The thesis prompt writes the
   * packet's `thesis` block, so editing it shifts verdicts — and a stamp that
   * only tracked the verdict prompt would leave the replay diff blaming the
   * wrong prompt for the change.
   */
  it('stamps both the verdict prompt and the thesis prompt that filled the packet', () => {
    // The literal, not only the composition — an expectation built purely from
    // the constants under test would still pass if both were empty strings.
    // No config here = market cues off, exit discipline on (its default), triggers off.
    expect(svc.promptVersion).toBe('v2.4/t1');
    const on = new SentinelAgentService({ messages: { create: jest.fn() } } as never, { get: (k: string) => (k === 'MARKET_CUES_ENABLED' ? 'true' : undefined) } as never);
    expect(on.promptVersion).toBe('v7/t1');
    expect(on.promptVersion).toBe(`${SENTINEL_PROMPT_VERSION}/${THESIS_PROMPT_VERSION}`);
    expect(SENTINEL_PROMPT_VERSION).not.toContain('/');
    expect(THESIS_PROMPT_VERSION).not.toContain('/');
  });

  it('returns the parsed verdict on a well-formed reply', async () => {
    create.mockResolvedValue(reply(validVerdict));
    await expect(svc.judge(packet())).resolves.toMatchObject({
      verdict: 'HOLD',
      confidence: 'high',
      evidence: ['structure.nearestSupport', 'money.netPnl'],
    });
  });

  it('with market cues off, the live prompt is the v2 text: the old macro line, none of the cue lines', () => {
    expect(SENTINEL_SYSTEM_PROMPT_NO_CUES).toContain(
      '- macro.fiiDii, macro.sector and macro.globalCues are always unavailable in this stage. Do not reason about macro you cannot see.',
    );
    expect(SENTINEL_SYSTEM_PROMPT_NO_CUES).not.toMatch(/nasdaqFutures|giftNifty/);
    expect(SENTINEL_SYSTEM_PROMPT).toMatch(/giftNifty/);
  });

  it('with cues on, the prompt names every MCX benchmark block the packet can carry', () => {
    for (const k of ['wtiCrude', 'brentCrude', 'gold', 'silver', 'naturalGas', 'copper', 'usdInr', 'mcxBenchmark']) {
      expect({ k, named: SENTINEL_SYSTEM_PROMPT.includes(k) }).toEqual({ k, named: true });
    }
    expect(SENTINEL_SYSTEM_PROMPT_NO_CUES).not.toMatch(/wtiCrude|usdInr|mcxBenchmark/);
  });

  /** The v2/v3 minutesToClose line — FALSE about the code (see the next test). */
  const OLD_MTC_LINE =
    '- session.minutesToClose says how many minutes remain until the 15:30 IST close. It is present BEFORE the session opens as well as during it — at 07:00 IST it reads 510. It is NOT evidence that the market is open or that this position is currently trading. Nothing in the packet tells you the session has started, so do not claim it has.';

  /** The v2-v4 ownership line — FALSE once the sentinel auto-exit can act on EXIT_NOW. */
  const OLD_OWNERSHIP_LINE =
    '- position.ownership is "SENTINEL" when this trade is yours to judge alone, or "OBSERVE_ONLY" when it is a long-term holding or is already managed by another engine. It is stated so your verdict can be attributed to the right kind of trade. Judge the trade the same way either way — nothing acts on your verdict in this stage.';

  it.each([
    ['cues on', sentinelSystemPrompt({ cues: true, triggers: true, discipline: true })],
    ['cues off', sentinelSystemPrompt({ cues: false, triggers: true, discipline: true })],
    ['cues on, discipline off', sentinelSystemPrompt({ cues: true, triggers: true, discipline: false })],
  ])('triggers on: says truthfully that an EXIT_NOW, or a HOLD/EXIT_ARMED exitTrigger once crossed, may be executed automatically; ESCALATE never is (%s)', (_label, prompt) => {
    expect(prompt).not.toMatch(/nothing acts on your verdict/);
    const line = prompt.split('\n').find((l) => l.startsWith('- position.ownership')) ?? '';
    expect(line).toContain('Judge the trade the same way either way.');
    expect(line).toContain("Depending on the owner's settings, an EXIT_NOW may be executed automatically as a market exit of the whole position, and so may the exitTrigger of a HOLD or EXIT_ARMED verdict once price crosses it; ESCALATE never is.");
  });

  it.each([
    ['cues on', SENTINEL_SYSTEM_PROMPT],
    ['cues off', SENTINEL_SYSTEM_PROMPT_NO_CUES],
    ['cues on, discipline off', sentinelSystemPrompt({ cues: true, triggers: false, discipline: false })],
  ])('triggers off (the default): never claims an exitTrigger is executed — the v5 ownership line, no rules (%s)', (_label, prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('- position.ownership')) ?? '';
    expect(line).toBe(V5_OWNERSHIP_LINE);
    expect(prompt).not.toContain(EXIT_TRIGGER_RULES);
    expect(prompt).not.toMatch(/exitTrigger/);
  });

  it('the flag-off prompt IS the v2 text from main except the corrected minutesToClose and ownership lines', () => {
    // Hash of SENTINEL_SYSTEM_PROMPT as shipped at 9095047 (v2, 5562 chars).
    // Putting the old lines back must reproduce it byte for byte, so the ONLY
    // changes v2 -> v2.3 are those two corrections plus the v2.3 exitTrigger block
    // (v2.1: minutesToClose, v2.2/v2.3: ownership, v2.3: exitTrigger rules).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('crypto') as typeof import('crypto');
    const line = SENTINEL_SYSTEM_PROMPT_NO_CUES.split('\n').find((l) => l.startsWith('- session.minutesToClose'));
    expect(line).toBeDefined();
    const own = SENTINEL_SYSTEM_PROMPT_NO_CUES.split('\n').find((l) => l.startsWith('- position.ownership'));
    expect(own).toBeDefined();
    const restored = undoV7(SENTINEL_SYSTEM_PROMPT_NO_CUES)
      .replace(EXIT_TRIGGER_RULES, '')
      .replace(line as string, OLD_MTC_LINE)
      .replace(own as string, OLD_OWNERSHIP_LINE);
    expect(restored).toHaveLength(5562);
    expect(createHash('sha256').update(restored, 'utf8').digest('hex')).toBe(
      '084d0a1422f2bdba2f10c1d19bd70dde7c18459461fb0122b7f055c01a3c16ad',
    );
  });

  it.each([
    ['cues on', SENTINEL_SYSTEM_PROMPT],
    ['cues off', SENTINEL_SYSTEM_PROMPT_NO_CUES],
  ])('describes session.minutesToClose as the code computes it (%s)', (_label, prompt) => {
    // context-packet.service.ts `minutesToSessionClose`: the POSITION's own
    // exchange close (NSE 15:30, MCX 23:30 or 23:55 in the late-close season),
    // and ABSENT before the open — the old text claimed the opposite of both.
    expect(prompt).not.toContain(OLD_MTC_LINE);
    expect(prompt).not.toMatch(/reads 510|present BEFORE the session opens/);
    const line = prompt.split('\n').find((l) => l.startsWith('- session.minutesToClose')) ?? '';
    expect(line).toMatch(/own exchange/);
    expect(line).toMatch(/15:30/);
    expect(line).toMatch(/MCX/);
    expect(line).toMatch(/23:30/);
    expect(line).toMatch(/23:55/);
    expect(line).toMatch(/unavailable/i);
    expect(line).toMatch(/before the open/i);
  });

  it('with market cues on, sends the v7 prompt and stamps v7', async () => {
    const c = jest.fn().mockResolvedValue(reply(validVerdict));
    const on = new SentinelAgentService({ messages: { create: c } } as never, { get: (k: string) => (k === 'MARKET_CUES_ENABLED' ? 'TRUE' : undefined) } as never);
    await on.judge(packet());
    expect(c.mock.calls[0][0].system[0].text).toBe(SENTINEL_SYSTEM_PROMPT);
    expect(on.promptVersion).toBe('v7/t1');
  });

  it('sends the packet as the user turn and caches the system prompt', async () => {
    create.mockResolvedValue(reply(validVerdict));
    await svc.judge(packet());
    const args = create.mock.calls[0][0];
    expect(args.model).toBe('claude-opus-5');
    expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // Market cues off (no config): the pre-cues v2 prompt, word for word.
    expect(args.system[0].text).toBe(SENTINEL_SYSTEM_PROMPT_NO_CUES);
    expect(args.messages[0].role).toBe('user');
    expect(args.messages[0].content).toContain('INFY');
    // The packet must ride in the USER turn, or the cached prefix changes on
    // every tick and the cache never reads.
    expect(args.system[0].text).not.toContain('INFY');
  });

  it('asks for the verdict schema and leaves room for thinking plus the reply', async () => {
    create.mockResolvedValue(reply(validVerdict));
    await svc.judge(packet());
    const args = create.mock.calls[0][0];
    expect(args.output_config.effort).toBe('high');
    expect(args.output_config.format.type).toBe('json_schema');
    expect(args.output_config.format.schema.additionalProperties).toBe(false);
    expect(args.output_config.format.schema.required).toEqual(
      expect.arrayContaining(['evidence', 'invalidationPoint', 'recoveryAvailable']),
    );
    // max_tokens caps thinking AND response together on this model.
    expect(args.max_tokens).toBe(16000);
  });

  it('rejects a verdict that cites no evidence', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, evidence: [] }));
    await expect(svc.judge(packet())).rejects.toThrow(/evidence/i);
  });

  it('rejects a verdict citing a field the packet does not have', async () => {
    create.mockResolvedValue(
      reply({ ...validVerdict, evidence: ['money.netPnl', 'flow.rsiDivergence'] }),
    );
    await expect(svc.judge(packet())).rejects.toThrow(/flow\.rsiDivergence/);
  });

  it('rejects a verdict citing prose instead of a field path', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, evidence: ['price is holding up well'] }));
    await expect(svc.judge(packet())).rejects.toThrow(/not in the packet/i);
  });

  it('accepts a citation annotated with the value it read', async () => {
    create.mockResolvedValue(
      reply({ ...validVerdict, evidence: ['money.netPnl (₹6080)', 'structure.nearestSupport'] }),
    );
    await expect(svc.judge(packet())).resolves.toMatchObject({ verdict: 'HOLD' });
  });

  it('accepts a citation of a block that is unavailable in this packet', async () => {
    // Reasoning about what it CANNOT see is the behaviour the packet's block
    // design asks for — citing the absence must not be punished as invention.
    create.mockResolvedValue(
      reply({ ...validVerdict, evidence: ['news.headlines', 'macro.sector'] }),
    );
    await expect(svc.judge(packet())).resolves.toMatchObject({ verdict: 'HOLD' });
  });

  it('accepts a citation that reaches inside an opaque block value', async () => {
    create.mockResolvedValue(
      reply({ ...validVerdict, evidence: ['flow.oiWalls.now.callWall', 'trigger'] }),
    );
    await expect(svc.judge(packet())).resolves.toMatchObject({ verdict: 'HOLD' });
  });

  it('rejects a citation of a field that is absent from THIS packet', async () => {
    // `structure.nearestSupport` is a real field name, but a packet built
    // without structure at all must not accept it — the check is against the
    // packet the agent was handed, not against the type.
    const stripped = packet({ structure: undefined as never });
    create.mockResolvedValue(reply({ ...validVerdict, evidence: ['structure.nearestSupport'] }));
    await expect(svc.judge(stripped)).rejects.toThrow(/not in the packet/i);
  });

  it('rejects EXIT_NOW at anything below high confidence', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, verdict: 'EXIT_NOW', confidence: 'medium' }));
    await expect(svc.judge(packet())).rejects.toThrow(/confidence/i);
  });

  it('accepts EXIT_NOW at high confidence', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, verdict: 'EXIT_NOW', confidence: 'high' }));
    await expect(svc.judge(packet())).resolves.toMatchObject({ verdict: 'EXIT_NOW' });
  });

  it('rejects recoveryAvailable=false unless the thesis is BROKEN at high confidence', async () => {
    create.mockResolvedValue(
      reply({ ...validVerdict, recoveryAvailable: false, thesisStatus: 'INTACT' }),
    );
    await expect(svc.judge(packet())).rejects.toThrow(/recovery/i);
  });

  it('rejects recoveryAvailable=false on a BROKEN thesis held at medium confidence', async () => {
    create.mockResolvedValue(
      reply({
        ...validVerdict,
        verdict: 'ESCALATE',
        recoveryAvailable: false,
        thesisStatus: 'BROKEN',
        confidence: 'medium',
      }),
    );
    await expect(svc.judge(packet())).rejects.toThrow(/recovery/i);
  });

  it('accepts recoveryAvailable=false on a BROKEN thesis at high confidence', async () => {
    create.mockResolvedValue(
      reply({
        ...validVerdict,
        verdict: 'EXIT_NOW',
        recoveryAvailable: false,
        thesisStatus: 'BROKEN',
        confidence: 'high',
      }),
    );
    await expect(svc.judge(packet())).resolves.toMatchObject({ recoveryAvailable: false });
  });

  it('rejects a blank invalidation point', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, invalidationPoint: '   ' }));
    await expect(svc.judge(packet())).rejects.toThrow(/invalidation/i);
  });

  it('rejects a blank reason', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, reason: '' }));
    await expect(svc.judge(packet())).rejects.toThrow(/reason/i);
  });

  it('rejects a non-positive reviewIn', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, reviewIn: 0 }));
    await expect(svc.judge(packet())).rejects.toThrow(/reviewIn/);
  });

  it('carries an ESCALATE at low confidence on a weakening thesis through unchanged', async () => {
    // The three enum values no other test exercises. `validate()` constrains
    // EXIT_NOW and recoveryAvailable only — everything else must pass through,
    // or the runner loses the verdicts that ask a human to look.
    create.mockResolvedValue(
      reply({
        ...validVerdict,
        verdict: 'ESCALATE',
        confidence: 'low',
        thesisStatus: 'WEAKENING',
        evidence: ['flow.volumeRatio'],
      }),
    );
    await expect(svc.judge(packet())).resolves.toMatchObject({
      verdict: 'ESCALATE',
      confidence: 'low',
      thesisStatus: 'WEAKENING',
    });
  });

  it('rejects a reply that is not JSON at all', async () => {
    create.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I think you should hold.' }],
    });
    await expect(svc.judge(packet())).rejects.toThrow(/parse/i);
  });

  it('rejects a reply whose JSON is not an object', async () => {
    create.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'null' }],
    });
    // Must be a stated rejection, not a raw TypeError off the first field read.
    await expect(svc.judge(packet())).rejects.toThrow(/not a verdict object/i);
  });

  it('rejects a reply that carries no text block at all', async () => {
    create.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'weighing the level' }],
    });
    await expect(svc.judge(packet())).rejects.toThrow(/no text block/i);
  });

  it('rejects a refusal rather than reading a verdict out of it', async () => {
    create.mockResolvedValue({ stop_reason: 'refusal', content: [] });
    await expect(svc.judge(packet())).rejects.toThrow(/refused/i);
  });

  it('reports a truncated reply as a token-budget failure, not a parse failure', async () => {
    // Thinking and response share max_tokens. Reported as "could not parse",
    // Task 13 would read a budget problem as a prompt regression.
    create.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"verdict":"HO' }],
    });
    const judged = svc.judge(packet());
    await expect(judged).rejects.toThrow(/truncated/i);
    await expect(judged).rejects.not.toThrow(/parse/i);
  });

  it('reports an over-long packet as a context-window failure', async () => {
    create.mockResolvedValue({ stop_reason: 'model_context_window_exceeded', content: [] });
    await expect(svc.judge(packet())).rejects.toThrow(/context window/i);
  });

  it('propagates a transport failure instead of inventing a verdict', async () => {
    const boom = new Error('socket hang up');
    create.mockRejectedValue(boom);
    // The caller must see the ORIGINAL error (it branches on the SDK's typed
    // classes); a swallowed failure that returned a HOLD would be a silent
    // "everything is fine" on a position nobody actually looked at.
    await expect(svc.judge(packet())).rejects.toBe(boom);
  });

  it('classifies a rate limit by the SDK exception class, not by its message', async () => {
    // The message deliberately says nothing about rate limiting: only the CLASS
    // identifies it. String-matching `err.message` — or deleting
    // describeFailure — must fail this test, or the requirement is unobserved.
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    create.mockRejectedValue(new RateLimitError(429, undefined, 'quota exhausted', new Headers()));
    await expect(svc.judge(packet())).rejects.toBeInstanceOf(RateLimitError);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
    logged.mockRestore();
  });

  it('classifies a transport failure by the SDK exception class', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    create.mockRejectedValue(new APIConnectionError({ message: 'ECONNRESET' }));
    await expect(svc.judge(packet())).rejects.toBeInstanceOf(APIConnectionError);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not reach'));
    logged.mockRestore();
  });

  it('makes exactly one API call per judgement', async () => {
    create.mockResolvedValue(reply(validVerdict));
    await svc.judge(packet());
    expect(create).toHaveBeenCalledTimes(1);
  });

  describe('the prompt describes the packet as it actually is', () => {
    const GROUPS = ['position', 'money', 'structure', 'flow', 'macro', 'news', 'session'];

    /**
     * Both forms the prompt names fields in:
     *  - dotted paths anywhere in the text ("session.minutesToClose")
     *  - the enumeration lines ("- money: grossPnl, charges, netPnl, ...")
     * The enumeration lines carry ~25 of the ~35 field names, so a guard that
     * reads only dotted paths misses a rename of greenFloorPrice or nowIst
     * entirely — which is most of what it exists to catch.
     */
    function pathsNamedByPrompt(prompt: string): string[] {
      const dotted = prompt.match(new RegExp(`\\b(?:${GROUPS.join('|')})\\.[A-Za-z]+`, 'g')) ?? [];
      const enumerated: string[] = [];
      for (const line of prompt.split('\n')) {
        const m = /^- ([a-z]+): ([^.]+)\.\s*$/.exec(line);
        if (!m || !GROUPS.includes(m[1])) continue;
        for (const field of m[2].split(',')) enumerated.push(`${m[1]}.${field.trim()}`);
      }
      // Every group must have contributed an enumeration line, or the parser
      // silently stopped matching and the guard degrades to the dotted subset.
      const covered = new Set(enumerated.map((p) => p.split('.')[0]));
      expect([...covered].sort()).toEqual([...GROUPS].sort());
      return [...new Set([...dotted, ...enumerated])];
    }

    it('names only fields the packet has', () => {
      const built = base as unknown as Record<string, Record<string, unknown>>;
      const named = pathsNamedByPrompt(SENTINEL_SYSTEM_PROMPT);
      // Guard against the guard: it must actually be looking at ~every field.
      expect(named.length).toBeGreaterThanOrEqual(30);
      const missing = named.filter((path) => {
        const [group, field] = path.split('.');
        return !(field in (built[group] ?? {}));
      });
      // A prompt that names a field the packet does not have teaches the model
      // to cite one — and `validate()` would then reject its own verdict.
      expect(missing).toEqual([]);
    });

    it('names every field the packet has', () => {
      const named = new Set(pathsNamedByPrompt(SENTINEL_SYSTEM_PROMPT));
      const built = base as unknown as Record<string, Record<string, unknown>>;
      const undocumented = GROUPS.flatMap((group) =>
        Object.keys(built[group]).map((field) => `${group}.${field}`),
      ).filter((path) => !named.has(path));
      // The other direction: a field ADDED to the packet that the prompt never
      // mentions is evidence the agent is never told it can see.
      expect(undocumented).toEqual([]);
    });
  });
});

describe('exitTrigger (price triggers, plan Task 3)', () => {
  const base = {
    verdict: 'HOLD', confidence: 'medium', thesisStatus: 'INTACT', recoveryAvailable: true,
    reason: 'holding above demand', evidence: ['money.netPnl'], invalidationPoint: 'loses 8930', reviewIn: 300,
  };
  const PACKET = { money: { netPnl: 10 } } as never;
  const agentReplying = (obj: unknown) =>
    new SentinelAgentService({
      messages: {
        create: jest.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] }),
      },
    } as never);

  it('the schema requires exitTrigger (last) and allows null through anyOf, not a type array', () => {
    expect(VERDICT_SCHEMA.required[VERDICT_SCHEMA.required.length - 1]).toBe('exitTrigger');
    const p = VERDICT_SCHEMA.properties.exitTrigger as unknown as { anyOf: Array<{ type: string }> };
    expect(p.anyOf.map((s) => s.type)).toEqual(['null', 'object']);
  });

  it('keeps a valid trigger', async () => {
    const v = await agentReplying({ ...base, exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 } }).judge(PACKET);
    expect(v.exitTrigger).toEqual({ instrument: 'UNDERLYING', op: 'BELOW', price: 8930 });
    expect(v.exitTriggerProblem).toBeUndefined();
  });

  it('keeps an explicit null', async () => {
    const v = await agentReplying({ ...base, exitTrigger: null }).judge(PACKET);
    expect(v.exitTrigger).toBeNull();
  });

  it('a pre-v6 reply with no exitTrigger key gains no key (golden results do not move)', async () => {
    const v = await agentReplying(base).judge(PACKET);
    expect(Object.prototype.hasOwnProperty.call(v, 'exitTrigger')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(v, 'exitTriggerProblem')).toBe(false);
  });

  it('a malformed trigger keeps the verdict, nulls the trigger and states the problem', async () => {
    const v = await agentReplying({ ...base, exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: '8930' } }).judge(PACKET);
    expect(v.verdict).toBe('HOLD');
    expect(v.exitTrigger).toBeNull();
    expect(v.exitTriggerProblem).toMatch(/price/);
  });
});

describe('prompt v6 / v2.3 (price triggers on, exit discipline off)', () => {
  /** SENTINEL_SYSTEM_PROMPT at v5 (7032 chars), recorded in Task 4 Step 1. */
  const V5_SHA256 = '74cde747d42359970a85810953e52b10160e08117591b6760011b280928c8b87';
  const V6 = sentinelSystemPrompt({ cues: true, triggers: true, discipline: false });

  it.each([
    ['cues on', V6],
    ['cues off', sentinelSystemPrompt({ cues: false, triggers: true, discipline: false })],
  ])('%s: carries the exitTrigger rules exactly once and the corrected ownership line', (_l, prompt) => {
    expect(prompt.split(EXIT_TRIGGER_RULES)).toHaveLength(2);
    expect(prompt).not.toContain(V5_OWNERSHIP_LINE);
    const own = prompt.split('\n').find((l) => l.startsWith('- position.ownership')) ?? '';
    expect(own).toMatch(/exitTrigger/);
    expect(own).toMatch(/ESCALATE never is/);
  });

  it('v6 differs from v5 ONLY by the rules block and the ownership line', () => {
    const own = V6.split('\n').find((l) => l.startsWith('- position.ownership')) as string;
    const v5 = V6.replace(EXIT_TRIGGER_RULES, '').replace(own, V5_OWNERSHIP_LINE);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('crypto') as typeof import('crypto');
    expect(createHash('sha256').update(v5, 'utf8').digest('hex')).toBe(V5_SHA256);
  });

  it('the stamps', () => {
    expect(sentinelPromptVersion({ cues: true, triggers: true, discipline: false })).toBe('v6');
    expect(sentinelPromptVersion({ cues: false, triggers: true, discipline: false })).toBe('v2.3');
  });
});

/** Undo the five exit-discipline edits (v7 → its predecessor). */
function undoV7(p: string): string {
  return p
    .replace(V7_READING_LINES, '')
    .replace(V7_MANDATE_LINES, `${PRE_V7_MANDATE_LINE}\n`)
    .replace(/^- money: .*$/m, PRE_V7_MONEY_FIELDS)
    .replace(/^- flow: .*$/m, PRE_V7_FLOW_FIELDS)
    .replace(/^- Blocks are .*$/m, PRE_V7_BLOCKS_LINE);
}
const sha = (p: string) => createHash('sha256').update(p, 'utf8').digest('hex');

describe('prompt v7 / v2.4 (exit discipline) and the two switches', () => {
  /** main @ 2aa9ee2, before price triggers and exit discipline: v5 (7032 chars) and v2.2 (5947 chars). */
  const MAIN_V5_SHA256 = '74cde747d42359970a85810953e52b10160e08117591b6760011b280928c8b87';
  const MAIN_V2_2_SHA256 = 'ef4401e7a1a2283dfae92328b0bb04bd731285d1c72feae3a8787f890b35e629';
  /** pt-integrated @ d6b0fb8 (price triggers): v6 (8170 chars) and v2.3 (7085 chars), recorded in Task 12 Step 1. */
  const PT_V6_SHA256 = 'ec886905c73fd3f168e3638575ad1dbeb4680ac43b68b885e205cdfb0cbf5bbc';
  const PT_V2_3_SHA256 = '051fbe0ff812b6645ef520d4a37e6c0dc4e3fb2c8d9165e9c78ad35c659a1486';

  const ALL: Array<[SentinelPromptOptions, string]> = [
    [{ cues: true, triggers: false, discipline: false }, 'v5'],
    [{ cues: false, triggers: false, discipline: false }, 'v2.2'],
    [{ cues: true, triggers: true, discipline: false }, 'v6'],
    [{ cues: false, triggers: true, discipline: false }, 'v2.3'],
    [{ cues: true, triggers: false, discipline: true }, 'v7'],
    [{ cues: false, triggers: false, discipline: true }, 'v2.4'],
    [{ cues: true, triggers: true, discipline: true }, 'v8'],
    [{ cues: false, triggers: true, discipline: true }, 'v2.5'],
  ];

  it.each(ALL)('%j is stamped %s', (o, stamp) => expect(sentinelPromptVersion(o)).toBe(stamp));

  it('eight distinct texts, eight distinct stamps — no stamp is shared by two texts', () => {
    expect(new Set(ALL.map(([o]) => sentinelSystemPrompt(o))).size).toBe(8);
    expect(new Set(ALL.map(([, v]) => v)).size).toBe(8);
  });

  it('BOTH SWITCHES OFF IS MAIN, BYTE FOR BYTE: v5 and v2.2 exactly as shipped before either feature', () => {
    const on = sentinelSystemPrompt({ cues: true, triggers: false, discipline: false });
    const off = sentinelSystemPrompt({ cues: false, triggers: false, discipline: false });
    expect(on).toHaveLength(7032);
    expect(sha(on)).toBe(MAIN_V5_SHA256);
    expect(off).toHaveLength(5947);
    expect(sha(off)).toBe(MAIN_V2_2_SHA256);
  });

  it('discipline off, triggers on IS the price-trigger prompt byte for byte (v6 / v2.3)', () => {
    expect(sha(sentinelSystemPrompt({ cues: true, triggers: true, discipline: false }))).toBe(PT_V6_SHA256);
    expect(sha(sentinelSystemPrompt({ cues: false, triggers: true, discipline: false }))).toBe(PT_V2_3_SHA256);
  });

  it.each(ALL.filter(([o]) => o.discipline))(
    '%j: carries the v7 mandate and reading lines exactly once, and the old mandate not at all',
    (o) => {
      const prompt = sentinelSystemPrompt(o);
      expect(prompt.split(V7_MANDATE_LINES)).toHaveLength(2);
      expect(prompt.split(V7_READING_LINES)).toHaveLength(2);
      expect(prompt).not.toContain(PRE_V7_MANDATE_LINE);
      expect(prompt).toMatch(/^- money: .*floorBasis/m);
      expect(prompt).toMatch(/^- flow: volumeRatio, oiWalls, noiseUnit\.$/m);
      expect(prompt).toMatch(/^- Blocks are .*flow\.noiseUnit/m);
    },
  );

  it.each(ALL.filter(([o]) => !o.discipline))('%j: names neither discipline field and claims no gate', (o) => {
    const prompt = sentinelSystemPrompt(o);
    expect(prompt).not.toMatch(/floorBasis|noiseUnit|code gate|MEANINGFUL/);
    expect(prompt).toContain(PRE_V7_MANDATE_LINE);
  });

  it.each(ALL.filter(([o]) => o.discipline))('%j differs from its discipline-off twin ONLY by the five edits', (o) => {
    expect(undoV7(sentinelSystemPrompt(o))).toBe(sentinelSystemPrompt({ ...o, discipline: false }));
  });

  it('v7 is v5 plus only the five edits; v8 is v6 plus only the five edits (hash-pinned)', () => {
    expect(sha(undoV7(SENTINEL_SYSTEM_PROMPT))).toBe(MAIN_V5_SHA256);
    expect(sha(undoV7(SENTINEL_SYSTEM_PROMPT_NO_CUES))).toBe(MAIN_V2_2_SHA256);
    expect(sha(undoV7(sentinelSystemPrompt({ cues: true, triggers: true, discipline: true })))).toBe(PT_V6_SHA256);
  });

  it.each(ALL.filter(([o]) => o.triggers))('%j: the rules exactly once and the v6 ownership line', (o) => {
    const prompt = sentinelSystemPrompt(o);
    expect(prompt.split(EXIT_TRIGGER_RULES)).toHaveLength(2);
    expect(prompt.split('\n')).toContain(V6_OWNERSHIP_LINE);
  });

  it('the default constants are discipline on, triggers off', () => {
    expect(SENTINEL_SYSTEM_PROMPT).toBe(sentinelSystemPrompt({ cues: true, triggers: false, discipline: true }));
    expect(SENTINEL_SYSTEM_PROMPT_NO_CUES).toBe(sentinelSystemPrompt({ cues: false, triggers: false, discipline: true }));
    expect(SENTINEL_PROMPT_VERSION).toBe('v7');
    expect(SENTINEL_PROMPT_VERSION_NO_CUES).toBe('v2.4');
  });

  it.each([
    [{}, 'v2.4', { cues: false, triggers: false, discipline: true }],
    [{ MARKET_CUES_ENABLED: 'true' }, 'v7', { cues: true, triggers: false, discipline: true }],
    [{ MARKET_CUES_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true' }, 'v8', { cues: true, triggers: true, discipline: true }],
    [{ SENTINEL_TRIGGERS_ENABLED: 'true', EXIT_DISCIPLINE_ENABLED: 'false' }, 'v2.3', { cues: false, triggers: true, discipline: false }],
    [{ MARKET_CUES_ENABLED: 'true', EXIT_DISCIPLINE_ENABLED: 'false' }, 'v5', { cues: true, triggers: false, discipline: false }],
    // Only the exact word turns triggers on (as the executor's watcher reads it); a typo
    // keeps discipline ON (as every other reader of EXIT_DISCIPLINE_ENABLED does).
    [{ SENTINEL_TRIGGERS_ENABLED: 'TRUE', EXIT_DISCIPLINE_ENABLED: 'flase' }, 'v2.4', { cues: false, triggers: false, discipline: true }],
  ] as const)('the agent under %j sends the matching text and stamps %s', async (env, stamp, o) => {
    const c = jest.fn().mockResolvedValue(reply(validVerdict));
    const agent = new SentinelAgentService({ messages: { create: c } } as never, { get: (k: string) => (env as Record<string, string>)[k] } as never);
    await agent.judge(packet());
    expect(c.mock.calls[0][0].system[0].text).toBe(sentinelSystemPrompt(o));
    expect(agent.promptVersion).toBe(`${stamp}/${THESIS_PROMPT_VERSION}`);
  });

  it('a verdict citing flow.noiseUnit and money.floorBasis validates; an invented child of money is still rejected', async () => {
    const create = jest.fn();
    const agent = new SentinelAgentService({ messages: { create } } as never);
    const p = packet({
      money: { ...base.money, floorBasis: 'noise' },
      flow: { ...base.flow, noiseUnit: present({ contract: { n: 4.5, method: 'atr14-1m', bars: 20, at: AT }, underlying: null }, 'exit-discipline noise unit', AT) },
    });
    create.mockResolvedValue(reply({ ...validVerdict, evidence: ['flow.noiseUnit', 'money.floorBasis'] }));
    await expect(agent.judge(p)).resolves.toMatchObject({ evidence: ['flow.noiseUnit', 'money.floorBasis'] });
    create.mockResolvedValue(reply({ ...validVerdict, evidence: ['money.noiseFloor'] }));
    await expect(agent.judge(p)).rejects.toThrow(/money\.noiseFloor/);
  });
});
