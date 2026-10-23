import { readFile } from 'node:fs/promises';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import type { MessagesTransport, TransportImage, TransportRequest } from '../../ai-gateway/transport.types';
import { runInSharedSlot } from '../../ai-assist/assist-slot';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import { readVisionReply, SIGNAL_VISION_SCHEMA, SIGNAL_VISION_SYSTEM, type VisionReply } from '../domain/llm-schema';
import type { TelegramMediaRef } from '../domain/types';
import { SignalIntakeRepository } from '../repositories/signal-intake.repository';
import { SIGNAL_INTAKE_CONFIG, type SignalIntakeConfig } from '../signal-intake.config';

/** `ai_calls.job` for every image read (the daily cap counts these rows). */
export const SIGNAL_VISION_JOB = 'signal.vision';
const MAX_TOKENS = 1_200;
/** Never send more than this to the model (the reader keeps photos ≤ ~1 MB, documents ≤ 2 MB). */
export const VISION_MAX_BYTES = 2 * 1024 * 1024;
const MEDIA_TYPES = new Set<TransportImage['mediaType']>(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** The port the intake service calls (a fake in tests). `classify` throws on failure / busy slot. */
export interface SignalVision {
  /** null when images can be read; otherwise why not (logged once at boot). */
  unavailable(): string | null;
  /** `signal.vision` ai_calls rows since `since` (the daily cap). */
  usedSince(since: Date): Promise<number>;
  classify(caption: string, image: TelegramMediaRef): Promise<VisionReply>;
}
export const SIGNAL_VISION = Symbol('SIGNAL_VISION');

/**
 * Which transport can carry an image under the current config, or why none can.
 *
 * - `SENTINEL_JUDGE=cli` → ClaudeCliTransport, image as a stream-json `image` content block
 *   (`--input-format stream-json`, tools still disabled). Verified 2026-10-23 on CLI 2.1.309 with
 *   claude-haiku-5-5; the image is never a file the CLI reads.
 * - `api` → the Anthropic SDK with an `image` block — only when ANTHROPIC_API_KEY is set.
 * - `bedrock` → not wired for images here.
 */
export function visionTransportState(env: { judge: string | undefined; apiKey: string | undefined }): { via: 'cli' | 'api' | null; reason: string | null } {
  const judge = judgeTransportFrom(env.judge);
  if (judge === 'cli') return { via: 'cli', reason: null };
  if (judge === 'api') return (env.apiKey ?? '').trim() ? { via: 'api', reason: null } : { via: null, reason: 'SENTINEL_JUDGE=api but no ANTHROPIC_API_KEY' };
  return { via: null, reason: `SENTINEL_JUDGE=${judge} cannot carry images` };
}

/**
 * Image posts (MCX / tip channels often post the call as a picture): one cheap vision call per image —
 * classify (SIGNAL / UPDATE / VIEW / NOISE) and, for a SIGNAL, extract with the text fallback's schema.
 * Same transport binding and recorder as the text fallback (job 'signal.vision'), same shared slot —
 * NEVER the live reserved slot.
 */
@Injectable()
export class SignalVisionService implements SignalVision, OnApplicationBootstrap {
  private readonly logger = new Logger(SignalVisionService.name);
  private transport: MessagesTransport | null = null;
  private readonly state: { via: 'cli' | 'api' | null; reason: string | null };

  constructor(
    private readonly config: ConfigService,
    private readonly cli: ClaudeCliTransport,
    private readonly calls: AiCallRepository,
    private readonly cycle: SentinelCycleService,
    private readonly repo: SignalIntakeRepository,
    @Inject(SIGNAL_INTAKE_CONFIG) private readonly cfg: SignalIntakeConfig,
  ) {
    this.state = visionTransportState({ judge: this.config.get<string>('SENTINEL_JUDGE'), apiKey: this.config.get<string>('ANTHROPIC_API_KEY') });
  }

  onApplicationBootstrap(): void {
    if (!this.cfg.enabled) return;
    if (!this.cfg.visionEnabled) this.logger.log('[signal-intake] vision: off (SIGNAL_VISION=off) — image posts are not read');
    else if (this.state.reason) this.logger.warn(`[signal-intake] vision: UNAVAILABLE — ${this.state.reason}; image posts are not read`);
    else this.logger.log(`[signal-intake] vision: on via ${this.state.via} (${this.cfg.visionModel}, cap ${this.cfg.visionDailyCap}/day)`);
  }

  unavailable(): string | null {
    return this.state.reason;
  }

  usedSince(since: Date): Promise<number> {
    return this.repo.aiCallsSince(SIGNAL_VISION_JOB, since);
  }

  async classify(caption: string, image: TelegramMediaRef): Promise<VisionReply> {
    if (this.state.reason) throw new Error(`vision unavailable: ${this.state.reason}`);
    const mediaType = image.mimeType as TransportImage['mediaType'];
    if (!MEDIA_TYPES.has(mediaType)) throw new Error(`unsupported image type ${image.mimeType}`);
    const bytes = await readFile(image.path);
    if (bytes.length > VISION_MAX_BYTES) throw new Error(`image too large (${bytes.length} bytes)`);
    const request: TransportRequest = {
      model: this.cfg.visionModel,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SIGNAL_VISION_SCHEMA as unknown as Record<string, unknown> } },
      system: [{ type: 'text', text: SIGNAL_VISION_SYSTEM }],
      messages: [
        {
          role: 'user',
          content: caption.trim() ? `Telegram post caption:\n"""\n${caption.slice(0, 2000)}\n"""\nThe image above is the post.` : 'Telegram post with no caption: the image above is the post.',
          images: [{ mediaType, data: bytes.toString('base64'), sha256: image.sha256 }],
        },
      ],
    };
    const t = this.transportOf();
    const message = await runInSharedSlot(this.cycle, () => t.messages.create(request), { maxWaitMs: this.cfg.llmMaxWaitMs });
    if (message.stop_reason === 'refusal') throw new Error('the model declined');
    const out = (message.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const reply = readVisionReply(out);
    if (!reply) throw new Error('reply is not the vision schema JSON');
    return reply;
  }

  private transportOf(): MessagesTransport {
    this.transport ??= directRecordedTransport({
      judge: judgeTransportFrom(this.config.get<string>('SENTINEL_JUDGE')),
      cli: this.cli,
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
      record: aiCallsRecordingOn(this.config.get<string>('AI_CALLS_RECORD')),
      audit: this.calls,
      jobOf: () => SIGNAL_VISION_JOB,
    });
    return this.transport;
  }
}
