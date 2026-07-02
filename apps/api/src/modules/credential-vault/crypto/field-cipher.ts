import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * DEK-keyed field encryption for the per-tenant credential vault (TDA-005 §3.2).
 *
 * Distinct from `common/crypto/field-crypto.ts` (which keys off the ambient
 * `ENCRYPTION_KEY` for `User.mfaSecretEnc`): these functions take the unwrapped
 * per-user data key (DEK) as an explicit `Buffer` argument — there is NO ambient
 * key. The vault unwraps the DEK via the KMS provider and passes it in.
 *
 * Wire format mirrors `field-crypto.ts` for review familiarity:
 *   base64(iv) ":" base64(authTag) ":" base64(ciphertext)
 * with AES-256-GCM and a fresh 12-byte IV per call.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length

/** Encrypt `plain` under `dataKey` (32-byte DEK). Returns `iv:tag:ct` (base64). */
export function encryptWithDataKey(plain: string, dataKey: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

/** Decrypt an `iv:tag:ct` (base64) blob under `dataKey`. Throws on tamper / wrong key. */
export function decryptWithDataKey(blob: string, dataKey: Buffer): string {
  const parts = blob.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format: expected iv:tag:ct');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
