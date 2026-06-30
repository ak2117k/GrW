import { createHash } from 'crypto';
import { MissingSecretError } from '../secrets/secrets-provider.interface';

/** The single source of the field-encryption key. sha256(ENCRYPTION_KEY) → 32 bytes.
 *  Throws when unset — there is deliberately NO default (see TDA-004 §5). */
export function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new MissingSecretError('ENCRYPTION_KEY');
  return createHash('sha256').update(secret, 'utf8').digest();
}
