import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getEncryptionKey } from '../encryption-key';
import { DataKey, KmsProvider } from './kms-provider.interface';

@Injectable()
export class LocalKmsProvider implements KmsProvider {
  keyVersion(): string { return 'local-v1'; }

  async generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrapped = ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
    return { plaintext, wrapped, keyVersion: this.keyVersion() };
  }

  async unwrapKey(wrapped: string): Promise<Buffer> {
    const [v, ivB64, tagB64, ctB64] = wrapped.split(':');
    if (v !== 'v1') throw new Error(`Unsupported wrapped-key version: ${v}`);
    const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  }
}
