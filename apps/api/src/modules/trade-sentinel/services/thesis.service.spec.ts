import { Logger, NotFoundException } from '@nestjs/common';
import { APIConnectionError, RateLimitError } from '@anthropic-ai/sdk';
import { ThesisService, THESIS_MAX_TOKENS } from './thesis.service';
import type { ThesisDraft } from '../repositories/sentinel-thesis.repository';
import type { ChartContextShim, TickSnapshot } from './context-packet.service';
import type { RosterEntry } from './roster.service';

const stored = {
  direction: 'LONG',
  reason: 'bought the demand zone',
  levelPrice: 1450,
  targetPrice: 1520,
  invalidation: 1440,
  source: 'INFERRED',
};

/**
 * ANNOTATED, not asserted. `as RosterEntry` would tolerate a rename in the
 * roster; the annotation makes one a compile error here.
 */
const entry: RosterEntry = {
  userId: 'u1',
  trackerId: 't1',
  symbol: 'INFY',
  kind: 'POSITION',
  ownership: 'SENTINEL',
  watched: true,
  reason: 'unowned position — sentinel claims it',
};

const ENTRY_TIME = new Date('2026-08-13T04:15:00.000Z');

const tick: TickSnapshot = {
  segment: 'EQ_DELIVERY',
  side: 'LONG',
  // Cash: the tradingsymbol IS the level book's key, so it matches entry.symbol.
  structureSymbol: 'INFY',
  entryPrice: 1455,
  qty: 10,
  ltp: 1470,
  underlyingLtp: 1470,
  underlyingLtpAt: null,
  nearestSupport: 1450,
  nearestResistance: 1500,
  structureReason: null,
  structureAt: null,
  structureSource: 'signal-generator.analyze (15m level book)',
  holdingHigh: 1478,
  holdingLow: 1449,
  entryTime: ENTRY_TIME,
  expiry: null,
  volumeRatio: 1.4,
  freshNewsCount: 0,
  factorValues: {},
  factorsReason: null,
  oiWallNow: null,
  oiWallPrev: null,
  oiWallsAt: null,
  greenFloorArmedLatched: false,
};

/** The model's reply, wrapped as the SDK returns it. */
const reply = (obj: unknown, stop_reason = 'end_turn') => ({
  stop_reason,
  content: [{ type: 'text', text: JSON.stringify(obj) }],
});

const goodDraft = {
  direction: 'LONG',
  reason: 'bought the demand zone',
  levelPrice: 1450,
  targetPrice: 1520,
  invalidation: 1440,
};

describe('ThesisService', () => {
  const find = jest.fn();
  const upsertInferred = jest.fn();
  const overrideByUser = jest.fn();
  const repo = { find, upsertInferred, overrideByUser } as never;
  const create = jest.fn();
  const client = { messages: { create } } as never;
  const levelsFor = jest.fn();
  const chartContext: ChartContextShim = { levelsFor };
  const svc = new ThesisService(repo, client, chartContext);

  let warned: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    levelsFor.mockResolvedValue(null);
    // Every degraded path logs; silence the output but keep it assertable.
    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warned.mockRestore());

  /** The draft handed to the repository on the last call. */
  const savedDraft = (): ThesisDraft => upsertInferred.mock.calls[0][1] as ThesisDraft;

  describe('reusing what is already known', () => {
    it('reuses a stored thesis instead of inferring again', async () => {
      find.mockResolvedValue(stored);

      const result = await svc.ensureFor(entry, tick);

      expect(result).toEqual(stored);
      expect(create).not.toHaveBeenCalled();
      expect(upsertInferred).not.toHaveBeenCalled();
    });

    it('re-infers over a stated-unknown thesis on a later tick', async () => {
      // A thirty-second outage must not blind the watch permanently. Without
      // this the placeholder is written once, `find` returns it forever, and
      // the position is watched against a thesis that cannot answer the only
      // question this service exists to answer.
      find.mockResolvedValue({
        direction: 'LONG',
        reason:
          'thesis could not be inferred — could not reach the Anthropic API. The intent ' +
          'behind this LONG position is UNKNOWN; do not read it as a confirmed setup.',
        levelPrice: null,
        targetPrice: null,
        invalidation: null,
        source: 'INFERRED',
      });
      create.mockResolvedValue(reply(goodDraft));
      upsertInferred.mockResolvedValue(stored);

      const result = await svc.ensureFor(entry, tick);

      expect(create).toHaveBeenCalledTimes(1);
      expect(result).toEqual(stored);
    });

    it('leaves a real thesis alone even when it talks about inference', async () => {
      // `startsWith`, not `includes`: a genuine thesis is not discarded because
      // its prose happens to contain the placeholder's words.
      find.mockResolvedValue({
        ...stored,
        reason: 'bought the demand zone; the thesis could not be inferred from volume alone',
      });

      await svc.ensureFor(entry, tick);

      expect(create).not.toHaveBeenCalled();
    });

    it('never re-infers over a USER thesis even if it reads as unknown', async () => {
      // The retry predicate must be guarded by source, not by text alone —
      // otherwise a user who typed the placeholder wording loses their own
      // correction on the next tick.
      find.mockResolvedValue({
        ...stored,
        source: 'USER',
        reason: 'thesis could not be inferred — I honestly do not remember why I took this',
      });

      const result = await svc.ensureFor(entry, tick);

      expect(create).not.toHaveBeenCalled();
      expect(result.source).toBe('USER');
    });

    it('never re-infers over a thesis the user corrected', async () => {
      // The service must not reach the API at all here: even an inference that
      // the repository would refuse to store still costs a call and still risks
      // a race window that the predicate cannot cover.
      find.mockResolvedValue({ ...stored, source: 'USER', reason: 'momentum breakout' });

      const result = await svc.ensureFor(entry, tick);

      expect(result.source).toBe('USER');
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('inferring on first sight', () => {
    beforeEach(() => {
      find.mockResolvedValue(null);
      upsertInferred.mockImplementation(async (_id: string, d: ThesisDraft) => ({
        direction: d.direction,
        reason: d.reason,
        levelPrice: d.levelPrice,
        targetPrice: d.targetPrice,
        invalidation: d.invalidation,
        source: 'INFERRED',
      }));
    });

    it('infers and stores a thesis the first time it sees a position', async () => {
      create.mockResolvedValue(reply(goodDraft));

      const result = await svc.ensureFor(entry, tick);

      expect(create).toHaveBeenCalledTimes(1);
      expect(upsertInferred).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          userId: 'u1',
          direction: 'LONG',
          reason: 'bought the demand zone',
          levelPrice: 1450,
          targetPrice: 1520,
          invalidation: 1440,
        }),
      );
      expect(result).toEqual(stored);
    });

    it('asks for the thesis schema with room for thinking plus the reply', async () => {
      create.mockResolvedValue(reply(goodDraft));
      await svc.ensureFor(entry, tick);

      const args = create.mock.calls[0][0];
      expect(args.model).toBe('claude-opus-5');
      // max_tokens caps thinking AND response together on this model.
      expect(args.max_tokens).toBe(THESIS_MAX_TOKENS);
      expect(args.output_config.format.type).toBe('json_schema');
      expect(args.output_config.format.schema.additionalProperties).toBe(false);
      expect(args.output_config.format.schema.required).toEqual(
        expect.arrayContaining([
          'direction',
          'reason',
          'levelPrice',
          'targetPrice',
          'invalidation',
        ]),
      );
      expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('puts the position in the user turn so the prompt prefix stays cacheable', async () => {
      create.mockResolvedValue(reply(goodDraft));
      await svc.ensureFor(entry, tick);

      const args = create.mock.calls[0][0];
      expect(args.messages[0].role).toBe('user');
      const payload = JSON.parse(args.messages[0].content);
      expect(payload).toMatchObject({
        symbol: 'INFY',
        side: 'LONG',
        entryPrice: 1455,
        qty: 10,
        entryTime: ENTRY_TIME.toISOString(),
      });
      // A per-position fact in the cached prefix means the cache never reads.
      expect(args.system[0].text).not.toContain('INFY');
    });

    it('tells the model in so many words when there is no structure to read', async () => {
      levelsFor.mockResolvedValue(null);
      create.mockResolvedValue(reply(goodDraft));
      await svc.ensureFor(entry, tick);

      const payload = JSON.parse(create.mock.calls[0][0].messages[0].content);
      // Absent evidence must arrive AS an absence with a reason — omitting the
      // key would have the model infer a level book it never saw.
      expect(payload.structure.available).toBe(false);
      expect(payload.structure.reason).toMatch(/level book/i);
    });

    it('passes the level book through with its own provenance when there is one', async () => {
      levelsFor.mockResolvedValue({
        value: [{ price: 1450, kind: 'SUPPORT' }],
        source: 'chart-context.service (1d)',
        at: '2026-08-14T04:00:00.000Z',
      });
      create.mockResolvedValue(reply(goodDraft));
      await svc.ensureFor(entry, tick);

      const payload = JSON.parse(create.mock.calls[0][0].messages[0].content);
      expect(payload.structure).toEqual({
        available: true,
        value: [{ price: 1450, kind: 'SUPPORT' }],
        // The interval the book was built from lives in the shim's own source,
        // not in a constant here — two books of different intervals must not
        // arrive labelled identically.
        source: 'chart-context.service (1d)',
        at: '2026-08-14T04:00:00.000Z',
      });
      // Cash: `structureSymbol` and the tradingsymbol are the same string.
      expect(levelsFor).toHaveBeenCalledWith('INFY');
    });

    it('looks the structure up by structureSymbol, NOT by the roster symbol', async () => {
      // A derivative: the roster keeps the broker's tradingsymbol, but the
      // level book is keyed by the underlying. The thesis is what every later
      // "has it turned?" judgement is measured against, so inferring it from a
      // structure block that silently never loaded is the worst place in the
      // module for this to go wrong.
      levelsFor.mockResolvedValue({ value: [1], source: 'chart-context.service (15m)' });
      create.mockResolvedValue(reply(goodDraft));

      await svc.ensureFor(
        { ...entry, symbol: 'NIFTY28AUG2524000CE' },
        { ...tick, structureSymbol: 'NIFTY' },
      );

      expect(levelsFor).toHaveBeenCalledWith('NIFTY');
      expect(levelsFor).not.toHaveBeenCalledWith('NIFTY28AUG2524000CE');
      // The model is still told which CONTRACT it is reading — only the
      // structure lookup uses the underlying.
      const payload = JSON.parse(create.mock.calls[0][0].messages[0].content);
      expect(payload.symbol).toBe('NIFTY28AUG2524000CE');
    });

    it('asks nothing at all when the underlying is unresolved, and says why', async () => {
      create.mockResolvedValue(reply(goodDraft));

      await svc.ensureFor(
        { ...entry, symbol: 'NIFTY28AUG2524000CE' },
        { ...tick, structureSymbol: null },
      );

      // No fallback to the tradingsymbol: that call is guaranteed to miss, and
      // the miss would be reported as "no level book for this symbol" — a claim
      // about the instrument, not about us.
      expect(levelsFor).not.toHaveBeenCalled();
      const payload = JSON.parse(create.mock.calls[0][0].messages[0].content);
      expect(payload.structure.available).toBe(false);
      expect(payload.structure.reason).toMatch(/could not be resolved/i);
      expect(payload.structure.reason).toMatch(/failure to look/i);
    });

    it('still infers when the level book source throws', async () => {
      levelsFor.mockRejectedValue(new Error('chart context down'));
      create.mockResolvedValue(reply(goodDraft));

      const result = await svc.ensureFor(entry, tick);

      expect(create).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(create.mock.calls[0][0].messages[0].content);
      expect(payload.structure.available).toBe(false);
      expect(payload.structure.reason).toMatch(/chart context down/);
      expect(result.reason).toBe('bought the demand zone');
    });

    it('describes nullable prices with anyOf, not a JSON Schema type array', async () => {
      // `type: ['number','null']` is outside the documented structured-outputs
      // subset and would 400 on the first LIVE call — which no test in this
      // stage makes, so only a shape assertion can catch it.
      create.mockResolvedValue(reply(goodDraft));
      await svc.ensureFor(entry, tick);

      const props = create.mock.calls[0][0].output_config.format.schema.properties;
      for (const field of ['levelPrice', 'targetPrice', 'invalidation']) {
        expect(props[field]).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }] });
        expect(Array.isArray(props[field].type)).toBe(false);
      }
      // The enum field is a plain scalar type and must stay that way.
      expect(props.direction).toEqual({ type: 'string', enum: ['LONG', 'SHORT'] });
    });

    it('takes the tenant from the roster entry rather than a defaulted argument', async () => {
      create.mockResolvedValue(reply(goodDraft));
      await svc.ensureFor({ ...entry, userId: 'u-tenant-9' }, tick);
      // An empty userId writes a row no tenant owns, and `upsertInferred`'s
      // data spread would clobber a good value with it on re-inference.
      expect(savedDraft().userId).toBe('u-tenant-9');
    });

    it('takes direction from the broker, not from the model', async () => {
      // Side is an observed fact off the position. A thesis whose direction
      // disagrees with the position inverts every later "has it turned?" read,
      // so the fact wins and the disagreement is logged rather than stored.
      create.mockResolvedValue(reply({ ...goodDraft, direction: 'SHORT' }));

      const result = await svc.ensureFor(entry, tick);

      expect(result.direction).toBe('LONG');
      expect(warned).toHaveBeenCalledWith(expect.stringMatching(/direction/i));
      // "the structure at entry reads short, but you are long" is arguably more
      // useful to the user than the thesis prose, and a log line surfaces to
      // nobody — so it is returned for Task 12 as well as logged.
      expect(result.modelDirectionDisagreed).toBe(true);
    });

    it('does not claim a disagreement when the model agreed', async () => {
      create.mockResolvedValue(reply(goodDraft));

      const result = await svc.ensureFor(entry, tick);

      // Absent, never `false`. There is no column for this, so on a later tick
      // (where nothing was inferred) a `false` would read as "the model agreed"
      // when it means "nobody asked".
      expect(result.modelDirectionDisagreed).toBeUndefined();
      expect('modelDirectionDisagreed' in result).toBe(false);
    });

    it('reports no disagreement when the reading never happened', async () => {
      create.mockRejectedValue(new Error('api down'));

      const result = await svc.ensureFor(entry, tick);

      expect(result.modelDirectionDisagreed).toBeUndefined();
    });

    it('infers a SHORT position without flipping any of its numbers', async () => {
      const shortTick: TickSnapshot = { ...tick, side: 'SHORT', entryPrice: 1500, ltp: 1480 };
      create.mockResolvedValue(
        reply({
          direction: 'SHORT',
          reason: 'faded the supply shelf',
          levelPrice: 1500,
          targetPrice: 1400,
          invalidation: 1520,
        }),
      );

      const result = await svc.ensureFor(entry, shortTick);

      expect(result).toMatchObject({
        direction: 'SHORT',
        targetPrice: 1400,
        invalidation: 1520,
      });
      expect(JSON.parse(create.mock.calls[0][0].messages[0].content).side).toBe('SHORT');
    });
  });

  describe('a failed inference must never stop the watching', () => {
    beforeEach(() => {
      find.mockResolvedValue(null);
      upsertInferred.mockImplementation(async (_id: string, d: ThesisDraft) => ({
        direction: d.direction,
        reason: d.reason,
        levelPrice: d.levelPrice,
        targetPrice: d.targetPrice,
        invalidation: d.invalidation,
        source: 'INFERRED',
      }));
    });

    it('falls back to a stated-unknown thesis rather than throwing when inference fails', async () => {
      create.mockRejectedValue(new Error('api down'));

      const result = await svc.ensureFor(entry, tick);

      expect(result.reason).toMatch(/could not be inferred/i);
      expect(result.levelPrice).toBeNull();
      expect(result.targetPrice).toBeNull();
      expect(result.invalidation).toBeNull();
      // Still the position's real side: the fallback is an unknown INTENT, not
      // an unknown position.
      expect(result.direction).toBe('LONG');
    });

    it('persists the unknown thesis so the position is watched from the next tick on', async () => {
      create.mockRejectedValue(new Error('api down'));
      await svc.ensureFor(entry, tick);
      expect(upsertInferred).toHaveBeenCalledWith('t1', expect.objectContaining({ userId: 'u1' }));
    });

    it('warns the agent not to read the unknown thesis as a confirmed setup', async () => {
      create.mockRejectedValue(new Error('api down'));
      const result = await svc.ensureFor(entry, tick);
      // This string is fed verbatim to the sentinel agent. "no thesis" read as
      // an empty thesis is the same confident-from-nothing failure the packet's
      // block design exists to prevent.
      expect(result.reason).toMatch(/unknown/i);
    });

    it.each([
      ['a rate limit', new RateLimitError(429, undefined, 'quota exhausted', new Headers()), /rate limited/i],
      ['a transport failure', new APIConnectionError({ message: 'ECONNRESET' }), /could not reach/i],
    ])('names %s by the SDK exception class, not by its message', async (_label, err, matcher) => {
      create.mockRejectedValue(err);

      const result = await svc.ensureFor(entry, tick);

      // The messages deliberately say nothing about the category; only the
      // CLASS identifies it. String-matching err.message must fail this.
      expect(result.reason).toMatch(matcher);
      expect(warned).toHaveBeenCalledWith(expect.stringMatching(matcher));
    });

    it('reports a truncated reply as a budget failure, not a parse failure', async () => {
      create.mockResolvedValue({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '{"direction":"LO' }],
      });

      const result = await svc.ensureFor(entry, tick);

      expect(result.reason).toMatch(/truncated/i);
      expect(result.reason).not.toMatch(/not JSON/i);
      expect(result.levelPrice).toBeNull();
    });

    it('reports an over-long request as a context-window failure', async () => {
      create.mockResolvedValue({ stop_reason: 'model_context_window_exceeded', content: [] });
      const result = await svc.ensureFor(entry, tick);
      expect(result.reason).toMatch(/context window/i);
    });

    it('reports a refusal as a refusal', async () => {
      create.mockResolvedValue({ stop_reason: 'refusal', content: [] });
      const result = await svc.ensureFor(entry, tick);
      expect(result.reason).toMatch(/refused/i);
    });

    it.each([
      ['no text block', { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hm' }] }],
      ['prose instead of JSON', { stop_reason: 'end_turn', content: [{ type: 'text', text: 'they bought support' }] }],
      ['JSON that is not an object', { stop_reason: 'end_turn', content: [{ type: 'text', text: 'null' }] }],
    ])('degrades to unknown on %s', async (_label, response) => {
      create.mockResolvedValue(response);
      const result = await svc.ensureFor(entry, tick);
      expect(result.reason).toMatch(/could not be inferred/i);
      expect(result.levelPrice).toBeNull();
    });

    it.each([
      ['a blank reason', { ...goodDraft, reason: '   ' }],
      ['a missing reason', { direction: 'LONG', levelPrice: 1450, targetPrice: 1520, invalidation: 1440 }],
      ['a price sent as a string', { ...goodDraft, levelPrice: '1450' }],
      ['a price sent as an object', { ...goodDraft, targetPrice: { value: 1520 } }],
      ['a direction outside the enum', { ...goodDraft, direction: 'FLAT' }],
    ])('degrades to unknown rather than storing %s', async (_label, body) => {
      create.mockResolvedValue(reply(body));

      const result = await svc.ensureFor(entry, tick);

      expect(result.reason).toMatch(/could not be inferred/i);
      // A '1450' string stored in a Float column is the kind of thing that
      // reads back fine and breaks arithmetic three modules downstream.
      expect(savedDraft().levelPrice).toBeNull();
      expect(savedDraft().targetPrice).toBeNull();
    });

    it('accepts a thesis the model could not put prices on', async () => {
      // Explicit nulls with a stated reason are the model doing exactly what it
      // was asked, and must NOT be rejected as malformed.
      create.mockResolvedValue(
        reply({
          direction: 'LONG',
          reason: 'no clean structure at entry — looks like a discretionary add',
          levelPrice: null,
          targetPrice: null,
          invalidation: null,
        }),
      );

      const result = await svc.ensureFor(entry, tick);

      expect(result.reason).toBe('no clean structure at entry — looks like a discretionary add');
      expect(result.reason).not.toMatch(/could not be inferred/i);
    });
  });

  describe('a failed store must never stop the watching either', () => {
    it('returns an unknown thesis without calling the API when the store is unreachable', async () => {
      find.mockRejectedValue(new Error('connection refused'));

      const result = await svc.ensureFor(entry, tick);

      expect(result.reason).toMatch(/could not be inferred/i);
      expect(result.reason).toMatch(/connection refused/);
      // Spending an API call while unable to read whether a USER correction
      // exists risks overwriting it AND cannot be persisted anyway.
      expect(create).not.toHaveBeenCalled();
      expect(upsertInferred).not.toHaveBeenCalled();
    });

    it('returns the thesis it inferred when the write fails', async () => {
      find.mockResolvedValue(null);
      create.mockResolvedValue(reply(goodDraft));
      upsertInferred.mockRejectedValue(new Error('write failed'));

      const result = await svc.ensureFor(entry, tick);

      // Unpersisted, so the next tick infers again — but the position is
      // watched THIS tick, which is the whole point.
      expect(result).toEqual(stored);
      expect(warned).toHaveBeenCalledWith(expect.stringMatching(/write failed/));
    });
  });

  describe('user correction', () => {
    it('marks a user correction as USER so it outranks future inference', async () => {
      overrideByUser.mockResolvedValue({ ...stored, source: 'USER', reason: 'momentum breakout' });

      const result = await svc.correct('t1', 'u1', { reason: 'momentum breakout' });

      expect(result.source).toBe('USER');
      // The tenant reaches the repository, where it scopes the write. Dropping
      // it here would make the repository's `where` unsatisfiable-by-accident
      // rather than tenant-scoped-by-design.
      expect(overrideByUser).toHaveBeenCalledWith('t1', 'u1', { reason: 'momentum breakout' });
    });

    it('lets a correction failure surface instead of pretending it was saved', async () => {
      const boom = new NotFoundException('no thesis on record');
      overrideByUser.mockRejectedValue(boom);
      // Unlike inference, this one is a user action with a user watching it —
      // a silent no-op would leave them believing a wrong thesis was fixed.
      await expect(svc.correct('t1', 'u1', { reason: 'x' })).rejects.toBe(boom);
    });
  });
});
