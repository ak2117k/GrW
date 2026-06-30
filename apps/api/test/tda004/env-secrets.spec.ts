import { EnvSecretsProvider } from '../../src/common/secrets/env-secrets.provider';
import { MissingSecretError } from '../../src/common/secrets/secrets-provider.interface';

describe('EnvSecretsProvider', () => {
  const p = new EnvSecretsProvider();
  afterEach(() => { delete process.env.__TDA004_T; });

  it('returns a present secret', async () => {
    process.env.__TDA004_T = 'hello';
    await expect(p.getSecret('__TDA004_T')).resolves.toBe('hello');
  });
  it('returns undefined for an absent secret (no throw)', async () => {
    await expect(p.getSecret('__TDA004_MISSING')).resolves.toBeUndefined();
  });
  it('getRequiredSecret throws MissingSecretError when absent', async () => {
    await expect(p.getRequiredSecret('__TDA004_MISSING')).rejects.toBeInstanceOf(MissingSecretError);
  });
  it('getRequiredSecret throws for an empty string (no silent default)', async () => {
    process.env.__TDA004_T = '';
    await expect(p.getRequiredSecret('__TDA004_T')).rejects.toBeInstanceOf(MissingSecretError);
  });
});
