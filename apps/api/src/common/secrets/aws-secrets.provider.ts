import type { ConfigService } from '@nestjs/config';
import { MissingSecretError, SecretsProvider } from './secrets-provider.interface';

/** PROD adapter (TDA-004 §4). NOT constructed unless SECRETS_PROVIDER=aws.
 *  @aws-sdk/client-secrets-manager is imported dynamically so the dev/test build
 *  never needs the package. Wired by TDA-005. */
export class AwsSecretsProvider implements SecretsProvider {
  constructor(private readonly config: ConfigService) {}

  async getSecret(name: string): Promise<string | undefined> {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({});
    const out = await client.send(new GetSecretValueCommand({ SecretId: name }));
    const v = out.SecretString;
    return v == null || v === '' ? undefined : v;
  }

  async getRequiredSecret(name: string): Promise<string> {
    const v = await this.getSecret(name);
    if (v === undefined) throw new MissingSecretError(name);
    return v;
  }
}
