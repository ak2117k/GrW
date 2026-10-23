import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TgMediaInfo, TgPhotoSize } from '../client/telegram-client.port';
import type { TelegramMediaRef } from '../telegram-reader.events';

/**
 * Which post media the reader downloads (2026-10-23: many MCX / tip channels post the call as an
 * image). Photos and small image documents only — never video, stickers, GIFs or other documents.
 * Pure: the listener does the I/O.
 */

/** Default media dir: inside the API container; map it to a persistent volume (deploy/docker-compose.prod.yml). */
export const DEFAULT_MEDIA_DIR = '/app/data/telegram-media';
/** A photo size above this is never fetched (a readable chart / call card is far smaller). */
export const PHOTO_MAX_BYTES = 1024 * 1024;
/** Image documents ("send as file") up to this size are fetched whole. */
export const DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
/** The smallest size whose longest side is at least this is "still readable" (text on a call card). */
export const READABLE_LONG_SIDE = 1000;
/** Below this longest side an image is a thumbnail, not readable. */
const MIN_LONG_SIDE = 320;
const IMAGE_DOC_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type MediaChoice =
  | { fetch: true; kind: 'photo'; sizeType: string; mimeType: 'image/jpeg'; expectBytes: number; w: number; h: number }
  | { fetch: true; kind: 'image-document'; sizeType: null; mimeType: string; expectBytes: number }
  | { fetch: false; reason: string };

/** The smallest photo size that is still readable and ≤ PHOTO_MAX_BYTES (else the largest that fits). */
export function pickPhotoSize(sizes: readonly TgPhotoSize[]): TgPhotoSize | null {
  const fits = sizes.filter((s) => s.w > 0 && s.h > 0 && s.bytes > 0 && s.bytes <= PHOTO_MAX_BYTES && Math.max(s.w, s.h) >= MIN_LONG_SIDE);
  if (fits.length === 0) return null;
  const readable = fits.filter((s) => Math.max(s.w, s.h) >= READABLE_LONG_SIDE).sort((a, b) => a.bytes - b.bytes);
  if (readable.length) return readable[0];
  return [...fits].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h))[0];
}

export function chooseMedia(info: TgMediaInfo | null | undefined): MediaChoice {
  if (!info) return { fetch: false, reason: 'no media' };
  if (info.kind === 'photo') {
    const s = pickPhotoSize(info.sizes);
    if (!s) return { fetch: false, reason: info.sizes.length ? 'no photo size ≤ 1 MB that is readable' : 'photo without sizes' };
    return { fetch: true, kind: 'photo', sizeType: s.type, mimeType: 'image/jpeg', expectBytes: s.bytes, w: s.w, h: s.h };
  }
  if (info.kind === 'image-document') {
    const mime = (info.mimeType ?? '').toLowerCase();
    if (!IMAGE_DOC_TYPES.has(mime)) return { fetch: false, reason: `image type ${mime || 'unknown'}` };
    if (info.sizeBytes === null || info.sizeBytes <= 0) return { fetch: false, reason: 'document size unknown' };
    if (info.sizeBytes > DOCUMENT_MAX_BYTES) return { fetch: false, reason: `document ${info.sizeBytes} bytes > 2 MB` };
    return { fetch: true, kind: 'image-document', sizeType: null, mimeType: mime, expectBytes: info.sizeBytes };
  }
  return { fetch: false, reason: `media kind ${info.kind} is not read` };
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Write the bytes under `<dir>/<YYYY-MM>/<channelId>_<tgMessageId>_<sha12>.<ext>` (never deletes,
 * never overwrites a file of the same name — the name carries the content hash).
 */
export async function saveMedia(
  dir: string,
  bytes: Buffer,
  meta: { channelId: string; tgMessageId: number; postedAt: Date; kind: TelegramMediaRef['kind']; mimeType: string },
): Promise<TelegramMediaRef> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const month = meta.postedAt.toISOString().slice(0, 7);
  const folder = join(dir, month);
  const path = join(folder, `${meta.channelId}_${meta.tgMessageId}_${sha256.slice(0, 12)}.${EXT[meta.mimeType] ?? 'bin'}`);
  await mkdir(folder, { recursive: true });
  const exists = await stat(path).then(() => true, () => false);
  if (!exists) await writeFile(path, bytes);
  return { kind: meta.kind, path, sha256, mimeType: meta.mimeType, bytes: bytes.length };
}
