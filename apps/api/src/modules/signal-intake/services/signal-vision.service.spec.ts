import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVisionReply, SIGNAL_VISION_SCHEMA } from '../domain/llm-schema';
import { parseSignalIntakeConfig } from '../signal-intake.config';
import { SIGNAL_VISION_JOB, SignalVisionService, visionTransportState } from './signal-vision.service';

describe('readVisionReply — strict schema', () => {
  const sig = { underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, expiry: null, side: 'BUY', entryType: 'AT', entryLow: 120, entryHigh: 120, sl: 100, targets: [150], qty: null, horizon: 'INTRADAY', confidence: 0.8 };

  it('the schema requires kind (SIGNAL | UPDATE | INFO | NOISE) and INFO items on top of the text schema', () => {
    expect(SIGNAL_VISION_SCHEMA.required).toEqual(['kind', 'isSignal', 'signals', 'items']);
    expect(SIGNAL_VISION_SCHEMA.properties.kind.enum).toEqual(['SIGNAL', 'UPDATE', 'INFO', 'NOISE']);
  });

  it('INFO (and the legacy VIEW of cached replies) carries its items, never a signal', () => {
    const item = { underlying: 'NIFTY', bias: 'BULL', levels: [22400] };
    expect(readVisionReply(JSON.stringify({ kind: 'INFO', isSignal: true, signals: [sig], items: [item] }))).toEqual({ kind: 'INFO', isSignal: false, signals: [], items: [item] });
    expect(readVisionReply(JSON.stringify({ kind: 'VIEW', isSignal: false, signals: [] }))).toEqual({ kind: 'INFO', isSignal: false, signals: [], items: [] });
  });

  it('a SIGNAL keeps its signals (fences tolerated)', () => {
    expect(readVisionReply('```json\n' + JSON.stringify({ kind: 'SIGNAL', isSignal: true, signals: [sig] }) + '\n```')).toEqual({ kind: 'SIGNAL', isSignal: true, signals: [sig] });
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
    const repo = { aiCallsSince: jest.fn(async () => 7) };
    const config = { get: (k: string) => env[k] };
    const svc = new SignalVisionService(config as never, cli as never, audit as never, cycle as never, repo as never, parseSignalIntakeConfig({}));
    return { svc, cli, audit, cycle, repo };
  }

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
