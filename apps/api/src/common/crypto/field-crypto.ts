import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Interim AES-256-GCM field encryption for sensitive column values
 * (e.g. the TOTP secret in `User.mfaSecretEnc`).
 *
 * The encryption key is derived as sha256(process.env.ENCRYPTION_KEY), giving a
 * fixed 32-byte key regardless of the configured passphrase length.
 *
 * Output format: base64(iv) ":" base64(authTag) ":" base64(ciphertext)
 *
 * NOTE: This is an interim helper keyed off the `ENCRYPTION_KEY` env var. It is
 * flagged for migration to KMS envelope encryption in TDA-005.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptField(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptField(cipher: string): string {
  const parts = cipher.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format: expected iv:tag:ciphertext');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}
