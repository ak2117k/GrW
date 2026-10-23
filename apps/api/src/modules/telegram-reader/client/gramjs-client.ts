import { Injectable } from '@nestjs/common';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { EditedMessage, EditedMessageEvent } from 'telegram/events/EditedMessage';
import { Logger as GramLogger, LogLevel } from 'telegram/extensions/Logger';
import { computeCheck } from 'telegram/Password';
import { SignInResult, TgClient, TgClientFactory, TgDialog, TgIncomingMessage, rpcCode } from './telegram-client.port';

/**
 * GramJS (MTProto, the owner's USER account — not a bot) behind the TgClient port.
 * GramJS's own logger is silenced: it would otherwise print connection chatter, and nothing
 * secret may ever reach a log. Floods shorter than `floodSleepThreshold` are slept through by
 * GramJS itself; longer ones surface as FloodWaitError and the callers back off.
 */
class GramJsClient implements TgClient {
  private readonly client: TelegramClient;
  private readonly session: StringSession;

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
    sessionString: string,
  ) {
    this.session = new StringSession(sessionString);
    this.client = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 2000,
      autoReconnect: true,
      floodSleepThreshold: 60,
      baseLogger: new GramLogger(LogLevel.NONE),
      deviceModel: 'GrW reader',
      appVersion: '1.0',
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    // destroy() also stops the update loop; disconnect() alone leaves timers behind.
    await this.client.destroy();
  }

  isConnected(): boolean {
    return this.client.connected === true;
  }

  async sendCode(phone: string): Promise<{ phoneCodeHash: string }> {
    const r = await this.client.sendCode({ apiId: this.apiId, apiHash: this.apiHash }, phone);
    return { phoneCodeHash: r.phoneCodeHash };
  }

  async signIn(phone: string, phoneCodeHash: string, code: string): Promise<SignInResult> {
    try {
      const r = await this.client.invoke(
        new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }),
      );
      if (r instanceof Api.auth.AuthorizationSignUpRequired) {
        throw Object.assign(new Error('This phone number has no Telegram account'), { errorMessage: 'PHONE_NUMBER_UNOCCUPIED' });
      }
      return 'ok';
    } catch (err) {
      if (rpcCode(err) === 'SESSION_PASSWORD_NEEDED') return 'password_needed';
      throw err;
    }
  }

  async signInWithPassword(password: string): Promise<void> {
    const srp = await this.client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(srp, password);
    await this.client.invoke(new Api.auth.CheckPassword({ password: check }));
  }

  exportSession(): string {
    return this.session.save();
  }

  async listDialogs(): Promise<TgDialog[]> {
    const dialogs = await this.client.getDialogs({});
    const out: TgDialog[] = [];
    for (const d of dialogs) {
      if (!(d.isChannel || d.isGroup) || d.id === undefined) continue;
      const ent = d.entity as { username?: string; participantsCount?: number } | undefined;
      out.push({
        tgChannelId: d.id.toString(),
        title: d.title ?? '(untitled)',
        username: ent?.username ?? null,
        memberCount: typeof ent?.participantsCount === 'number' ? ent.participantsCount : null,
        kind: d.isGroup ? 'group' : 'channel',
      });
    }
    return out;
  }

  async subscribeUpdates(): Promise<void> {
    await this.client.getMe();
    await this.client.invoke(new Api.updates.GetState());
    await this.client.getDialogs({ limit: 200 });
  }

  async recentMessages(chatId: string, limit: number): Promise<TgIncomingMessage[]> {
    const msgs = await this.client.getMessages(chatId, { limit });
    return msgs.filter((m): m is Api.Message => m instanceof Api.Message).map((m) => toIncoming(m, false));
  }

  onMessage(handler: (m: TgIncomingMessage) => void): void {
    this.client.addEventHandler((e: NewMessageEvent) => handler(toIncoming(e.message, false)), new NewMessage({}));
    this.client.addEventHandler(
      (e: EditedMessageEvent) => handler(toIncoming(e.message, true)),
      new EditedMessage({}),
    );
  }

  async logOut(): Promise<void> {
    await this.client.invoke(new Api.auth.LogOut());
  }
}

function toIncoming(m: Api.Message, edited: boolean): TgIncomingMessage {
  const media = m.media;
  const hasMedia =
    !!media && !(media instanceof Api.MessageMediaEmpty) && !(media instanceof Api.MessageMediaWebPage);
  return {
    chatId: m.chatId ? m.chatId.toString() : '',
    tgMessageId: m.id,
    date: m.date,
    editDate: m.editDate ?? null,
    text: m.message ?? '',
    hasMedia,
    edited,
    raw: {
      id: m.id,
      chatId: m.chatId ? m.chatId.toString() : null,
      date: m.date,
      editDate: m.editDate ?? null,
      post: m.post ?? null,
      postAuthor: m.postAuthor ?? null,
      views: m.views ?? null,
      groupedId: m.groupedId ? m.groupedId.toString() : null,
      replyToMsgId: m.replyTo && 'replyToMsgId' in m.replyTo ? (m.replyTo.replyToMsgId ?? null) : null,
      forwarded: !!m.fwdFrom,
      mediaType: media ? media.className : null,
    },
  };
}

@Injectable()
export class GramJsClientFactory implements TgClientFactory {
  create(apiId: number, apiHash: string, session: string): TgClient {
    return new GramJsClient(apiId, apiHash, session);
  }
}
