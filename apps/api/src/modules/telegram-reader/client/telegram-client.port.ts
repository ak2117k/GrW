/**
 * The narrow seam between the reader and GramJS. Everything above this file (auth state machine,
 * listener, channel picker) talks to this interface only, so tests drive it with a fake and the
 * GramJS types never leak into the services.
 */

export interface TgDialog {
  /** Marked peer id as text (channels/supergroups: "-100…", basic groups: "-…"). */
  tgChannelId: string;
  title: string;
  username: string | null;
  memberCount: number | null;
  kind: 'channel' | 'group';
}

export interface TgIncomingMessage {
  /** Marked peer id of the chat the message is in (same form as TgDialog.tgChannelId). */
  chatId: string;
  tgMessageId: number;
  /** Unix seconds. */
  date: number;
  /** Unix seconds; present on edits. */
  editDate: number | null;
  text: string;
  hasMedia: boolean;
  edited: boolean;
  /** Minimal, media-free metadata kept as rawPayload. */
  raw: Record<string, unknown>;
  /** What media the post carries (no bytes); null / absent for text posts. */
  media?: TgMediaInfo | null;
  /**
   * Download the media: a photo at the given size `type` (from `media.sizes`), or the whole document
   * (`sizeType` null). Absent in fakes / when the client cannot download.
   */
  download?: (sizeType: string | null) => Promise<Buffer | null>;
}

export type TgMediaKind = 'photo' | 'image-document' | 'video' | 'sticker' | 'gif' | 'document' | 'other';

export interface TgPhotoSize {
  type: string;
  w: number;
  h: number;
  bytes: number;
}

export interface TgMediaInfo {
  kind: TgMediaKind;
  mimeType: string | null;
  /** Document size in bytes (null for photos: see `sizes`). */
  sizeBytes: number | null;
  /** Photo sizes Telegram offers (stripped / path previews excluded). */
  sizes: TgPhotoSize[];
}

export type SignInResult = 'ok' | 'password_needed';

export interface TgClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  sendCode(phone: string): Promise<{ phoneCodeHash: string }>;
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<SignInResult>;
  signInWithPassword(password: string): Promise<void>;
  /** The StringSession to persist (secret). */
  exportSession(): string;
  listDialogs(): Promise<TgDialog[]>;
  /** New messages AND edits. Registered once per client. */
  onMessage(handler: (m: TgIncomingMessage) => void): void;
  /**
   * Tell Telegram this connection wants live updates (getMe + updates.GetState) and warm the entity
   * cache (dialogs). A session resumed with connect() alone receives no pushes until this is called
   * (prod 2026-10-23: received=0 from any chat for 10 min). Optional so test fakes can omit it.
   */
  subscribeUpdates?(): Promise<void>;
  /** The newest `limit` messages of a chat (marked id), newest first — the polling safety net. */
  recentMessages?(chatId: string, limit: number): Promise<TgIncomingMessage[]>;
  /** Revoke this session on Telegram's side (best effort). */
  logOut(): Promise<void>;
}

export interface TgClientFactory {
  create(apiId: number, apiHash: string, session: string): TgClient;
}

export const TG_CLIENT_FACTORY = Symbol('TG_CLIENT_FACTORY');

/** GramJS RPC errors carry `errorMessage` (e.g. PHONE_CODE_INVALID); FloodWaitError carries `seconds`. */
export function rpcCode(err: unknown): string | undefined {
  const e = err as { errorMessage?: unknown } | null;
  return e && typeof e.errorMessage === 'string' ? e.errorMessage : undefined;
}

export function floodWaitSeconds(err: unknown): number | null {
  const e = err as { seconds?: unknown } | null;
  const code = rpcCode(err);
  if (code && /^FLOOD(_PREMIUM)?_WAIT/.test(code) && e && typeof e.seconds === 'number') return e.seconds;
  if (code === 'FLOOD') return 60;
  return null;
}

/** Codes meaning the stored session is dead and needs a fresh login. */
export const SESSION_DEAD_CODES = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
]);
