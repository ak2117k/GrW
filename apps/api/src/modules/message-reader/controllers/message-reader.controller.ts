import { BadRequestException, Controller, ForbiddenException, Get, Inject, Optional, Query } from '@nestjs/common';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../common/decorators';
import { agentsOn } from '../../ai-gateway/agents/agent-registry';
import { istYmd } from '../../market-cues/fetchers/ist-dates';
import { ownerAllowed } from '../../signal-trader/controllers/signal-trader.controller';
import { SIGNAL_TRADER_CONFIG } from '../../signal-trader/services/signal-trader.service';
import { MESSAGE_READER_CONFIG, type MessageReaderConfig } from '../message-reader.config';
import { MessageReaderRepository } from '../repositories/message-reader.repository';
import { MESSAGE_READER_AGENTS_ON, MESSAGE_READER_NOW } from '../services/message-reader.service';

const HOUR_MS = 60 * 60_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export type ReaderReadStore = Pick<MessageReaderRepository, 'countsSince' | 'notesForSession'>;

/**
 * /api/message-reader — the AI message reader's health and the owner's "Market notes" list. Read-only.
 * Owner only, guarded exactly like /api/signal-trader (ADMIN role AND, when set, HUB_OWNER_USER_ID).
 */
@Controller('api/message-reader')
export class MessageReaderController {
  constructor(
    @Inject(MessageReaderRepository) private readonly repo: ReaderReadStore,
    @Inject(MESSAGE_READER_CONFIG) private readonly cfg: MessageReaderConfig,
    @Inject(SIGNAL_TRADER_CONFIG) private readonly trader: { ownerUserId: string | null },
    @Optional() @Inject(MESSAGE_READER_NOW) private readonly nowFn?: () => Date,
    @Optional() @Inject(MESSAGE_READER_AGENTS_ON) private readonly agentsOnFn?: () => boolean,
  ) {}

  private now(): Date {
    return this.nowFn ? this.nowFn() : new Date();
  }

  private owner(user: AuthenticatedUser | undefined): void {
    if (!ownerAllowed(user, this.trader.ownerUserId)) throw new ForbiddenException('owner only');
  }

  /** Mode, AI-agents switch, last READ time, and the last hour's posts / rows by status / p50 + p95 latency. */
  @AdminOnly()
  @Get('health')
  async health(@CurrentUser() user?: AuthenticatedUser) {
    this.owner(user);
    const c = await this.repo.countsSince(new Date(this.now().getTime() - HOUR_MS));
    return {
      mode: this.cfg.mode,
      agentsOn: this.agentsOnFn ? this.agentsOnFn() : agentsOn(),
      lastReadAt: c.lastReadAt,
      lastHour: { posts: c.posts, byStatus: c.byStatus, p50Ms: c.p50Ms, p95Ms: c.p95Ms },
    };
  }

  /** Every reading of one IST session (default today), newest post first. */
  @AdminOnly()
  @Get('notes')
  async notes(@CurrentUser() user?: AuthenticatedUser, @Query('date') date?: string) {
    this.owner(user);
    const raw = (date ?? '').trim();
    if (raw && !YMD.test(raw)) throw new BadRequestException('date must be YYYY-MM-DD');
    const day = raw || istYmd(this.now());
    return { date: day, notes: await this.repo.notesForSession(day) };
  }
}
