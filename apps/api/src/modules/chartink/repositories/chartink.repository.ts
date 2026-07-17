import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { categorizeScannerByName } from '../scanner-category';

export interface UpsertScannerInput {
  scanUrl: string;
  scanName: string;
  alertName: string | null;
  firedAt: Date;
}

export interface CreateAlertInput {
  scannerId: string;
  triggeredAt: Date;
  rawPayload: Prisma.InputJsonValue;
}

export interface CreateAlertSetupInput {
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  kind: 'setup' | 'no-setup' | 'unresolved' | 'error' | 'mtf-misaligned' | 'sector-misaligned' | 'scored-low' | 'no-direction' | 'macd-misaligned' | 'supertrend-misaligned' | 'market-closed';
  setupId: string | null;
  rejectReason: string | null;
  // Scoring + lot sizing (added 2026-05-12)
  score?: number | null;
  lotCount?: number | null;
  scoreBreakdown?: unknown;
}

@Injectable()
export class ChartinkRepository {
  private readonly logger = new Logger(ChartinkRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertScanner(input: UpsertScannerInput): Promise<{ id: string; category: string }> {
    const row = await this.prisma.chartinkScanner.upsert({
      where: { scanUrl: input.scanUrl },
      create: {
        scanUrl: input.scanUrl,
        scanName: input.scanName,
        alertName: input.alertName,
        firstSeenAt: input.firedAt,
        lastFiredAt: input.firedAt,
        fireCount: 1,
        // Tag from the name at creation so a swing scanner takes the swing track
        // on its FIRST fire — the previous default-OTHER + manual-tag flow meant a
        // "ANAND SWING" scanner silently ran as non-swing until someone remembered
        // to tag it (one fired 345×, zero swing entries). Create-only on purpose:
        // an admin's later category change (via updateScannerCategory) must win, so
        // the update branch never re-derives it.
        category: categorizeScannerByName(input.scanName),
      },
      update: {
        scanName: input.scanName,
        alertName: input.alertName,
        lastFiredAt: input.firedAt,
        fireCount: { increment: 1 },
      },
      select: { id: true, category: true },
    });
    return row;
  }

  async createAlert(input: CreateAlertInput): Promise<{ id: string }> {
    return this.prisma.chartinkAlert.create({
      data: {
        scannerId: input.scannerId,
        triggeredAt: input.triggeredAt,
        rawPayload: input.rawPayload,
      },
      select: { id: true },
    });
  }

  async getAlertWithSetups(alertId: string) {
    return this.prisma.chartinkAlert.findUnique({
      where: { id: alertId },
      include: { setups: true, scanner: true },
    });
  }

  async createAlertSetup(input: CreateAlertSetupInput): Promise<{ id: string }> {
    const row = await this.prisma.chartinkAlertSetup.create({
      data: {
        alertId: input.alertId,
        symbol: input.symbol,
        token: input.token,
        hitPrice: input.hitPrice,
        kind: input.kind,
        setupId: input.setupId,
        rejectReason: input.rejectReason,
        score: input.score ?? null,
        lotCount: input.lotCount ?? null,
        scoreBreakdown:
          input.scoreBreakdown == null
            ? Prisma.JsonNull
            : (input.scoreBreakdown as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
    return row;
  }

  async listScanners() {
    return this.prisma.chartinkScanner.findMany({
      orderBy: { lastFiredAt: 'desc' },
    });
  }

  async listRecentAlerts(limit = 50) {
    return this.prisma.chartinkAlert.findMany({
      orderBy: { receivedAt: 'desc' },
      take: limit,
      include: {
        scanner: { select: { scanName: true, scanUrl: true } },
        setups: { select: { kind: true } },
      },
    });
  }

  /**
   * Fetch ChartinkAlertSetup rows whose processedAt falls inside [from, to],
   * optionally filtered by `kind`, joined to the scanner (via alert) so the
   * scanner name is available. Ordered processedAt desc, capped at `limit`.
   */
  async findAlertSetupsInRange(params: {
    from: Date;
    to: Date;
    kind?: string;
    limit: number;
  }) {
    return this.prisma.chartinkAlertSetup.findMany({
      where: {
        processedAt: { gte: params.from, lte: params.to },
        ...(params.kind ? { kind: params.kind } : {}),
      },
      orderBy: { processedAt: 'desc' },
      take: params.limit,
      include: {
        alert: {
          select: { scanner: { select: { scanName: true } } },
        },
      },
    });
  }

  /**
   * Count ChartinkAlertSetup rows grouped by `kind` within [from, to].
   * Used to compute totalProcessed / accepted / rejected / byKind.
   */
  async countAlertSetupsByKind(params: { from: Date; to: Date }) {
    return this.prisma.chartinkAlertSetup.groupBy({
      by: ['kind'],
      where: {
        processedAt: { gte: params.from, lte: params.to },
      },
      _count: { _all: true },
    });
  }

  async updateScannerCategory(
    id: string,
    category: string,
  ): Promise<{ id: string; category: string } | null> {
    try {
      return await this.prisma.chartinkScanner.update({
        where: { id },
        data: { category },
        select: { id: true, category: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  }

  async findChartinkSourceForSetup(setupId: string) {
    const row = await this.prisma.chartinkAlertSetup.findFirst({
      where: { setupId },
      include: { alert: { include: { scanner: true } } },
    });
    if (!row) return null;
    return {
      scannerName: row.alert.scanner.scanName,
      scannerUrl: row.alert.scanner.scanUrl,
      alertId: row.alertId,
    };
  }
}
