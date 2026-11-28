import { Injectable } from '@nestjs/common';
import type { TradeAlarm } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { AlarmRow, AlarmRule, AlarmStatus, AlarmUrgency } from '../exit-authority.tokens';

/** Statuses the escalation runner still looks at: open ones plus ANSWERED (SUPREME_EXIT round trip, close-out). */
export const RUNNER_STATUSES: AlarmStatus[] = ['OPEN', 'SNOOZED', 'ANSWERED'];

export interface TrackerRef {
  id: string;
  userId: string;
  symbol: string;
  status: string;
}

// Same mapping as trade-alarm.repository's private toRow (Task 1 owns that file; kept local here on purpose).
function toRow(r: TradeAlarm): AlarmRow {
  return {
    id: r.id,
    userId: r.userId,
    trackerId: r.trackerId,
    symbol: r.symbol,
    rule: r.rule as AlarmRule,
    urgency: r.urgency as AlarmUrgency,
    reason: r.reason,
    wouldHave: r.wouldHave,
    deadline: r.deadline,
    severityN: r.severityN,
    sourceRef: r.sourceRef,
    payload: (r.payload ?? undefined) as Record<string, unknown> | undefined,
    status: r.status as AlarmStatus,
    raisedAt: r.raisedAt,
    lastRaisedAt: r.lastRaisedAt,
    answeredAt: r.answeredAt,
    answerVerdictId: r.answerVerdictId,
    answer: r.answer,
    alertedAt: r.alertedAt,
    alertCount: r.alertCount,
    telegramMessageId: r.telegramMessageId,
    snoozedUntil: r.snoozedUntil,
  };
}

/** Reads the escalation runner and the owner buttons need beyond TradeAlarmRepository. */
@Injectable()
export class EscalationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<AlarmRow | null> {
    const r = await this.prisma.tradeAlarm.findUnique({ where: { id } });
    return r ? toRow(r) : null;
  }

  /** Every alarm the runner still owes work: OPEN / SNOOZED / ANSWERED (oldest first). */
  async findForRunner(): Promise<AlarmRow[]> {
    const rows = await this.prisma.tradeAlarm.findMany({
      where: { status: { in: RUNNER_STATUSES } },
      orderBy: { raisedAt: 'asc' },
    });
    return rows.map(toRow);
  }

  /** The subset of `ids` whose trade_trackers row is still OPEN. */
  async openTrackerIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.tradeTracker.findMany({
      where: { id: { in: ids }, status: 'OPEN' },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** The trade's live owner message: the newest still-tracked alarm of the tracker that carries one. */
  async trackerMessageId(trackerId: string): Promise<number | null> {
    const r = await this.prisma.tradeAlarm.findFirst({
      where: { trackerId, status: { in: RUNNER_STATUSES }, telegramMessageId: { not: null } },
      orderBy: { lastRaisedAt: 'desc' },
      select: { telegramMessageId: true },
    });
    return r?.telegramMessageId ?? null;
  }

  /** The trade's live owner message is now `messageId`: stamp it on every still-tracked alarm of the trade. */
  async setTrackerMessageId(trackerId: string, messageId: number): Promise<void> {
    await this.prisma.tradeAlarm.updateMany({
      where: { trackerId, status: { in: RUNNER_STATUSES } },
      data: { telegramMessageId: messageId },
    });
  }

  async tracker(id: string): Promise<TrackerRef | null> {
    return this.prisma.tradeTracker.findUnique({
      where: { id },
      select: { id: true, userId: true, symbol: true, status: true },
    });
  }

  /** The intraday-carry engine confirmed this live position CONVERTED to carry-forward (decided at/after `since`). */
  async carryConverted(trackerId: string, since: Date): Promise<boolean> {
    const r = await this.prisma.intradayCarryDecision.findFirst({
      where: { trackerId, mode: 'live', conversionStatus: 'CONVERTED', decidedAt: { gte: since } },
      select: { id: true },
    });
    return r != null;
  }
}
