import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessagesTransport, TransportRequest } from '../../ai-gateway/transport.types';
import { IMAGE_SETUP_SCHEMA, IMAGE_SETUP_SYSTEM } from '../domain/image-setup';
import { parseImageSetupConfig } from '../image-setup.config';
import { IMAGE_SETUP_JOB, ImageSetupVisionReader, imageSetupRequest, readWith } from './image-setup-reader.service';

const dir = mkdtempSync(join(tmpdir(), 'image-setup-spec-'));
const path = join(dir, 'chart.jpg');
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
writeFileSync(path, BYTES);
const input = { path, mimeType: 'image/jpeg', sha256: 'e'.repeat(64), caption: 'Target done 👍', channel: 'Stock Wale Bhaiyaa Learning Group', postedAt: new Date('2026-11-02T09:05:56Z') };

describe('imageSetupRequest', () => {
  it('one user turn with the image, the caption, the channel and the IST post time; strict schema output', () => {
    const req = imageSetupRequest('claude-haiku-5-5', input, { mediaType: 'image/jpeg', data: 'QUJD' });
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.system[0].text).toBe(IMAGE_SETUP_SYSTEM);
    expect(req.output_config.format.schema).toBe(IMAGE_SETUP_SCHEMA);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].images).toEqual([{ mediaType: 'image/jpeg', data: 'QUJD' }]);
    expect(req.messages[0].content).toContain('Channel: Stock Wale Bhaiyaa Learning Group');
    expect(req.messages[0].content).toContain('Posted: 2026-11-02 14:35 IST');
    expect(req.messages[0].content).toContain('Target done 👍');
  });

  it('the prompt carries the position-tool geometry rules', () => {
    expect(IMAGE_SETUP_SYSTEM).toMatch(/SHORT \(side SELL\): the RED \/ PINK box \(the stop\) is ABOVE the entry/);
    expect(IMAGE_SETUP_SYSTEM).toMatch(/never guess/);
    expect(IMAGE_SETUP_SYSTEM).toMatch(/RESULT: .*"target done"/);
  });
});

describe('readWith — the transport port with a fake', () => {
  const fake = (reply: { stop_reason: string | null; text: string }) => {
    const create = jest.fn(async (_r: TransportRequest) => ({ stop_reason: reply.stop_reason, content: [{ type: 'text', text: reply.text }] }));
    return { t: { messages: { create } } as MessagesTransport, create };
  };

  it('sends the file as base64 and returns the reply text (no slot)', async () => {
    const { t, create } = fake({ stop_reason: 'end_turn', text: '{"kind":"RESULT"}' });
    await expect(readWith(t, null, 'claude-haiku-5-5', input, 1000)).resolves.toEqual({ text: '{"kind":"RESULT"}', model: 'claude-haiku-5-5' });
    expect(create.mock.calls[0][0].messages[0].images?.[0]).toEqual({ mediaType: 'image/jpeg', data: BYTES.toString('base64'), sha256: input.sha256 });
  });

  it('runs inside the shared slot when one is given', async () => {
    const { t } = fake({ stop_reason: 'end_turn', text: '{}' });
    const slot = { runShared: jest.fn((_id: string, work: () => Promise<unknown>) => work()) };
    await readWith(t, slot as never, 'm', input, 1000);
    expect(slot.runShared).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['refusal', /declined/],
    ['max_tokens', /cut off/],
  ])('stop_reason %s is an error', async (stop, err) => {
    const { t } = fake({ stop_reason: stop, text: '' });
    await expect(readWith(t, null, 'm', input, 1000)).rejects.toThrow(err);
  });

  it('refuses a non-image type before calling anything', async () => {
    const { t, create } = fake({ stop_reason: 'end_turn', text: '{}' });
    await expect(readWith(t, null, 'm', { ...input, mimeType: 'video/mp4' }, 1000)).rejects.toThrow(/unsupported image type/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('ImageSetupVisionReader', () => {
  function make(env: Record<string, string | undefined>) {
    const cli = {
      createWithMeta: jest.fn(async () => ({
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"kind":"NOT_A_SETUP"}' }] },
        meta: { inputTokens: 3, outputTokens: 50, cacheCreationInputTokens: 1200, cacheReadInputTokens: 0, billed: false },
      })),
    };
    const audit = { insert: jest.fn(async () => undefined) };
    const cycle = { runShared: jest.fn((_id: string, work: () => Promise<unknown>) => work()) };
    const config = { get: (k: string) => env[k] };
    const reader = new ImageSetupVisionReader(config as never, cli as never, audit as never, cycle as never, parseImageSetupConfig(env));
    return { reader, cli, audit, cycle };
  }

  it('SENTINEL_JUDGE=cli: the image goes over the CLI in the shared slot, ai_calls job signal.image-setup without the bytes', async () => {
    const { reader, cli, audit, cycle } = make({ SENTINEL_JUDGE: 'cli' });
    expect(reader.unavailable()).toBeNull();
    await expect(reader.read(input)).resolves.toEqual({ text: '{"kind":"NOT_A_SETUP"}', model: 'claude-haiku-5-5' });
    expect(cycle.runShared).toHaveBeenCalledTimes(1);
    const req = (cli.createWithMeta.mock.calls[0] as unknown as [TransportRequest])[0];
    expect(req.messages[0].images?.[0].data).toBe(BYTES.toString('base64'));
    await new Promise((r) => setImmediate(r));
    const row = (audit.insert.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(row).toMatchObject({ job: IMAGE_SETUP_JOB, provider: 'claude-cli', model: 'claude-haiku-5-5' });
    expect(JSON.stringify(row.request)).not.toContain(BYTES.toString('base64'));
  });

  it('IMAGE_SETUP_MODEL picks the model', async () => {
    const { reader, cli } = make({ SENTINEL_JUDGE: 'cli', IMAGE_SETUP_MODEL: 'claude-sonnet-5-5' });
    await reader.read(input);
    expect((cli.createWithMeta.mock.calls[0] as unknown as [TransportRequest])[0].model).toBe('claude-sonnet-5-5');
  });

  it('api without a key cannot carry images: unavailable, read refuses without calling anything', async () => {
    const { reader, cli } = make({ SENTINEL_JUDGE: 'api' });
    expect(reader.unavailable()).toMatch(/no ANTHROPIC_API_KEY/);
    await expect(reader.read(input)).rejects.toThrow(/vision unavailable/);
    expect(cli.createWithMeta).not.toHaveBeenCalled();
  });
});
