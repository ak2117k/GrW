import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CONFIRM_TIMEOUT_MS } from '../../exit-authority/domain/timings';
import type { ConfirmRequest, ConfirmResult, SupremeConfirmPort } from '../../exit-authority/exit-authority.tokens';
import type { TransportRequest } from '../../ai-gateway/transport.types';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from '../desk-manager.config';
import { CONFIRM_PROMPT_VERSION, confirmSystemPrompt, confirmUserMessage, parseConfirmReply, type ConfirmReply } from '../domain/confirm-prompt';
import type { MemoryView } from '../domain/desk.types';
import { DeskStateService } from './desk-state.service';
import { ManagerLlmService } from './manager-llm.service';

/** Short answer: a decision, a line or two of reason and an optional brief note. */
export const CONFIRM_MAX_TOKENS = 800;
/** desk_manager_decisions.runId / action of the audit row of each confirm call. */
export const SUPREME_CONFIRM_RUN_ID = 'supreme-confirm';
export const SUPREME_CONFIRM_ACTION = 'CONFIRM';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Llm = Pick<ManagerLlmService, 'send'>;
type Memory = Pick<DeskStateService, 'memory'>;

/**
 * THE SUPREME CONFIRM (trade agent exit authority, spec §4.3 / §4.4). A trade agent's EXIT / BOOK on a live trade
 * is put to the desk manager in ONE short call (a separate one-off call, not a request into the running manager
 * cycle): the manager's model, effort medium, ≤ 800 tokens, its own system prompt, the agent's call + alarm + brief
 * + packet summary + the desk's memory block. CONFIRM / OVERRIDE_HOLD from the model; a transport failure or a junk
 * reply is ERROR (the caller then lets the agent's decision stand). Never throws.
 * Every call is audited as a desk_manager_decisions row (action CONFIRM, runId 'supreme-confirm').
 */
@Injectable()
export class SupremeConfirmService implements SupremeConfirmPort {
  private readonly logger = new Logger(SupremeConfirmService.name);
  private system: string | null = null;

  constructor(
    @Inject(ManagerLlmService) private readonly llm: Llm,
    @Inject(DeskStateService) private readonly state: Memory,
    private readonly prisma: PrismaService,
    @Inject(DESK_MANAGER_CONFIG) private readonly cfg: DeskManagerConfig,
  ) {}

  async confirm(req: ConfirmRequest): Promise<ConfirmResult> {
    const started = Date.now();
    let reply: ConfirmReply;
    let raw: string | null = null;
    try {
      const memory = await this.memory(req.userId);
      const request: TransportRequest = {
        model: this.cfg.model,
        max_tokens: CONFIRM_MAX_TOKENS,
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: (this.system ??= confirmSystemPrompt(this.cfg)), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: confirmUserMessage(req, memory) }],
        cli: { effort: 'medium' },
      };
      raw = await this.llm.send(req.userId, request, CONFIRM_TIMEOUT_MS);
      reply = parseConfirmReply(raw);
    } catch (err) {
      reply = { decision: 'ERROR', reason: `supreme confirm failed: ${errText(err)}`.slice(0, 500), briefNote: null };
    }
    const result: ConfirmResult = { ...reply, latencyMs: Date.now() - started };
    this.logger.warn(`[supreme-confirm] ${req.symbol} (tracker ${req.trackerId}) agent ${req.agentDecision}${req.agentDisagrees ? ' (agent disagreed)' : ''} → ${result.decision} in ${result.latencyMs} ms: ${result.reason}`);
    // Audit off the answer's path: the caller races this call against its own 30 s.
    void this.record(req, result, raw).catch((err) => this.logger.warn(`[supreme-confirm] audit row not written: ${errText(err)}`));
    return result;
  }

  /** The manager packet's memory block (today's decisions, scorecard, lessons); null when it cannot be read. */
  private async memory(userId: string): Promise<MemoryView | null> {
    try {
      return await this.state.memory(userId, new Date());
    } catch (err) {
      this.logger.warn(`[supreme-confirm] memory unavailable: ${errText(err)}`);
      return null;
    }
  }

  private async record(req: ConfirmRequest, r: ConfirmResult, raw: string | null): Promise<void> {
    const payload = {
      action: SUPREME_CONFIRM_ACTION,
      trackerId: req.trackerId,
      symbol: req.symbol,
      agentDecision: req.agentDecision,
      agentReason: req.agentReason,
      agentDisagrees: req.agentDisagrees === true,
      alarm: req.alarm ? { id: req.alarm.id, rule: req.alarm.rule, urgency: req.alarm.urgency, reason: req.alarm.reason } : null,
      hasBrief: !!req.brief,
      model: this.cfg.model,
      promptVersion: CONFIRM_PROMPT_VERSION,
    };
    await this.prisma.deskManagerDecision.create({
      data: {
        runId: SUPREME_CONFIRM_RUN_ID,
        userId: req.userId,
        action: SUPREME_CONFIRM_ACTION,
        underlying: null,
        trackerId: req.trackerId,
        payload: payload as Prisma.InputJsonValue,
        validation: { ok: true, problems: [], source: SUPREME_CONFIRM_RUN_ID } as Prisma.InputJsonValue,
        status: r.decision === 'CONFIRM' || r.decision === 'OVERRIDE_HOLD' ? 'DONE' : 'FAILED',
        result: { ...r, raw: raw === null ? null : raw.slice(0, 4000) } as Prisma.InputJsonValue,
      },
    });
  }
}
