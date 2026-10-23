import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { TG_CLIENT_FACTORY, TgClient, TgClientFactory, floodWaitSeconds, rpcCode } from '../client/telegram-client.port';
import { TelegramSessionStore } from './telegram-session.store';
import { TelegramListenerService } from './telegram-listener.service';

export type ConnectStage = 'code' | 'password' | 'connected';

interface PendingLogin {
  client: TgClient;
  apiId: number;
  apiHash: string;
  phone: string;
  phoneCodeHash: string;
  stage: 'code' | 'password';
  expiresAt: number;
}

/** A login started but not confirmed is dropped after this. Telegram codes expire around then too. */
export const PENDING_TTL_MS = 10 * 60_000;

/** Telegram auth errors mapped to messages the owner can act on (never echoing phone or code). */
const FRIENDLY: Record<string, string> = {
  PHONE_NUMBER_INVALID: 'Telegram says the phone number is invalid. Use the international format, e.g. +91…',
  PHONE_NUMBER_BANNED: 'Telegram reports this phone number is banned.',
  PHONE_NUMBER_UNOCCUPIED: 'This phone number has no Telegram account.',
  API_ID_INVALID: 'Telegram rejected the api_id / api_hash pair. Copy both again from my.telegram.org.',
  API_ID_PUBLISHED_FLOOD: 'This api_id is blocked by Telegram. Create a new app at my.telegram.org.',
  PHONE_CODE_INVALID: 'The login code is wrong. Check the code Telegram sent and try again.',
  PHONE_CODE_EMPTY: 'Enter the login code Telegram sent you.',
  PHONE_CODE_EXPIRED: 'The login code expired. Start again to get a new code.',
  PASSWORD_HASH_INVALID: 'The two-step verification password is wrong.',
};

/**
 * Owner connect flow (state machine):
 *   start(apiId, apiHash, phone)  -> sends the code           -> stage 'code'
 *   confirm(code[, password])     -> 'connected' | 'password' (2FA account, no password given)
 *   confirm(password)             -> 'connected'               (from stage 'password')
 *   cancel()                      -> drops the pending login
 * On 'connected' the StringSession is sealed by TelegramSessionStore and the listener restarts.
 * Nothing secret is returned or logged.
 */
@Injectable()
export class TelegramAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramAuthService.name);
  private readonly pending = new Map<string, PendingLogin>();
  now: () => number = () => Date.now();

  constructor(
    @Inject(TG_CLIENT_FACTORY) private readonly factory: TgClientFactory,
    private readonly store: TelegramSessionStore,
    private readonly listener: TelegramListenerService,
  ) {}

  pendingStage(userId: string): 'code' | 'password' | null {
    const p = this.live(userId);
    return p ? p.stage : null;
  }

  async start(
    userId: string,
    input: { apiId: number; apiHash: string; phone: string },
  ): Promise<{ stage: ConnectStage }> {
    await this.drop(userId);
    const phone = normalizePhone(input.phone);
    const client = this.factory.create(input.apiId, input.apiHash, '');
    try {
      await client.connect();
      const { phoneCodeHash } = await client.sendCode(phone);
      this.pending.set(userId, {
        client,
        apiId: input.apiId,
        apiHash: input.apiHash,
        phone,
        phoneCodeHash,
        stage: 'code',
        expiresAt: this.now() + PENDING_TTL_MS,
      });
      return { stage: 'code' };
    } catch (err) {
      await safeDisconnect(client);
      throw toHttp(err);
    }
  }

  async confirm(
    userId: string,
    input: { code?: string; password?: string },
    reqMeta: Record<string, unknown> = {},
  ): Promise<{ stage: ConnectStage }> {
    const p = this.live(userId);
    if (!p) throw new ConflictException('No login in progress (or it expired). Start again.');
    try {
      if (p.stage === 'code') {
        const code = (input.code ?? '').replace(/\D/g, '');
        if (!code) throw new BadRequestException('Enter the login code Telegram sent you.');
        const r = await p.client.signIn(p.phone, p.phoneCodeHash, code);
        if (r === 'password_needed') {
          p.stage = 'password';
          if (!input.password) return { stage: 'password' };
        }
      }
      if (p.stage === 'password') {
        if (!input.password) throw new BadRequestException('This account has two-step verification: enter its password.');
        await p.client.signInWithPassword(input.password);
      }
      const session = p.client.exportSession();
      await this.store.save(userId, { apiId: p.apiId, apiHash: p.apiHash, session, phone: p.phone }, reqMeta);
    } catch (err) {
      const code = rpcCode(err);
      // A dead code needs a new one; anything else keeps the login open so the owner can retry.
      if (code === 'PHONE_CODE_EXPIRED') await this.drop(userId);
      throw toHttp(err);
    }
    await this.drop(userId);
    this.logger.log('telegram-reader: owner session connected');
    void this.listener.restart();
    return { stage: 'connected' };
  }

  async cancel(userId: string): Promise<void> {
    await this.drop(userId);
  }

  async onModuleDestroy(): Promise<void> {
    for (const userId of [...this.pending.keys()]) await this.drop(userId);
  }

  private live(userId: string): PendingLogin | null {
    const p = this.pending.get(userId);
    if (!p) return null;
    if (p.expiresAt <= this.now()) {
      void this.drop(userId);
      return null;
    }
    return p;
  }

  private async drop(userId: string): Promise<void> {
    const p = this.pending.get(userId);
    if (!p) return;
    this.pending.delete(userId);
    await safeDisconnect(p.client);
  }
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  return `+${digits}`;
}

async function safeDisconnect(client: TgClient): Promise<void> {
  try {
    await client.disconnect();
  } catch {
    // already gone
  }
}

function toHttp(err: unknown): Error {
  if (err instanceof HttpException) return err;
  const flood = floodWaitSeconds(err);
  if (flood !== null) {
    return new HttpException(
      `Telegram asks to wait ${flood} s before trying again (flood control).`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  const code = rpcCode(err);
  if (code && FRIENDLY[code]) return new BadRequestException(FRIENDLY[code]);
  if (code) return new BadRequestException(`Telegram refused the login (${code}).`);
  return new HttpException('Could not reach Telegram. Try again shortly.', HttpStatus.BAD_GATEWAY);
}
