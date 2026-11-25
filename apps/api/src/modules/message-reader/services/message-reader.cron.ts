import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronLeaseService } from '../../../common/cron-lease/cron-lease.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { agentsOn } from '../../ai-gateway/agents/agent-registry';
import { deadReaderText, HEALTH_WINDOW_MS, readerUnhealthy, withinReaderWindow } from '../domain/reader-health';
import { MESSAGE_READER_CONFIG, type MessageReaderConfig } from '../message-reader.config';
import { MessageReaderRepository } from '../repositories/message-reader.repository';
import { MESSAGE_READER_AGENTS_ON, MESSAGE_READER_ALERT, MESSAGE_READER_NOW, type ReaderAlert } from './message-reader.service';

/** Every 5 min, 09:00–15:55 IST on weekdays; the 09:15–15:30 window and holidays are checked in code. */
export const MESSAGE_READER_HEALTH_CRON = '*/5 9-15 * * 1-5';
export const MESSAGE_READER_CLOCK = Symbol('MESSAGE_READER_CLOCK');
export const DEAD_READER_ALERT_KEY = 'message-reader-dead';
export const AGENTS_OFF_ALERT_KEY = 'message-reader-agents-off';
const LEASE_TTL_MS = 4 * 60_000;

export type HealthStore = Pick<MessageReaderRepository, 'countsSince' | 'lastFailure'>;
export interface TradingDayClock {
  isTradingDay(exchange: string, at?: Date): boolean;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Dead-reader check (spec §5.7, no silent absence): during NSE hours, ≥ 3 posts in the last 15 min and no
 * READ row → ops alert `message-reader-dead` (sendOpsAlert's 30-min cooldown stops repeats). Runs whenever
 * the reader is enabled — shadow and on alike — so a dead reader is caught before it is ever switched on.
 * MESSAGE_READER=shadow/on with the AI agents off reads nothing: warned once at boot, and in market hours
 * alerted as `message-reader-agents-off` instead of exiting silently.
 */
@Injectable()
export class MessageReaderCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(MessageReaderCron.name);

  constructor(
    @Inject(MessageReaderRepository) private readonly repo: HealthStore,
    @Inject(MESSAGE_READER_CONFIG) private readonly cfg: MessageReaderConfig,
    @Inject(MESSAGE_READER_CLOCK) private readonly clock: TradingDayClock,
    @Optional() private readonly lease?: CronLeaseService,
    @Optional() @Inject(MESSAGE_READER_NOW) private readonly nowFn?: () => Date,
    @Optional() @Inject(MESSAGE_READER_AGENTS_ON) private readonly agentsOnFn?: () => boolean,
    @Optional() @Inject(MESSAGE_READER_ALERT) private readonly alertFn?: ReaderAlert,
  ) {}

  private agentsOn(): boolean {
    return this.agentsOnFn ? this.agentsOnFn() : agentsOn();
  }

  private agentsOffText(): string {
    return `message-reader: MESSAGE_READER=${this.cfg.mode} but the AI agents are off, so no Telegram post is being read. Set AI_AGENTS=on and SENTINEL_JUDGE=vertex, or MESSAGE_READER=off.`;
  }

  /** The one boot-time line for a reader that is switched on but cannot read. */
  onApplicationBootstrap(): void {
    if (this.cfg.mode !== 'off' && !this.agentsOn()) this.logger.warn(`[message-reader] ${this.agentsOffText()}`);
  }

  @Cron(MESSAGE_READER_HEALTH_CRON, { name: 'message-reader-health', timeZone: 'Asia/Kolkata' })
  async onHealth(): Promise<void> {
    const now = this.nowFn ? this.nowFn() : new Date();
    if (this.cfg.mode === 'off') return;
    const agentsOff = !this.agentsOn();
    const marketOpen = this.clock.isTradingDay('NSE', now) && withinReaderWindow(now);
    if (!marketOpen) return; // no query outside NSE hours
    try {
      if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
      const job = agentsOff ? () => this.alertAgentsOff() : () => this.check(now, marketOpen);
      if (this.lease) await this.lease.runExclusiveFailClosed('message-reader-health', LEASE_TTL_MS, job);
      else await job();
    } catch (e) {
      this.logger.warn(`[message-reader] health check failed: ${errText(e)}`);
    }
  }

  private async alertAgentsOff(): Promise<void> {
    const text = this.agentsOffText();
    this.logger.warn(`[message-reader] ${text}`);
    await (this.alertFn ?? sendOpsAlert)(AGENTS_OFF_ALERT_KEY, text);
  }

  private async check(now: Date, marketOpen: boolean): Promise<void> {
    const counts = await this.repo.countsSince(new Date(now.getTime() - HEALTH_WINDOW_MS));
    const read15m = counts.byStatus.READ ?? 0;
    if (!readerUnhealthy({ posts15m: counts.posts, read15m, marketOpen })) return;
    const failure = await this.repo.lastFailure();
    const text = deadReaderText({ posts15m: counts.posts, lastReadAt: counts.lastReadAt, lastError: failure?.error ?? null }, now);
    this.logger.warn(`[message-reader] ${text}`);
    await (this.alertFn ?? sendOpsAlert)(DEAD_READER_ALERT_KEY, text);
  }
}
