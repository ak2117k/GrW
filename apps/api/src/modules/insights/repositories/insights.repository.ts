import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Prisma, AIInsight } from '@prisma/client';

@Injectable()
export class InsightsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveByKey(sectionKey: string, contextKey: string): Promise<AIInsight | null> {
    return this.prisma.aIInsight.findFirst({
      where: {
        sectionKey,
        contextKey,
        status: { in: ['pending', 'in_progress'] },
      },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async findLatestByKey(sectionKey: string, contextKey: string): Promise<AIInsight | null> {
    return this.prisma.aIInsight.findFirst({
      where: { sectionKey, contextKey },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async create(data: {
    sectionKey: string;
    contextKey: string;
    contextData: Prisma.InputJsonValue;
  }): Promise<AIInsight> {
    return this.prisma.aIInsight.create({
      data: { ...data, status: 'pending' },
    });
  }

  async findPending(limit: number): Promise<AIInsight[]> {
    return this.prisma.aIInsight.findMany({
      where: { status: 'pending' },
      orderBy: { requestedAt: 'asc' },
      take: limit,
    });
  }

  async markInProgress(id: string): Promise<AIInsight> {
    return this.prisma.aIInsight.update({
      where: { id },
      data: { status: 'in_progress', startedAt: new Date() },
    });
  }

  async markCompleted(id: string, insight: string, confidence: number): Promise<AIInsight> {
    return this.prisma.aIInsight.update({
      where: { id },
      data: {
        status: 'completed',
        insight,
        confidence,
        completedAt: new Date(),
      },
    });
  }

  async markFailed(id: string, errorMessage: string): Promise<AIInsight> {
    return this.prisma.aIInsight.update({
      where: { id },
      data: {
        status: 'failed',
        errorMessage,
        completedAt: new Date(),
      },
    });
  }

  async revertStaleInProgress(olderThan: Date): Promise<number> {
    const result = await this.prisma.aIInsight.updateMany({
      where: { status: 'in_progress', startedAt: { lt: olderThan } },
      data: { status: 'pending', startedAt: null },
    });
    return result.count;
  }

  async findById(id: string): Promise<AIInsight | null> {
    return this.prisma.aIInsight.findUnique({ where: { id } });
  }
}
