import { Injectable } from '@nestjs/common';
import { MissingSecretError, SecretsProvider } from './secrets-provider.interface';

/** Dev/test default. Reads from process.env (loaded by load-env.ts). No defaults. */
@Injectable()
export class EnvSecretsProvider implements SecretsProvider {
  async getSecret(name: string): Promise<string | undefined> {
    const v = process.env[name];
    return v == null || v === '' ? undefined : v;
  }
  async getRequiredSecret(name: string): Promise<string> {
    const v = await this.getSecret(name);
    if (v === undefined) throw new MissingSecretError(name);
    return v;
  }
}
