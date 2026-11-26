import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ActionResult, ManagerDecision, WakeReason } from '../domain/desk.types';

export interface RunStart {
  userId: string;
  startedAt: Date;
  wakeReasons: WakeReason[];
  mode: string;
}

export interface RunFinish {
  finishedAt: Date;
  packet?: unknown;
  packetMs?: number | null;
  aiMs?: number | null;
  reply?: unknown;
  summary?: string | null;
  error?: string | null;
}

export interface DecisionWrite {
  runId: string;
  userId: string;
  decision: ManagerDecision;
  problems: string[];
}

export interface DecisionResultWrite {
  result: ActionResult;
  orderRowId?: string | null;
  tradeId?: string | null;
  execId?: string | null;
}

const json = (v: unknown): Prisma.InputJsonValue => (v === undefined || v === null ? (Prisma.JsonNull as unknown as Prisma.InputJsonValue) : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

/** desk_manager_runs / desk_manager_decisions (plan Task 4). */
@Injectable()
export class DeskManagerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(r: RunStart): Promise<string> {
    const row = await this.prisma.deskManagerRun.create({
      data: { userId: r.userId, startedAt: r.startedAt, wakeReasons: json(r.wakeReasons), mode: r.mode },
      select: { id: true },
    });
    return row.id;
  }

  async finishRun(id: string, f: RunFinish): Promise<void> {
    await this.prisma.deskManagerRun.update({
      where: { id },
      data: {
        finishedAt: f.finishedAt,
        ...(f.packet !== undefined ? { packet: json(f.packet) } : {}),
        ...(f.packetMs !== undefined ? { packetMs: f.packetMs } : {}),
        ...(f.aiMs !== undefined ? { aiMs: f.aiMs } : {}),
        ...(f.reply !== undefined ? { reply: json(f.reply) } : {}),
        ...(f.summary !== undefined ? { summary: f.summary } : {}),
        ...(f.error !== undefined ? { error: f.error } : {}),
      },
    });
  }

  /** Stored VALID (no problems) or INVALID with { ok, problems }. */
  async insertDecision(w: DecisionWrite): Promise<string> {
    const d = w.decision;
    const row = await this.prisma.deskManagerDecision.create({
      data: {
        runId: w.runId,
        userId: w.userId,
        action: d.action,
        underlying: 'underlying' in d ? d.underlying : null,
        trackerId: 'trackerId' in d ? d.trackerId : null,
        payload: json(d),
        validation: json({ ok: w.problems.length === 0, problems: w.problems }),
        status: w.problems.length === 0 ? 'VALID' : 'INVALID',
      },
      select: { id: true },
    });
    return row.id;
  }

  async setDecisionResult(id: string, w: DecisionResultWrite): Promise<void> {
    await this.prisma.deskManagerDecision.update({
      where: { id },
      data: {
        status: w.result.status,
        result: json(w.result),
        ...(w.orderRowId ? { orderRowId: w.orderRowId } : {}),
        ...(w.tradeId ? { tradeId: w.tradeId } : {}),
        ...(w.execId ? { execId: w.execId } : {}),
      },
    });
  }

  /** Runs since `since` that reached the AI (aiMs is written for every attempted call, failed or not). */
  async countAiCallsSince(userId: string, since: Date): Promise<number> {
    return this.prisma.deskManagerRun.count({ where: { userId, startedAt: { gte: since }, aiMs: { not: null } } });
  }
}
