import { BadRequestException, Controller, ForbiddenException, Get, Inject, Optional, Query } from '@nestjs/common';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../common/decorators';
import { istYmd } from '../../market-cues/fetchers/ist-dates';
import { ownerAllowed } from '../../signal-trader/controllers/signal-trader.controller';
import { SIGNAL_TRADER_CONFIG } from '../../signal-trader/services/signal-trader.service';
import { AI_SETUPS_CONFIG, type AiSetupsConfig, type AiSetupsMode } from '../ai-setups.config';
import { AiSetupsRepository, type SessionSetupRow } from '../repositories/ai-setups.repository';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Test seam: the controller's clock. */
export const AI_SETUPS_CARD_NOW = Symbol('AI_SETUPS_CARD_NOW');

export type SetupCardStore = Pick<AiSetupsRepository, 'setupsForSession'>;

/** The channel claim a setup came from (copied into checks.claim when the row was written). */
export interface SetupCardClaim {
  text: string;
  subject: string | null;
  bias: string | null;
  verdict: string | null;
}

/** One setup card as the Market notes screen shows it. The packet the AI saw is never sent. */
export interface SetupCard {
  id: string;
  readingId: string;
  underlying: string;
  channelId: string;
  channelTitle: string | null;
  createdAt: Date;
  /** SETUP | NO_TRADE | SKIPPED (a code-check veto keeps SETUP here with status NO_TRADE). */
  decision: string;
  /** PENDING | FILLED | EXITED | EXPIRED | NO_TRADE | SKIPPED. */
  status: string;
  reason: string;
  claim: SetupCardClaim | null;
  /** The code check that turned an AI setup into NO_TRADE, or a missing-data stop. */
  failedCheck: { name: string; detail: string } | null;
  /** The AI's plan (SetupPlan) when it made one, including a vetoed one. */
  setup: Record<string, unknown> | null;
  validUntil: Date | null;
  entryAt: Date | null;
  exitAt: Date | null;
  exitReason: string | null;
  /** The paper trade's P&L (gross) once exited. */
  pnl: number | null;
  /** The nightly grade (actual / plan-only / hypothetical what-if parts), when graded. */
  grade: Record<string, unknown> | null;
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Pure: one stored row → the card's fields (unreadable json → null). */
export function toSetupCard(r: SessionSetupRow): SetupCard {
  const checks = isRec(r.checks) ? r.checks : null;
  const c = checks && isRec(checks.claim) ? checks.claim : null;
  const text = c ? str(c.text) : null;
  const result = checks && isRec(checks.result) ? checks.result : null;
  const failed = result && result.ok === false ? str(result.failed) : null;
  return {
    id: r.id,
    readingId: r.readingId,
    underlying: r.underlying,
    channelId: r.channelId,
    channelTitle: r.channelTitle,
    createdAt: r.createdAt,
    decision: r.decision,
    status: r.status,
    reason: r.reason,
    claim: text ? { text, subject: str(c!.subject), bias: str(c!.bias), verdict: str(c!.verdict) } : null,
    failedCheck: failed ? { name: failed, detail: str(result!.detail) ?? '' } : null,
    setup: isRec(r.setup) ? r.setup : null,
    validUntil: r.validUntil,
    entryAt: r.entryAt,
    exitAt: r.exitAt,
    exitReason: r.exitReason,
    pnl: r.pnl,
    grade: isRec(r.grade) ? r.grade : null,
  };
}

/**
 * /api/ai-setups — every AI setup (and NO_TRADE / SKIPPED decision) of one IST session for the owner's setup cards
 * on the Market notes screen. Read-only. Owner only, guarded exactly like /api/message-reader (ADMIN role AND, when
 * set, HUB_OWNER_USER_ID). `mode` lets the page hide the cards when AI_SETUPS=off.
 */
@Controller('api/ai-setups')
export class AiSetupsController {
  constructor(
    @Inject(AiSetupsRepository) private readonly repo: SetupCardStore,
    @Inject(AI_SETUPS_CONFIG) private readonly cfg: Pick<AiSetupsConfig, 'mode'>,
    @Inject(SIGNAL_TRADER_CONFIG) private readonly trader: { ownerUserId: string | null },
    @Optional() @Inject(AI_SETUPS_CARD_NOW) private readonly nowFn?: () => Date,
  ) {}

  /** One IST session's setups (default today), newest first. */
  @AdminOnly()
  @Get()
  async list(@CurrentUser() user?: AuthenticatedUser, @Query('date') date?: string): Promise<{ date: string; mode: AiSetupsMode; setups: SetupCard[] }> {
    if (!ownerAllowed(user, this.trader.ownerUserId)) throw new ForbiddenException('owner only');
    const raw = (date ?? '').trim();
    if (raw && !YMD.test(raw)) throw new BadRequestException('date must be YYYY-MM-DD');
    const day = raw || istYmd(this.nowFn ? this.nowFn() : new Date());
    const rows = await this.repo.setupsForSession(day);
    const setups = rows.map(toSetupCard).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { date: day, mode: this.cfg.mode, setups };
  }
}
