import { Injectable } from '@nestjs/common';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { EditedMessage, EditedMessageEvent } from 'telegram/events/EditedMessage';
import { Logger as GramLogger, LogLevel } from 'telegram/extensions/Logger';
import { computeCheck } from 'telegram/Password';
import {
  SignInResult,
  TgClient,
  TgClientFactory,
  TgDialog,
  TgIncomingMessage,
  TgMediaInfo,
  TgMediaKind,
  TgPhotoSize,
  rpcCode,
} from './telegram-client.port';

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
    return msgs.filter((m): m is Api.Message => m instanceof Api.Message).map((m) => toIncoming(m, false, this.client));
  }

  async messageById(chatId: string, tgMessageId: number): Promise<TgIncomingMessage | null> {
    const msgs = await this.client.getMessages(chatId, { ids: [tgMessageId] });
    const m = msgs.find((x): x is Api.Message => x instanceof Api.Message);
    return m ? toIncoming(m, false, this.client) : null;
  }

  onMessage(handler: (m: TgIncomingMessage) => void): void {
    this.client.addEventHandler((e: NewMessageEvent) => handler(toIncoming(e.message, false, this.client)), new NewMessage({}));
    this.client.addEventHandler(
      (e: EditedMessageEvent) => handler(toIncoming(e.message, true, this.client)),
      new EditedMessage({}),
    );
  }

  async logOut(): Promise<void> {
    await this.client.invoke(new Api.auth.LogOut());
  }
}

function toIncoming(m: Api.Message, edited: boolean, client: TelegramClient): TgIncomingMessage {
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
    media: hasMedia ? mediaInfo(media) : null,
    download: hasMedia ? (sizeType) => downloadOf(client, m, sizeType) : undefined,
  };
}

/** Photo sizes with dimensions and a byte count (stripped / path / empty previews are skipped). */
function photoSizes(photo: Api.Photo): TgPhotoSize[] {
  const out: TgPhotoSize[] = [];
  for (const s of photo.sizes ?? []) {
    if (s instanceof Api.PhotoSize) out.push({ type: s.type, w: s.w, h: s.h, bytes: s.size });
    else if (s instanceof Api.PhotoCachedSize) out.push({ type: s.type, w: s.w, h: s.h, bytes: s.bytes?.length ?? 0 });
    else if (s instanceof Api.PhotoSizeProgressive) out.push({ type: s.type, w: s.w, h: s.h, bytes: Math.max(0, ...(s.sizes ?? [])) });
  }
  return out;
}

function mediaInfo(media: Api.TypeMessageMedia | undefined): TgMediaInfo | null {
  if (!media) return null;
  if (media instanceof Api.MessageMediaPhoto) {
    const photo = media.photo instanceof Api.Photo ? media.photo : null;
    return { kind: 'photo', mimeType: 'image/jpeg', sizeBytes: null, sizes: photo ? photoSizes(photo) : [] };
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document instanceof Api.Document ? media.document : null;
    if (!doc) return { kind: 'other', mimeType: null, sizeBytes: null, sizes: [] };
    const mime = doc.mimeType ?? null;
    const size = Number(String(doc.size ?? '0'));
    const attrs = doc.attributes ?? [];
    let kind: TgMediaKind = 'document';
    if (attrs.some((a) => a instanceof Api.DocumentAttributeSticker)) kind = 'sticker';
    else if (attrs.some((a) => a instanceof Api.DocumentAttributeAnimated) || mime === 'image/gif') kind = 'gif';
    else if (attrs.some((a) => a instanceof Api.DocumentAttributeVideo) || (mime ?? '').startsWith('video/')) kind = 'video';
    else if ((mime ?? '').startsWith('image/')) kind = 'image-document';
    return { kind, mimeType: mime, sizeBytes: Number.isFinite(size) ? size : null, sizes: [] };
  }
  return { kind: 'other', mimeType: null, sizeBytes: null, sizes: [] };
}

/** Bytes of the photo at size `sizeType`, or of the whole document; null when Telegram returns none. */
export async function downloadOf(client: TelegramClient, m: Api.Message, sizeType: string | null): Promise<Buffer | null> {
  if (sizeType !== null) {
    const photo = m.media instanceof Api.MessageMediaPhoto && m.media.photo instanceof Api.Photo ? m.media.photo : null;
    if (!photo?.sizes?.some((s) => 'type' in s && s.type === sizeType)) return null;
  }
  // The size by its TYPE string, never the size object: GramJS's getThumb (telegram@2.26) accepts a
  // PhotoSize / Cached / Stripped / Video object but not a PhotoSizeProgressive one, and then returns
  // Buffer.alloc(0) — every photo whose chosen size was progressive came back "empty download" (prod
  // 2026-10-26/27: 128 images). The string branch matches every size type, progressive included.
  // The .d.ts types `thumb` as number | PhotoSize, but downloads.js getThumb has a `typeof thumb == "string"` branch.
  const out = await client.downloadMedia(m, sizeType !== null ? { thumb: sizeType as unknown as number } : {});
  return Buffer.isBuffer(out) ? out : null;
}

@Injectable()
export class GramJsClientFactory implements TgClientFactory {
  create(apiId: number, apiHash: string, session: string): TgClient {
    return new GramJsClient(apiId, apiHash, session);
  }
}
