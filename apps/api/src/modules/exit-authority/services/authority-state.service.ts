import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { parseAuthorityMode } from '../exit-authority.config';
import type { AuthorityStatePort } from '../exit-authority.tokens';
import { TelegramBotClient } from '../telegram/telegram-bot.client';

/** Optional env override (tests); production reads process.env. */
export const AUTHORITY_ENV = Symbol('AUTHORITY_ENV');

const LOG_PREFIX = '[exit-authority]';

/**
 * The effective TRADE_AGENT_AUTHORITY mode (global constraint): `live` is honoured only after the boot check
 * — TELEGRAM_ALERT_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID set AND a test sendMessage returned ok. Anything else
 * leaves the effective mode `off`, with ERROR `[exit-authority] TRADE_AGENT_AUTHORITY=live refused: <why>`.
 *
 * isLive() is false until the check completes. The check does not block boot (it is not awaited by Nest);
 * `ready` settles when it is done.
 */
@Injectable()
export class AuthorityStateService implements AuthorityStatePort, OnModuleInit {
  private readonly log = new Logger(AuthorityStateService.name);
  private live = false;
  private started: Promise<void> | null = null;

  constructor(
    private readonly telegram: TelegramBotClient,
    @Optional() @Inject(AUTHORITY_ENV) private readonly env?: Record<string, string | undefined>,
  ) {}

  isLive(): boolean {
    return this.live;
  }

  /** Settles when the boot check has finished (immediately resolved before onModuleInit). */
  get ready(): Promise<void> {
    return this.started ?? Promise.resolve();
  }

  onModuleInit(): void {
    this.started = this.bootCheck();
  }

  /** Exposed for tests; runs once per process via onModuleInit. */
  async bootCheck(): Promise<void> {
    const env = this.env ?? process.env;
    const mode = parseAuthorityMode(env);
    if (mode !== 'live') {
      this.live = false;
      this.log.log(`${LOG_PREFIX} TRADE_AGENT_AUTHORITY=off: rule sellers act as today, no alarms, no owner escalation`);
      return;
    }
    if (!(env.TELEGRAM_ALERT_BOT_TOKEN ?? '').trim()) return this.refuse('TELEGRAM_ALERT_BOT_TOKEN missing');
    if (!(env.TELEGRAM_ALERT_CHAT_ID ?? '').trim()) return this.refuse('TELEGRAM_ALERT_CHAT_ID missing');
    try {
      await this.telegram.sendMessage(
        'GrW exit authority: TRADE_AGENT_AUTHORITY=live boot check. Trade agents now decide every live exit; ' +
          'unanswered alarms come here with Exit / Hold buttons.',
      );
    } catch (err) {
      return this.refuse(`Telegram test message failed (${(err as Error)?.message ?? 'error'})`);
    }
    this.live = true;
    this.log.warn(`${LOG_PREFIX} authority live: Telegram test message sent; trade agents hold live exit authority`);
  }

  private refuse(why: string): void {
    this.live = false;
    this.log.error(`${LOG_PREFIX} TRADE_AGENT_AUTHORITY=live refused: ${why}`);
  }
}
