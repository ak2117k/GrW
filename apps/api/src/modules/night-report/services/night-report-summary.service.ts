import { Injectable, Logger } from '@nestjs/common';
import { nightReportAdvisorSummary } from '../domain/night-report.advisor-summary';
import { NightReportService } from './night-report.service';

const CACHE_MS = 10 * 60_000;

/**
 * Read-only, exported face of the night report for other modules (the AI advisor). Returns a small
 * text digest (top sections only), cached per user for 10 min so a chat does not rebuild the whole
 * report on every question. Fail-soft: null on any error.
 */
@Injectable()
export class NightReportSummaryService {
  private readonly logger = new Logger(NightReportSummaryService.name);
  private readonly cache = new Map<string, { at: number; text: string }>();

  constructor(private readonly report: NightReportService) {}

  async summaryFor(userId: string, now: Date = new Date()): Promise<string | null> {
    const hit = this.cache.get(userId);
    if (hit && now.getTime() - hit.at < CACHE_MS) return hit.text;
    try {
      const text = nightReportAdvisorSummary(await this.report.build(userId, now));
      this.cache.set(userId, { at: now.getTime(), text });
      return text;
    } catch (err) {
      this.logger.warn(`night-report summary failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
