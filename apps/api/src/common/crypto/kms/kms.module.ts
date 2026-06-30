import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KMS_PROVIDER, KmsProvider } from './kms-provider.interface';
import { LocalKmsProvider } from './local-kms.provider';

export async function kmsProviderFactory(config: ConfigService): Promise<KmsProvider> {
  const kind = config.get<string>('kms.provider', 'local');
  if (kind === 'aws') {
    // Dynamic import so @aws-sdk is never required by the dev/test build.
    const { AwsKmsProvider } = await import('./aws-kms.provider');
    return new AwsKmsProvider(config);
  }
  return new LocalKmsProvider();
}

@Global()
@Module({
  providers: [{ provide: KMS_PROVIDER, useFactory: kmsProviderFactory, inject: [ConfigService] }],
  exports: [KMS_PROVIDER],
})
export class KmsModule {}
