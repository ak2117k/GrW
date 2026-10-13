import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobRunnerService } from '../../../common/job-registry';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import { isHubExchange } from '../../market-hub/hub.types';
import { istDate } from '../execution/ledger-math';
import { CoreCandles } from '../market/core-candles';
import { CORE_CORPUS, CORE_JOURNAL, type CoreCorpusPort, type CoreJournalPort } from './journal-ports';
import type { JournalRow } from './journal.types';
import { CoreJournalRepository } from './repositories/core-journal.repository';

export const CORE_SKIP_FOLLOWUP_JOB = 'core-skip-followup';
/** O14: a load bound on candle reads per night. */
export const FOLLOWUP_MAX_INSTRUMENTS = 300;
/** Shape bound on the rows one night reads. */
const FOLLOWUP_SCAN_TAKE = 20_000;
const FOLLOWUP_LEASE_MS = 60 * 60_000;
const BAR_MS = 60_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The close of the newest 1m bar that ended at or before t (ms); null when none has. */
export function priceAt(candles: readonly HubCandle[], t: number): number | null {
  let best: HubCandle | null = null;
  for (const c of candles) if (c.ts + BAR_MS <= t && (best === null || c.ts > best.ts)) best = c;
  return best ? best.close : null;
}

export const sessionCloseMs = (day: string): number => Date.parse(`${day}T15:30:00.000+05:30`);

/**
 * Spec §8.1 / J14: what price did next for every intent the core skipped or rejected today, so skip
 * accuracy is measurable. After the close (no exchange competes for the historical lane), one 1m
 * read per instrument from the hub candle store, PRICE_FOLLOWUP rows keyed to the skip row
 * (idempotent), and the same two prices merged into the corpus outcome.
 */
@Injectable()
export class SkipFollowupCron {
  private readonly logger = new Logger(SkipFollowupCron.name);

  constructor(
    private readonly journalRepo: CoreJournalRepository,
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
    private readonly candles: CoreCandles,
    @Inject(CORE_CORPUS) private readonly corpus: CoreCorpusPort,
    private readonly jobs: JobRunnerService,
  ) {}

  @Cron('0 10 16 * * 1-5', { name: CORE_SKIP_FOLLOWUP_JOB, timeZone: 'Asia/Kolkata' })
  async nightly(): Promise<void> {
    await this.run(new Date());
  }

  async run(now: Date): Promise<void> {
    const day = istDate(now);
    try {
      await this.jobs.run(CORE_SKIP_FOLLOWUP_JOB, { ttlMs: FOLLOWUP_LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const r = await this.followUp(day, now);
        this.logger.log(`skip follow-ups ${day}: ${r.skipped} skip(s), ${r.instruments} instrument(s), ${r.written} written, ${r.unpriced} unpriced`);
        return r;
      });
    } catch (err) {
      this.logger.error(`skip follow-ups ${day} failed: ${errorText(err)}`);
    }
  }

  async followUp(day: string, now: Date): Promise<{ skipped: number; instruments: number; written: number; unpriced: number }> {
    const rows = await this.journalRepo.listTypeOnDay('INTENT_SKIPPED', day, FOLLOWUP_SCAN_TAKE);
    const groups = new Map<string, JournalRow[]>();
    for (const r of rows) {
      const exchange = typeof r.payload.exchange === 'string' ? r.payload.exchange : '';
      const token = typeof r.payload.token === 'string' ? r.payload.token : '';
      if (!exchange || !token) continue;
      const key = `${exchange}:${token}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    let instruments = 0;
    let written = 0;
    let unpriced = 0;
    const close = sessionCloseMs(day);
    for (const [key, group] of groups) {
      const [exchange, token] = key.split(':');
      if (instruments >= FOLLOWUP_MAX_INSTRUMENTS || !isHubExchange(exchange)) {
        unpriced += group.length;
        continue;
      }
      instruments += 1;
      const read = await this.candles.read({ exchange, token, symbol: group[0].symbol ?? token }, '1m', new Date(`${day}T09:15:00.000+05:30`), new Date(close));
      if (!read.ok || read.candles.length === 0) {
        unpriced += group.length;
        continue;
      }
      for (const r of group) {
        const refPrice = typeof r.payload.ltp === 'number' ? r.payload.ltp : typeof r.payload.alertPrice === 'number' ? r.payload.alertPrice : null;
        const priceAfter30m = priceAt(read.candles, r.createdAt.getTime() + 30 * 60_000);
        const priceAfterClose = priceAt(read.candles, close);
        try {
          await this.journal.recordNow({
            type: 'PRICE_FOLLOWUP', userId: r.userId, at: now, strategyId: r.strategyId, strategyVersionId: r.strategyVersionId, intentId: r.intentId, symbol: r.symbol,
            payload: { skipId: r.id, reason: r.payload.reason ?? null, refPrice, priceAfter30m, priceAfterClose }, priceUsed: priceAfterClose, dedupeKey: `followup:${r.id}`,
          });
          written += 1;
        } catch (err) {
          this.logger.warn(`follow-up for skip ${r.id} not written: ${errorText(err)}`);
          continue;
        }
        if (r.intentId) {
          try {
            await this.corpus.outcome(r.intentId, { priceAfter30m, priceAfterClose }, now);
          } catch (err) {
            this.logger.warn(`corpus follow-up for ${r.intentId} not written: ${errorText(err)}`);
          }
        }
      }
    }
    return { skipped: rows.length, instruments, written, unpriced };
  }
}
