import { readFile } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runInSharedSlot, type SharedSlotRunner } from '../../ai-assist/assist-slot';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import type { MessagesTransport, TransportImage, TransportRequest } from '../../ai-gateway/transport.types';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import { IMAGE_SETUP_SCHEMA, IMAGE_SETUP_SYSTEM } from '../domain/image-setup';
import { IMAGE_SETUP_CONFIG, type ImageSetupConfig } from '../image-setup.config';
import { visionTransportState, VISION_MAX_BYTES } from './signal-vision.service';

/** `ai_calls.job` of every chart-setup read (its own label: the generic `signal.vision` cap is not spent). */
export const IMAGE_SETUP_JOB = 'signal.image-setup';
const MAX_TOKENS = 1_500;
const MEDIA_TYPES = new Set<TransportImage['mediaType']>(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export interface ImageSetupInput {
  path: string;
  mimeType: string;
  sha256?: string;
  caption: string;
  channel: string;
  postedAt: Date;
}

/** The port the image-setup service calls (a fake in tests): the model's raw reply text. Throws on failure. */
export interface ImageSetupReader {
  /** null when images can be read; otherwise why not. */
  unavailable(): string | null;
  read(input: ImageSetupInput): Promise<{ text: string; model: string }>;
}
export const IMAGE_SETUP_READER = Symbol('IMAGE_SETUP_READER');

const istClock = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');

/** The request for one screenshot (exported for the test and the local backfill run). */
export function imageSetupRequest(model: string, input: ImageSetupInput, image: TransportImage): TransportRequest {
  const caption = input.caption.trim();
  const text = [
    ...(input.channel.trim() ? [`Channel: ${input.channel.trim()}`] : []),
    `Posted: ${istClock(input.postedAt)} IST`,
    caption ? `Caption:\n"""\n${caption.slice(0, 1500)}\n"""` : 'Caption: (none)',
    'The image above is the post. Report the setup drawn on it.',
  ].join('\n');
  return {
    model,
    max_tokens: MAX_TOKENS,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: IMAGE_SETUP_SCHEMA as unknown as Record<string, unknown> } },
    system: [{ type: 'text', text: IMAGE_SETUP_SYSTEM }],
    messages: [{ role: 'user', content: text, images: [image] }],
  };
}

/** Read the image file into a transport image; throws on an unsupported type or a file too large to send. */
export async function transportImageOf(input: Pick<ImageSetupInput, 'path' | 'mimeType' | 'sha256'>): Promise<TransportImage> {
  const mediaType = input.mimeType as TransportImage['mediaType'];
  if (!MEDIA_TYPES.has(mediaType)) throw new Error(`unsupported image type ${input.mimeType}`);
  const bytes = await readFile(input.path);
  if (bytes.length > VISION_MAX_BYTES) throw new Error(`image too large (${bytes.length} bytes)`);
  return { mediaType, data: bytes.toString('base64'), ...(input.sha256 ? { sha256: input.sha256 } : {}) };
}

/** One model call over any transport (the shared-slot door included); the reply text, fences stripped by the caller. */
export async function readWith(t: MessagesTransport, slot: SharedSlotRunner | null, model: string, input: ImageSetupInput, maxWaitMs: number): Promise<{ text: string; model: string }> {
  const request = imageSetupRequest(model, input, await transportImageOf(input));
  const call = () => t.messages.create(request);
  const message = slot ? await runInSharedSlot(slot, call, { maxWaitMs }) : await call();
  if (message.stop_reason === 'refusal') throw new Error('the model declined');
  if (message.stop_reason === 'max_tokens') throw new Error('the reply was cut off (max_tokens)');
  const text = (message.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return { text, model };
}

/**
 * The vision transport for chart screenshots: the same binding as the generic image reader
 * (`SENTINEL_JUDGE=cli` → the CLI with a stream-json image block; `api` → the SDK image block, only with
 * ANTHROPIC_API_KEY), recorded in ai_calls as job `signal.image-setup`, run through the sentinel's SHARED
 * slot — never the live reserved one.
 */
@Injectable()
export class ImageSetupVisionReader implements ImageSetupReader {
  private transport: MessagesTransport | null = null;
  private readonly state: { via: 'cli' | 'api' | null; reason: string | null };

  constructor(
    private readonly config: ConfigService,
    private readonly cli: ClaudeCliTransport,
    private readonly calls: AiCallRepository,
    private readonly cycle: SentinelCycleService,
    @Inject(IMAGE_SETUP_CONFIG) private readonly cfg: ImageSetupConfig,
  ) {
    this.state = visionTransportState({ judge: this.config.get<string>('SENTINEL_JUDGE'), apiKey: this.config.get<string>('ANTHROPIC_API_KEY') });
  }

  unavailable(): string | null {
    return this.state.reason;
  }

  async read(input: ImageSetupInput): Promise<{ text: string; model: string }> {
    if (this.state.reason) throw new Error(`vision unavailable: ${this.state.reason}`);
    return readWith(this.transportOf(), this.cycle, this.cfg.model, input, this.cfg.maxWaitMs);
  }

  private transportOf(): MessagesTransport {
    this.transport ??= directRecordedTransport({
      judge: judgeTransportFrom(this.config.get<string>('SENTINEL_JUDGE')),
      cli: this.cli,
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
      record: aiCallsRecordingOn(this.config.get<string>('AI_CALLS_RECORD')),
      audit: this.calls,
      jobOf: () => IMAGE_SETUP_JOB,
    });
    return this.transport;
  }
}
