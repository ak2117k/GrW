import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { ChartinkWebhookDto } from '../dto/chartink-webhook.dto';
import { ChartinkRepository } from '../repositories/chartink.repository';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

interface ParsedHit {
  symbol: string;
  hitPrice: number;
}

export interface ChartinkProcessJobData {
  alertId: string;
  hits: ParsedHit[];
}

@Injectable()
export class ChartinkIngestService {
  private readonly logger = new Logger(ChartinkIngestService.name);

  /**
   * Recent payload hashes for dedup. Keyed by payload-hash, value is the
   * alertId returned the first time. TTL'd to 60s — Chartink's retry
   * window is shorter than this in practice.
   */
  private readonly recentPayloads = new Map<
    string,
    { alertId: string; hitCount: number; receivedAt: number }
  >();
  private static readonly DEDUP_WINDOW_MS = 60_000;

  constructor(
    private readonly repo: ChartinkRepository,
    @InjectQueue('chartink-process') private readonly queue: Queue<ChartinkProcessJobData>,
  ) {}

  async ingest(payload: ChartinkWebhookDto): Promise<{ alertId: string; hitCount: number }> {
    const hash = this.payloadHash(payload);
    const now = Date.now();
    // Sweep stale entries (cheap, prevents unbounded growth)
    for (const [h, v] of this.recentPayloads) {
      if (now - v.receivedAt > ChartinkIngestService.DEDUP_WINDOW_MS) {
        this.recentPayloads.delete(h);
      }
    }
    const seen = this.recentPayloads.get(hash);
    if (seen && now - seen.receivedAt < ChartinkIngestService.DEDUP_WINDOW_MS) {
      this.logger.log(
        `Chartink dedup: identical payload received ${Math.round((now - seen.receivedAt) / 1000)}s ago — returning original alertId ${seen.alertId}`,
      );
      return { alertId: seen.alertId, hitCount: seen.hitCount };
    }

    const hits = this.parseHits(payload.stocks, payload.trigger_prices);
    const triggeredAt = this.deriveTriggeredAt(payload.triggered_at, new Date());

    const scanner = await this.repo.upsertScanner({
      scanUrl: payload.scan_url,
      scanName: payload.scan_name,
      alertName: payload.alert_name,
      firedAt: triggeredAt,
    });

    const alert = await this.repo.createAlert({
      scannerId: scanner.id,
      triggeredAt,
      rawPayload: payload as unknown as Prisma.InputJsonValue,
    });

    // Prioritise ANAND_SWING alerts in the process queue (Bull: lower number =
    // higher priority) so the intraday/swing dual-track — which has no score
    // filter and creates entries at the very top of processOne — jumps ahead of
    // the high-volume OTHER-scanner backlog instead of waiting behind it.
    const isAnandSwing = scanner.category === 'ANAND_SWING';
    await this.queue.add(
      'process',
      { alertId: alert.id, hits },
      isAnandSwing ? { priority: 1 } : {},
    );

    this.logger.log(
      `Ingested Chartink alert ${alert.id} (${payload.scan_name}) — ${hits.length} hits${isAnandSwing ? ' [ANAND_SWING — prioritised]' : ''}`,
    );

    this.recentPayloads.set(hash, {
      alertId: alert.id,
      hitCount: hits.length,
      receivedAt: now,
    });

    return { alertId: alert.id, hitCount: hits.length };
  }

  private payloadHash(body: ChartinkWebhookDto): string {
    // Hash includes the fields that matter for uniqueness. webhook_url is
    // Chartink echoing our URL — ignore. alert_name is human label — ignore.
    const canonical = JSON.stringify({
      scan_url: body.scan_url,
      stocks: body.stocks,
      trigger_prices: body.trigger_prices,
      triggered_at: body.triggered_at,
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  private parseHits(stocksCsv: string, pricesCsv: string): ParsedHit[] {
    const stocks = stocksCsv.split(',').map((s) => s.trim()).filter(Boolean);
    const prices = pricesCsv.split(',').map((s) => s.trim()).filter(Boolean);
    if (stocks.length !== prices.length) {
      throw new BadRequestException(
        `Chartink payload length mismatch: ${stocks.length} stocks vs ${prices.length} prices`,
      );
    }
    return stocks.map((symbol, i) => ({
      symbol,
      hitPrice: Number(prices[i]),
    }));
  }

  private deriveTriggeredAt(clockStr: string, now: Date): Date {
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);
    const m = clockStr.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
    if (!m) {
      throw new BadRequestException(`Cannot parse Chartink triggered_at: "${clockStr}"`);
    }
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const meridiem = m[3];
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const istMidnightUtc = Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate(),
      0, 0, 0, 0,
    );
    return new Date(istMidnightUtc + hour * 3600_000 + minute * 60_000 - IST_OFFSET_MS);
  }
}
