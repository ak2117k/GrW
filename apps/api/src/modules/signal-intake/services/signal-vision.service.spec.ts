import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { readVisionReply, SIGNAL_VISION_SCHEMA, SIGNAL_VISION_SCHEMA_LEGACY, SIGNAL_VISION_SYSTEM, SIGNAL_VISION_SYSTEM_LEGACY } from '../domain/llm-schema';
import { parseSignalIntakeConfig } from '../signal-intake.config';
import { isRequestRejected, SIGNAL_VISION_JOB, SignalVisionService, visionModelFor, visionTransportState } from './signal-vision.service';

describe('readVisionReply — strict schema', () => {
  const sig = { underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, expiry: null, side: 'BUY', entryType: 'AT', entryLow: 120, entryHigh: 120, sl: 100, targets: [150], qty: null, horizon: 'INTRADAY', confidence: 0.8 };

  it('the schema requires kind (SIGNAL | UPDATE | INFO | NOISE) and INFO items on top of the text schema', () => {
    expect(SIGNAL_VISION_SCHEMA.required).toEqual(['kind', 'isSignal', 'signals', 'items', 'shownTime', 'description', 'instruments', 'bias', 'levels']);
    expect(SIGNAL_VISION_SCHEMA.properties.kind.enum).toEqual(['SIGNAL', 'UPDATE', 'INFO', 'NOISE']);
  });

  it('INFO (and the legacy VIEW of cached replies) carries its items, never a signal', () => {
    const item = { underlying: 'NIFTY', bias: 'BULL', levels: [22400] };
    expect(readVisionReply(JSON.stringify({ kind: 'INFO', isSignal: true, signals: [sig], items: [item] }))).toEqual({ kind: 'INFO', isSignal: false, signals: [], items: [item] });
    expect(readVisionReply(JSON.stringify({ kind: 'VIEW', isSignal: false, signals: [] }))).toEqual({ kind: 'INFO', isSignal: false, signals: [], items: [] });
  });

  it('a SIGNAL keeps its signals (fences tolerated)', () => {
    expect(readVisionReply('```json\n' + JSON.stringify({ kind: 'SIGNAL', isSignal: true, signals: [sig] }) + '\n```')).toEqual({ kind: 'SIGNAL', isSignal: true, signals: [sig], shownTime: null });
  });

  it('a screenshot call carries the time on its own message bubble, HH:MM 24-hour; junk is null', () => {
    const read = (shownTime: unknown) => readVisionReply(JSON.stringify({ kind: 'SIGNAL', isSignal: true, signals: [sig], shownTime }))?.shownTime;
    expect(read('14:34')).toBe('14:34');
    expect(read('9:05')).toBe('09:05');
    expect(read('2:34 PM')).toBeNull();
    expect(read('25:00')).toBeNull();
  });

  it.each(['NOISE', 'UPDATE'])('%s never carries a signal, even when the model filled one', (kind) => {
    expect(readVisionReply(JSON.stringify({ kind, isSignal: true, signals: [sig] }))).toEqual({ kind, isSignal: false, signals: [] });
  });

  it.each([
    ['no kind', { isSignal: false, signals: [] }],
    ['unknown kind', { kind: 'CHART', isSignal: false, signals: [] }],
    ['no signals array', { kind: 'NOISE', isSignal: false }],
  ])('%s → null', (_why, o) => expect(readVisionReply(JSON.stringify(o))).toBeNull());

  it('not JSON → null; SIGNAL with no signals is not a signal', () => {
    expect(readVisionReply('I see a chart')).toBeNull();
    expect(readVisionReply(JSON.stringify({ kind: 'SIGNAL', isSignal: true, signals: [] }))).toMatchObject({ isSignal: false });
  });
});

describe('readVisionReply — the image description (owner 2026-11-27: every image reaches the message reader)', () => {
  const desc = {
    description: 'NIFTY 15m chart, short active from ~25700, trailing stop 25720, target 25600',
    instruments: ['nifty'],
    bias: 'BEAR',
    levels: [
      { kind: 'ENTRY', price: 25700 },
      { kind: 'STOP', price: 25720 },
      { kind: 'TARGET', price: 25600 },
    ],
  };

  it('the schema requires the description fields and the prompt asks for them', () => {
    expect(SIGNAL_VISION_SCHEMA.required).toEqual(expect.arrayContaining(['description', 'instruments', 'bias', 'levels']));
    expect(SIGNAL_VISION_SCHEMA.properties.bias.enum).toEqual(['BULL', 'BEAR', 'NEUTRAL', 'NONE']);
    expect(SIGNAL_VISION_SYSTEM).toMatch(/description/);
  });

  it.each(['NOISE', 'UPDATE', 'INFO', 'SIGNAL'])('%s keeps the description, instruments (upper-case), bias and levels', (kind) => {
    const sig = { underlying: 'NIFTY', instrumentKind: 'FUT', strike: null, expiry: null, side: 'SELL', entryType: 'AT', entryLow: 25700, entryHigh: 25700, sl: 25720, targets: [25600], qty: null, horizon: 'INTRADAY', confidence: 0.8 };
    const r = readVisionReply(JSON.stringify({ kind, isSignal: kind === 'SIGNAL', signals: kind === 'SIGNAL' ? [sig] : [], items: [], shownTime: null, ...desc }));
    expect(r).toMatchObject({ kind, description: desc.description, instruments: ['NIFTY'], bias: 'BEAR', levels: desc.levels });
  });

  it('bias NONE is dropped, junk levels are dropped, an empty description is absent', () => {
    const r = readVisionReply(JSON.stringify({ kind: 'NOISE', isSignal: false, signals: [], description: '  ', instruments: [' ', 'CRUDEOIL'], bias: 'NONE', levels: [{ kind: 'STOP', price: -1 }, { kind: 'WHAT', price: 5 }, { kind: 'SUPPORT', price: 5600 }] }));
    expect(r).toEqual({ kind: 'NOISE', isSignal: false, signals: [], instruments: ['CRUDEOIL'], levels: [{ kind: 'SUPPORT', price: 5600 }] });
  });
});

describe('visionModelFor — trusted channels read with the stronger model', () => {
  it('defaults: Mr. P Investments and Stock Gainers (case-insensitive substrings) → claude-sonnet-5; others → haiku', () => {
    const cfg = parseSignalIntakeConfig({});
    expect(cfg.visionTrustedChannels).toEqual(['mr. p investments', 'stock gainers']);
    expect(cfg.visionTrustedModel).toBe('claude-sonnet-5');
    expect(visionModelFor('Mr. P Investments', cfg)).toBe('claude-sonnet-5');
    expect(visionModelFor('STOCK GAINERS (SEBI Registered)', cfg)).toBe('claude-sonnet-5');
    expect(visionModelFor('MCX Commodity', cfg)).toBe('claude-haiku-5-5');
    expect(visionModelFor(null, cfg)).toBe('claude-haiku-5-5');
  });

  it('env overrides; an empty list trusts nobody', () => {
    const cfg = parseSignalIntakeConfig({ SIGNAL_VISION_TRUSTED_CHANNELS: ' Alpha , beta ', SIGNAL_VISION_TRUSTED_MODEL: 'claude-opus-5' });
    expect(visionModelFor('the BETA desk', cfg)).toBe('claude-opus-5');
    expect(visionModelFor('Mr. P Investments', cfg)).toBe('claude-haiku-5-5');
    expect(parseSignalIntakeConfig({ SIGNAL_VISION_TRUSTED_CHANNELS: ' , ' }).visionTrustedChannels).toEqual([]);
  });
});

describe('visionTransportState', () => {
  it('cli carries images; api needs a key; bedrock is unavailable', () => {
    expect(visionTransportState({ judge: 'cli', apiKey: undefined })).toEqual({ via: 'cli', reason: null });
    expect(visionTransportState({ judge: 'api', apiKey: 'k' })).toEqual({ via: 'api', reason: null });
    expect(visionTransportState({ judge: undefined, apiKey: '' }).reason).toMatch(/no ANTHROPIC_API_KEY/);
    expect(visionTransportState({ judge: 'bedrock', apiKey: 'k' }).via).toBeNull();
  });
});

describe('SignalVisionService.classify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vision-spec-'));
  const path = join(dir, 'call.jpg');
  writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  const image = { kind: 'photo' as const, path, sha256: 'c'.repeat(64), mimeType: 'image/jpeg', bytes: 8 };

  function make(env: Record<string, string | undefined>, replyText: string) {
    const cli = {
      createWithMeta: jest.fn(async () => ({
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: replyText }] },
        meta: { inputTokens: 2, outputTokens: 41, cacheCreationInputTokens: 912, cacheReadInputTokens: 0, billed: false },
      })),
    };
    const audit = { insert: jest.fn(async () => undefined) };
    const cycle = { runShared: jest.fn((_id: string, work: () => Promise<unknown>) => work()) };
    const repo = {
      aiCallsSince: jest.fn(async () => 7),
      channelTitle: jest.fn(async (id: string) => ({ mrp: 'Mr. P Investments', mcx: 'MCX Commodity' } as Record<string, string>)[id] ?? null),
    };
    const config = { get: (k: string) => env[k] };
    const svc = new SignalVisionService(config as never, cli as never, audit as never, cycle as never, repo as never, parseSignalIntakeConfig(env));
    return { svc, cli, audit, cycle, repo };
  }
  type SentReq = { max_tokens: number; output_config: { format: { schema: unknown } }; system: Array<{ text: string }> };
  const sent = (cli: ReturnType<typeof make>['cli'], n: number) => (cli.createWithMeta.mock.calls[n] as unknown as [SentReq])[0];
  const NOISE = JSON.stringify({ kind: 'NOISE', isSignal: false, signals: [] });
  const rejected400 = () => Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"schema not supported"}}'), { status: 400 });

  describe('containment if the provider rejects the describe schema (review 2026-11-27)', () => {
    beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it('default: the describe schema and prompt are sent (1 600 tokens)', async () => {
      const { svc, cli } = make({ SENTINEL_JUDGE: 'cli' }, NOISE);
      await svc.classify('', image);
      expect(sent(cli, 0)).toMatchObject({ max_tokens: 1_600, output_config: { format: { schema: SIGNAL_VISION_SCHEMA } }, system: [{ text: SIGNAL_VISION_SYSTEM }] });
    });

    it('SIGNAL_VISION_DESCRIBE=off sends the pre-change schema, prompt and token budget exactly', async () => {
      const { svc, cli } = make({ SENTINEL_JUDGE: 'cli', SIGNAL_VISION_DESCRIBE: 'off' }, NOISE);
      await expect(svc.classify('', image)).resolves.toEqual({ kind: 'NOISE', isSignal: false, signals: [] });
      expect(sent(cli, 0)).toMatchObject({ max_tokens: 1_200, output_config: { format: { schema: SIGNAL_VISION_SCHEMA_LEGACY } }, system: [{ text: SIGNAL_VISION_SYSTEM_LEGACY }] });
      expect(SIGNAL_VISION_SCHEMA_LEGACY.required).toEqual(['kind', 'isSignal', 'signals', 'items', 'shownTime']);
      expect(SIGNAL_VISION_SYSTEM_LEGACY).not.toMatch(/description/);
      expect(SIGNAL_VISION_SYSTEM.startsWith(SIGNAL_VISION_SYSTEM_LEGACY.split('\n\n')[0])).toBe(true);
    });

    it('a 400 on the describe schema → one ERROR, retried with the old schema → classified; sticky for later images', async () => {
      const { svc, cli } = make({ SENTINEL_JUDGE: 'cli' }, NOISE);
      cli.createWithMeta.mockRejectedValueOnce(rejected400());
      await expect(svc.classify('', image)).resolves.toEqual({ kind: 'NOISE', isSignal: false, signals: [] });
      expect(cli.createWithMeta).toHaveBeenCalledTimes(2);
      expect(sent(cli, 0).output_config.format.schema).toBe(SIGNAL_VISION_SCHEMA);
      expect(sent(cli, 1).output_config.format.schema).toBe(SIGNAL_VISION_SCHEMA_LEGACY);
      await svc.classify('', image);
      expect(cli.createWithMeta).toHaveBeenCalledTimes(3);
      expect(sent(cli, 2).output_config.format.schema).toBe(SIGNAL_VISION_SCHEMA_LEGACY);
      expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
      expect((Logger.prototype.error as jest.Mock).mock.calls[0][0]).toMatch(/vision describe schema rejected — falling back/);
    });

    it('other failures (busy, 500, timeout) are not retried and do not switch the schema', async () => {
      const { svc, cli } = make({ SENTINEL_JUDGE: 'cli' }, NOISE);
      cli.createWithMeta.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }));
      await expect(svc.classify('', image)).rejects.toThrow(/overloaded/);
      expect(cli.createWithMeta).toHaveBeenCalledTimes(1);
      await svc.classify('', image);
      expect(sent(cli, 1).output_config.format.schema).toBe(SIGNAL_VISION_SCHEMA);
    });

    it('with describe off a 400 is not retried', async () => {
      const { svc, cli } = make({ SENTINEL_JUDGE: 'cli', SIGNAL_VISION_DESCRIBE: 'off' }, NOISE);
      cli.createWithMeta.mockRejectedValueOnce(rejected400());
      await expect(svc.classify('', image)).rejects.toThrow(/400/);
      expect(cli.createWithMeta).toHaveBeenCalledTimes(1);
    });

    it('isRequestRejected: status 400 or invalid_request_error only', () => {
      expect(isRequestRejected(rejected400())).toBe(true);
      expect(isRequestRejected(new Error('invalid_request_error: bad schema'))).toBe(true);
      expect(isRequestRejected(Object.assign(new Error('rate'), { status: 429 }))).toBe(false);
      expect(isRequestRejected(new Error('timed out after 4000 ms'))).toBe(false);
      expect(isRequestRejected(null)).toBe(false);
    });
  });

  it('a reply cut at max_tokens is its own error', async () => {
    const { svc, cli } = make({ SENTINEL_JUDGE: 'cli' }, NOISE);
    cli.createWithMeta.mockResolvedValueOnce({
      message: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"kind":"NOI' }] },
      meta: { inputTokens: 2, outputTokens: 1600, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, billed: false },
    });
    await expect(svc.classify('', image)).rejects.toThrow('vision reply truncated at max_tokens');
  });

  it('sends the image as base64 over the CLI in the shared slot, records ai_calls signal.vision without the bytes', async () => {
    const { svc, cli, audit, cycle } = make({ SENTINEL_JUDGE: 'cli' }, JSON.stringify({ kind: 'NOISE', isSignal: false, signals: [] }));
    await expect(svc.classify('', image)).resolves.toEqual({ kind: 'NOISE', isSignal: false, signals: [] });
    expect(cycle.runShared).toHaveBeenCalledTimes(1);
    const req = (cli.createWithMeta.mock.calls[0] as unknown as [{ model: string; messages: Array<{ images: Array<{ data: string; mediaType: string }> }> }])[0];
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.messages[0].images[0]).toMatchObject({ mediaType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64') });
    await new Promise((r) => setImmediate(r));
    const row = (audit.insert.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(row).toMatchObject({ job: SIGNAL_VISION_JOB, provider: 'claude-cli', inputTokens: 914, outputTokens: 41 });
    expect((row.request as { images: unknown[] }).images).toEqual([{ mediaType: 'image/jpeg', bytes: 8, sha256: image.sha256 }]);
    expect(JSON.stringify(row.request)).not.toContain(req.messages[0].images[0].data);
  });

  it('a trusted channel is read with the trusted model (same job, so the same daily cap); others and a failed title lookup use haiku', async () => {
    const noise = JSON.stringify({ kind: 'NOISE', isSignal: false, signals: [] });
    const modelOf = async (channelId: string | undefined, broken = false) => {
      const { svc, cli, repo } = make({ SENTINEL_JUDGE: 'cli' }, noise);
      if (broken) repo.channelTitle.mockRejectedValueOnce(new Error('db down'));
      await svc.classify('', image, channelId === undefined ? undefined : { channelId });
      const req = (cli.createWithMeta.mock.calls[0] as unknown as [{ model: string }])[0];
      return req.model;
    };
    expect(await modelOf('mrp')).toBe('claude-sonnet-5');
    expect(await modelOf('mcx')).toBe('claude-haiku-5-5');
    expect(await modelOf(undefined)).toBe('claude-haiku-5-5');
    expect(await modelOf('mrp', true)).toBe('claude-haiku-5-5');
  });

  it('usedSince counts ai_calls rows of the vision job', async () => {
    const { svc, repo } = make({ SENTINEL_JUDGE: 'cli' }, '{}');
    await expect(svc.usedSince(new Date(0))).resolves.toBe(7);
    expect(repo.aiCallsSince).toHaveBeenCalledWith('signal.vision', new Date(0));
  });

  it('unavailable transport: classify refuses without calling anything', async () => {
    const { svc, cli } = make({ SENTINEL_JUDGE: 'api' }, '{}');
    expect(svc.unavailable()).toMatch(/no ANTHROPIC_API_KEY/);
    await expect(svc.classify('', image)).rejects.toThrow(/vision unavailable/);
    expect(cli.createWithMeta).not.toHaveBeenCalled();
  });

  it('a reply that is not the schema JSON is an error', async () => {
    const { svc } = make({ SENTINEL_JUDGE: 'cli' }, 'This is a chart of crude oil.');
    await expect(svc.classify('', image)).rejects.toThrow(/not the vision schema/);
  });

  it('refuses non-image types', async () => {
    const { svc } = make({ SENTINEL_JUDGE: 'cli' }, '{}');
    await expect(svc.classify('', { ...image, mimeType: 'video/mp4' })).rejects.toThrow(/unsupported image type/);
  });
});
