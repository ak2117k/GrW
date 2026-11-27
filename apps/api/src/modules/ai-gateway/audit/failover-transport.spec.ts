import { Logger } from '@nestjs/common';
import {
  aiFailoverOn,
  aiHealthOf,
  AllRoutesFailedError,
  directOrFailoverTransport,
  failoverChainFrom,
  failoverTransport,
  NO_AI_HEALTH,
} from './failover-transport';
import type { ClaudeCliTransport } from '../providers/claude-cli.provider';
import type { MessagesTransport, TransportMessage, TransportRequest } from '../transport.types';

const REQ = {
  model: 'claude-opus-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
} as unknown as TransportRequest;

function reply(text: string, stop: string | null = 'end_turn'): TransportMessage {
  return { stop_reason: stop, content: [{ type: 'text', text }] };
}

function ok(text: string, stop: string | null = 'end_turn'): MessagesTransport & { create: jest.Mock } {
  const create = jest.fn().mockResolvedValue(reply(text, stop));
  return { messages: { create }, create };
}

function failing(msg: string): MessagesTransport & { create: jest.Mock } {
  const create = jest.fn().mockRejectedValue(new Error(msg));
  return { messages: { create }, create };
}

describe('failoverTransport', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('the first route answers → the second is never called', async () => {
    const a = ok('A');
    const b = ok('B');
    const t = failoverTransport([{ name: 'vertex', transport: a }, { name: 'cli', transport: b }]);
    const res = await t.messages.create(REQ);
    expect(res).toEqual(reply('A'));
    expect(a.create).toHaveBeenCalledWith(REQ);
    expect(b.create).not.toHaveBeenCalled();
  });

  it('the first throws → the second answers and its reply is returned', async () => {
    const a = failing('vertex 503');
    const b = ok('B');
    const t = failoverTransport([{ name: 'vertex', transport: a }, { name: 'cli', transport: b }]);
    const res = await t.messages.create(REQ);
    expect(res).toEqual(reply('B'));
    expect(a.create).toHaveBeenCalledTimes(1);
    expect(b.create).toHaveBeenCalledWith(REQ);
  });

  it('a refusal reply is returned, not failed over (a refusal is an answer)', async () => {
    const a = ok('no', 'refusal');
    const b = ok('B');
    const t = failoverTransport([{ name: 'vertex', transport: a }, { name: 'cli', transport: b }]);
    const res = await t.messages.create(REQ);
    expect(res.stop_reason).toBe('refusal');
    expect(b.create).not.toHaveBeenCalled();
  });

  it('after failuresToSkip (default 3) consecutive failures the route is skipped for skipMs (default 180 000), then tried again', async () => {
    let now = 1_000_000;
    const a = failing('down');
    const b = ok('B');
    const t = failoverTransport([{ name: 'vertex', transport: a }, { name: 'cli', transport: b }], { clock: () => now });
    for (let i = 0; i < 3; i++) await t.messages.create(REQ);
    expect(a.create).toHaveBeenCalledTimes(3);

    now += 179_999;
    await t.messages.create(REQ);
    expect(a.create).toHaveBeenCalledTimes(3); // skipped

    now += 1;
    a.create.mockResolvedValueOnce(reply('A back'));
    const res = await t.messages.create(REQ);
    expect(a.create).toHaveBeenCalledTimes(4); // tried again
    expect(res).toEqual(reply('A back'));
  });

  it('a success resets the consecutive-failure count', async () => {
    const now = 0;
    const a = failing('down');
    const b = ok('B');
    const t = failoverTransport([{ name: 'vertex', transport: a }, { name: 'cli', transport: b }], { clock: () => now });
    await t.messages.create(REQ);
    await t.messages.create(REQ);
    a.create.mockResolvedValueOnce(reply('A'));
    await t.messages.create(REQ);
    await t.messages.create(REQ);
    await t.messages.create(REQ);
    expect(a.create).toHaveBeenCalledTimes(5); // 2 fail, 1 ok, 2 fail — never 3 in a row, never skipped
  });

  it('honours custom failuresToSkip / skipMs', async () => {
    let now = 0;
    const a = failing('down');
    const b = ok('B');
    const t = failoverTransport([{ name: 'vertex', transport: a }, { name: 'cli', transport: b }], {
      failuresToSkip: 1,
      skipMs: 10,
      clock: () => now,
    });
    await t.messages.create(REQ);
    await t.messages.create(REQ);
    expect(a.create).toHaveBeenCalledTimes(1);
    now = 10;
    await t.messages.create(REQ);
    expect(a.create).toHaveBeenCalledTimes(2);
  });

  it('all routes throw → AllRoutesFailedError listing each route, onAllFailed called, allDownSince until a success resets it', async () => {
    let now = 5_000;
    const a = failing('vertex 503');
    const b = failing('cli expired');
    const onAllFailed = jest.fn();
    const t = failoverTransport([{ name: 'vertex', transport: a }, { name: 'cli', transport: b }], {
      clock: () => now,
      onAllFailed,
    });
    expect(t.allDownSince()).toBeNull();

    const err = await t.messages.create(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllRoutesFailedError);
    expect((err as AllRoutesFailedError).errors).toEqual(['vertex: vertex 503', 'cli: cli expired']);
    expect((err as Error).message).toContain('vertex: vertex 503');
    expect((err as Error).message).toContain('cli: cli expired');
    expect(onAllFailed).toHaveBeenCalledWith(['vertex: vertex 503', 'cli: cli expired']);
    expect(t.allDownSince()).toBe(5_000);

    now = 9_000;
    await expect(t.messages.create(REQ)).rejects.toBeInstanceOf(AllRoutesFailedError);
    expect(t.allDownSince()).toBe(5_000); // the FIRST all-fail time

    b.create.mockResolvedValueOnce(reply('B'));
    await t.messages.create(REQ);
    expect(t.allDownSince()).toBeNull();
  });

  it('when every route is in its skip window it still tries them all rather than failing without a call', async () => {
    const now = 0;
    const a = failing('a down');
    const b = failing('b down');
    const t = failoverTransport([{ name: 'vertex', transport: a }, { name: 'cli', transport: b }], {
      failuresToSkip: 1,
      clock: () => now,
    });
    await expect(t.messages.create(REQ)).rejects.toBeInstanceOf(AllRoutesFailedError);
    b.create.mockResolvedValueOnce(reply('B'));
    const res = await t.messages.create(REQ);
    expect(res).toEqual(reply('B'));
    expect(a.create).toHaveBeenCalledTimes(2);
  });

  it('a skipped route is listed in the all-failed errors', async () => {
    const now = 0;
    const a = failing('a down');
    const b = ok('B');
    const t = failoverTransport([{ name: 'vertex', transport: a }, { name: 'cli', transport: b }], {
      failuresToSkip: 1,
      clock: () => now,
    });
    await t.messages.create(REQ); // vertex fails (now skipped), cli answers
    b.create.mockRejectedValueOnce(new Error('b down'));
    const err = (await t.messages.create(REQ).catch((e: unknown) => e)) as AllRoutesFailedError;
    expect(err).toBeInstanceOf(AllRoutesFailedError);
    expect(a.create).toHaveBeenCalledTimes(1);
    expect(err.errors[0]).toMatch(/^vertex: skipped/);
    expect(err.errors[1]).toBe('cli: b down');
  });
});

describe('failoverChainFrom', () => {
  it("defaults to ['vertex','cli']", () => {
    expect(failoverChainFrom({})).toEqual(['vertex', 'cli']);
  });
  it("appends 'api' when ANTHROPIC_API_KEY is set", () => {
    expect(failoverChainFrom({ ANTHROPIC_API_KEY: 'x' })).toEqual(['vertex', 'cli', 'api']);
  });
  it('does not append api when the key is blank', () => {
    expect(failoverChainFrom({ ANTHROPIC_API_KEY: '  ' })).toEqual(['vertex', 'cli']);
  });
  it('reads AI_FAILOVER_CHAIN, ignores unknown names and duplicates', () => {
    expect(failoverChainFrom({ AI_FAILOVER_CHAIN: ' CLI, vertex,bogus,cli ' })).toEqual(['cli', 'vertex']);
  });
  it('does not append api twice when listed', () => {
    expect(failoverChainFrom({ AI_FAILOVER_CHAIN: 'api,vertex', ANTHROPIC_API_KEY: 'x' })).toEqual(['api', 'vertex']);
  });
  it('an all-invalid chain falls back to the default', () => {
    expect(failoverChainFrom({ AI_FAILOVER_CHAIN: 'nope' })).toEqual(['vertex', 'cli']);
  });
});

describe('directOrFailoverTransport', () => {
  const cli = { messages: { create: jest.fn() } } as unknown as ClaudeCliTransport;
  const base = { cli, apiKey: undefined, record: false, audit: { insert: async () => undefined }, jobOf: () => 'job' };

  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('off (TRADE_AGENT_AUTHORITY unset): exactly what directRecordedTransport returns today', () => {
    const t = directOrFailoverTransport({ ...base, judge: 'cli', env: {}, caller: 'test' });
    expect(t).toBe(cli); // unrecorded CLI path returns the shared CLI transport itself
    expect(aiHealthOf(t).allDownSince()).toBeNull();
  });

  it('off (AI_FAILOVER=off with authority live): unchanged', () => {
    const t = directOrFailoverTransport({
      ...base,
      judge: 'cli',
      env: { TRADE_AGENT_AUTHORITY: 'live', AI_FAILOVER: 'off' },
      caller: 'test',
    });
    expect(t).toBe(cli);
  });

  it('on: a failover transport over the chain, CLI answering when Vertex fails', async () => {
    const t = directOrFailoverTransport({
      ...base,
      judge: 'api',
      env: { AI_FAILOVER: 'on', AI_FAILOVER_CHAIN: 'cli' },
      caller: 'test',
    });
    (cli.messages.create as jest.Mock).mockResolvedValueOnce(reply('C'));
    expect(t).not.toBe(cli);
    expect(await t.messages.create(REQ)).toEqual(reply('C'));
    expect(aiHealthOf(t).allDownSince()).toBeNull();
  });
});

describe('aiHealthOf', () => {
  it('a plain transport → never all down', () => {
    expect(aiHealthOf({ messages: { create: jest.fn() } }).allDownSince()).toBeNull();
    expect(aiHealthOf(null)).toBe(NO_AI_HEALTH);
  });
});

describe('aiFailoverOn', () => {
  it('off by default (TRADE_AGENT_AUTHORITY off/unset)', () => {
    expect(aiFailoverOn({})).toBe(false);
    expect(aiFailoverOn({ TRADE_AGENT_AUTHORITY: 'off' })).toBe(false);
    expect(aiFailoverOn({ TRADE_AGENT_AUTHORITY: 'shadow' })).toBe(false);
  });
  it('on by default when TRADE_AGENT_AUTHORITY=live', () => {
    expect(aiFailoverOn({ TRADE_AGENT_AUTHORITY: 'live' })).toBe(true);
  });
  it('AI_FAILOVER=on|off overrides the default', () => {
    expect(aiFailoverOn({ AI_FAILOVER: 'on' })).toBe(true);
    expect(aiFailoverOn({ AI_FAILOVER: ' OFF ', TRADE_AGENT_AUTHORITY: 'live' })).toBe(false);
    expect(aiFailoverOn({ AI_FAILOVER: 'junk', TRADE_AGENT_AUTHORITY: 'live' })).toBe(true);
    expect(aiFailoverOn({ AI_FAILOVER: 'junk' })).toBe(false);
  });
});
