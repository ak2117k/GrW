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

/**
 * Node's GCM failure message, which is the same string whether the ciphertext
 * was tampered with or the key is simply the wrong one.
 */
const GCM_AUTH_FAILURE = /unsupported state or unable to authenticate data/i;

/**
 * Decrypt an `iv:tag:ct` (base64) blob under `dataKey`. Throws on tamper / wrong key.
 *
 * THE ERROR IS RE-WORDED ON PURPOSE, and it is worth more than it looks.
 *
 * When AES-GCM cannot verify the auth tag, Node throws "Unsupported state or
 * unable to authenticate data". That string names a CRYPTO fault, but it
 * reaches the caller through a broker session — so it surfaces at the top as a
 * broker read failing, and reads exactly like the exchange rejecting a login.
 *
 * That cost a full day. Quotes, candles and option chains all failed with it,
 * the conclusion drawn was "the Angel session is broken", and time went into a
 * broker problem that did not exist — while the real cause was a process
 * holding a DIFFERENT `ENCRYPTION_KEY` than the one the credential was sealed
 * with. The credentials were never the problem and the broker was never asked.
 *
 * A wrong key and a tampered blob genuinely are indistinguishable here — GCM is
 * designed that way — so this does not claim to tell them apart. It says what
 * IS known: the failure is local, it is about keys, and the broker is not
 * involved.
 */
export function decryptWithDataKey(blob: string, dataKey: Buffer): string {
  const parts = blob.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format: expected iv:tag:ct');
  }
  const [ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (GCM_AUTH_FAILURE.test(message)) {
      throw new Error(
        'CREDENTIAL DECRYPTION FAILED — this is a local key problem, NOT a broker ' +
          'rejection and NOT a bad username or password. The stored credential could not ' +
          'be unsealed with this process’s key, which almost always means ENCRYPTION_KEY ' +
          'here differs from the one used when the credential was saved (for example, ' +
          'running locally against a database whose rows were written by the deployed ' +
          'app). The broker was never contacted.',
      );
    }
    throw err;
  }
}
