import { Injectable } from '@nestjs/common';
import { Prisma, type TradeAlarm } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { isAgentVerdictStamp, SENTINEL_JUDGE_STAMP_PREFIX } from '../domain/agent-verdict';
import type { AlarmRow, AlarmRule, AlarmStatus, AlarmUrgency } from '../exit-authority.tokens';

/** Statuses that still need the agent or the owner. */
export const OPEN_STATUSES: AlarmStatus[] = ['OPEN', 'SNOOZED'];
/** Statuses a fresh raise is deduped against: open ones plus a recent agent answer (a held alarm). */
export const DEDUPE_STATUSES: AlarmStatus[] = ['OPEN', 'SNOOZED', 'ANSWERED'];

export type TradeAlarmPatch = Partial<Omit<AlarmRow, 'id' | 'userId' | 'trackerId' | 'rule'>>;

/** The newest trade-agent verdict for a tracker (only the sentinel judge's stamp; see domain/agent-verdict.ts). */
export interface AgentVerdictRef {
  id: string;
  verdict: string;
  createdAt: Date;
}

/** Newest sentinel-judge-prefixed rows read per lookup (the regex then picks the first agent stamp). */
const AGENT_VERDICT_SCAN = 20;

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

const json = (p: Record<string, unknown> | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  p == null ? Prisma.DbNull : (p as Prisma.InputJsonValue);

/** trade_alarms / sentinel_verdicts reads for the exit authority. All alarm state lives here (restart-safe). */
@Injectable()
export class TradeAlarmRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: Omit<AlarmRow, 'id'>): Promise<AlarmRow> {
    const { payload, ...rest } = input;
    const r = await this.prisma.tradeAlarm.create({
      data: {
        ...rest,
        deadline: rest.deadline ?? null,
        severityN: rest.severityN ?? null,
        sourceRef: rest.sourceRef ?? null,
        payload: json(payload),
      },
    });
    return toRow(r);
  }

  /** The newest OPEN / SNOOZED / ANSWERED alarm for (tracker, rule), for raise dedupe. */
  async findLatestLive(trackerId: string, rule: AlarmRule): Promise<AlarmRow | null> {
    const r = await this.prisma.tradeAlarm.findFirst({
      where: { trackerId, rule, status: { in: DEDUPE_STATUSES } },
      orderBy: { lastRaisedAt: 'desc' },
    });
    return r ? toRow(r) : null;
  }

  async findOpen(trackerId: string): Promise<AlarmRow[]> {
    const rows = await this.prisma.tradeAlarm.findMany({
      where: { trackerId, status: { in: OPEN_STATUSES } },
      orderBy: { raisedAt: 'asc' },
    });
    return rows.map(toRow);
  }

  async findOpenForTrackers(ids: string[]): Promise<AlarmRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tradeAlarm.findMany({
      where: { trackerId: { in: ids }, status: { in: OPEN_STATUSES } },
      orderBy: { raisedAt: 'asc' },
    });
    return rows.map(toRow);
  }

  async findOpenAll(): Promise<AlarmRow[]> {
    const rows = await this.prisma.tradeAlarm.findMany({
      where: { status: { in: OPEN_STATUSES } },
      orderBy: { raisedAt: 'asc' },
    });
    return rows.map(toRow);
  }

  async update(id: string, patch: TradeAlarmPatch): Promise<AlarmRow> {
    const { payload, ...rest } = patch;
    const data: Prisma.TradeAlarmUpdateInput = { ...rest };
    if ('payload' in patch) data.payload = json(payload);
    const r = await this.prisma.tradeAlarm.update({ where: { id }, data });
    return toRow(r);
  }

  /**
   * Newest sentinel_verdicts row for the tracker after `since` that the TRADE AGENT wrote: the live sentinel judge's
   * stamp only (domain/agent-verdict.ts isAgentVerdictStamp). Desk TIGHTEN rows, signal SL rows and code-rule stamps
   * are not an agent look and never answer an alarm.
   */
  async latestAgentVerdict(trackerId: string, since: Date): Promise<AgentVerdictRef | null> {
    const rows = await this.prisma.sentinelVerdict.findMany({
      where: {
        trackerId,
        createdAt: { gt: since },
        promptVersion: { startsWith: SENTINEL_JUDGE_STAMP_PREFIX },
      },
      orderBy: { createdAt: 'desc' },
      take: AGENT_VERDICT_SCAN,
      select: { id: true, verdict: true, createdAt: true, promptVersion: true },
    });
    const r = rows.find((x) => isAgentVerdictStamp(x.promptVersion));
    return r ? { id: r.id, verdict: r.verdict, createdAt: r.createdAt } : null;
  }

  /**
   * Answer an alarm only while it still needs one (OPEN / SNOOZED): a conditional update, so a late answer can never
   * resurrect a BACKSTOPPED / CLOSED / already ANSWERED row. True when this call answered it.
   */
  async answerIfOpen(id: string, patch: { answeredAt: Date; answerVerdictId: string; answer: string }): Promise<boolean> {
    const r = await this.prisma.tradeAlarm.updateMany({
      where: { id, status: { in: OPEN_STATUSES } },
      data: { status: 'ANSWERED', ...patch },
    });
    return r.count > 0;
  }
}
