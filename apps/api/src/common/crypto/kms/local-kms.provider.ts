import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getEncryptionKey } from '../encryption-key';
import { DataKey, KmsProvider } from './kms-provider.interface';

@Injectable()
export class LocalKmsProvider implements KmsProvider {
  keyVersion(): string { return 'local-v1'; }

  /** AES-256-GCM wrap of `plaintext` under the master key. Format: v1:iv:tag:ct (base64). */
  private wrap(plaintext: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
  }

  async generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(32);
    return { plaintext, wrapped: this.wrap(plaintext), keyVersion: this.keyVersion() };
  }

  async wrapKey(plaintext: Buffer): Promise<{ wrapped: string; keyVersion: string }> {
    return { wrapped: this.wrap(plaintext), keyVersion: this.keyVersion() };
  }

  /**
   * Unwrap a per-user data key with the master key.
   *
   * THIS IS THE FIRST DOOR, and its error message matters more than any other
   * in the vault. Every broker read — quote, candles, option chain, positions —
   * begins by unwrapping this key. When the master key is wrong, Node's AES-GCM
   * throws "Unsupported state or unable to authenticate data", which names a
   * crypto fault but arrives at the caller through a BROKER session. It reads,
   * convincingly, as the exchange rejecting a login.
   *
   * A full day was spent on that reading: every market-data call failed with it,
   * the conclusion drawn was "the Angel session is broken", and the hunt went
   * looking for a broker fault that did not exist. The credentials were intact
   * the whole time; the process simply held a different `ENCRYPTION_KEY` than
   * the one that sealed them — the ordinary consequence of running locally
   * against a database written by the deployed app.
   *
   * A wrong key and a tampered blob are genuinely indistinguishable to GCM, so
   * this claims no more than it knows: the failure is local, it concerns keys,
   * and no broker was contacted.
   */
  async unwrapKey(wrapped: string): Promise<Buffer> {
    const [v, ivB64, tagB64, ctB64] = wrapped.split(':');
    if (v !== 'v1') throw new Error(`Unsupported wrapped-key version: ${v}`);
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        getEncryptionKey(),
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unsupported state or unable to authenticate data/i.test(message)) {
        throw new Error(
          'MASTER KEY MISMATCH — could not unwrap this user’s data key. This is a LOCAL ' +
            'key problem, NOT a broker rejection and NOT bad credentials: ENCRYPTION_KEY in ' +
            'this process differs from the one used when the credential was saved (typically ' +
            'running locally against a database written by the deployed app). No broker was ' +
            'contacted. Every market-data read for this user will fail until the keys match.',
        );
      }
      throw err;
    }
  }
}
