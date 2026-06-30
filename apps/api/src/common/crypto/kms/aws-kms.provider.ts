import { DataKey, KmsProvider } from './kms-provider.interface';
import type { ConfigService } from '@nestjs/config';

/** PROD adapter (TDA-004 §4). NOT constructed unless KMS_PROVIDER=aws.
 *  Holds the sole KMS grant in prod (roadmap §2 isolated seam). Wired by TDA-005. */
export class AwsKmsProvider implements KmsProvider {
  private cmkId: string;
  constructor(private readonly config: ConfigService) {
    this.cmkId = config.get<string>('kms.cmkId') ?? '';
  }
  keyVersion(): string { return this.cmkId; }
  async generateDataKey(): Promise<DataKey> {
    const { KMSClient, GenerateDataKeyCommand } = await import('@aws-sdk/client-kms');
    const client = new KMSClient({});
    const out = await client.send(new GenerateDataKeyCommand({ KeyId: this.cmkId, KeySpec: 'AES_256' }));
    return {
      plaintext: Buffer.from(out.Plaintext as Uint8Array),
      wrapped: Buffer.from(out.CiphertextBlob as Uint8Array).toString('base64'),
      keyVersion: this.keyVersion(),
    };
  }
  async unwrapKey(wrapped: string): Promise<Buffer> {
    const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
    const client = new KMSClient({});
    const out = await client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(wrapped, 'base64') }));
    return Buffer.from(out.Plaintext as Uint8Array);
  }
}
