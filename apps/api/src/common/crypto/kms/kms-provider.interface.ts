export const KMS_PROVIDER = Symbol('KMS_PROVIDER');
export interface DataKey { plaintext: Buffer; wrapped: string; keyVersion: string; }
export interface KmsProvider {
  generateDataKey(): Promise<DataKey>;
  unwrapKey(wrapped: string): Promise<Buffer>;
  keyVersion(): string;
}
