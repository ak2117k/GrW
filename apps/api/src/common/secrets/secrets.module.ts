import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SECRETS_PROVIDER, SecretsProvider } from './secrets-provider.interface';
import { EnvSecretsProvider } from './env-secrets.provider';

export async function secretsProviderFactory(config: ConfigService): Promise<SecretsProvider> {
  const kind = config.get<string>('secrets.provider', 'local');
  if (kind === 'aws') {
    // Dynamic import so @aws-sdk is never required by the dev/test build.
    const { AwsSecretsProvider } = await import('./aws-secrets.provider');
    return new AwsSecretsProvider(config);
  }
  return new EnvSecretsProvider();
}

@Global()
@Module({
  providers: [{ provide: SECRETS_PROVIDER, useFactory: secretsProviderFactory, inject: [ConfigService] }],
  exports: [SECRETS_PROVIDER],
})
export class SecretsModule {}
