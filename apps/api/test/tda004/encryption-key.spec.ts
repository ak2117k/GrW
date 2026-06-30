import { getEncryptionKey } from '../../src/common/crypto/encryption-key';
import { MissingSecretError } from '../../src/common/secrets/secrets-provider.interface';
import * as fs from 'fs';
import * as path from 'path';

describe('getEncryptionKey', () => {
  const orig = process.env.ENCRYPTION_KEY;
  afterEach(() => { process.env.ENCRYPTION_KEY = orig; });

  it('derives a 32-byte key from ENCRYPTION_KEY', () => {
    process.env.ENCRYPTION_KEY = 'a-real-passphrase-of-sufficient-length';
    expect(getEncryptionKey()).toHaveLength(32);
  });
  it('throws (no default) when ENCRYPTION_KEY is unset', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => getEncryptionKey()).toThrow(MissingSecretError);
  });

  it('the public default-key sentinel no longer exists in source (regression guard)', () => {
    const src = path.resolve(__dirname, '../../src/modules/broker/services/broker.service.ts');
    expect(fs.readFileSync(src, 'utf8')).not.toContain('td-automation-default-key-change-me');
  });
});
