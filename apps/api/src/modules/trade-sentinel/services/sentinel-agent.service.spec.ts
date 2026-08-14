import { Logger } from '@nestjs/common';
import { APIConnectionError, RateLimitError } from '@anthropic-ai/sdk';
import { SentinelAgentService, type Verdict } from './sentinel-agent.service';
import { absent, present, type ContextPacket } from './context-packet.service';
import { SENTINEL_SYSTEM_PROMPT } from '../prompts/sentinel-system-prompt';

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

  it('returns the parsed verdict on a well-formed reply', async () => {
    create.mockResolvedValue(reply(validVerdict));
    await expect(svc.judge(packet())).resolves.toMatchObject({
      verdict: 'HOLD',
      confidence: 'high',
      evidence: ['structure.nearestSupport', 'money.netPnl'],
    });
  });

  it('sends the packet as the user turn and caches the system prompt', async () => {
    create.mockResolvedValue(reply(validVerdict));
    await svc.judge(packet());
    const args = create.mock.calls[0][0];
    expect(args.model).toBe('claude-opus-5');
    expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(args.system[0].text).toBe(SENTINEL_SYSTEM_PROMPT);
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
