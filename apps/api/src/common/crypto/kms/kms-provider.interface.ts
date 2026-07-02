export const KMS_PROVIDER = Symbol('KMS_PROVIDER');
export interface DataKey { plaintext: Buffer; wrapped: string; keyVersion: string; }
export interface KmsProvider {
  generateDataKey(): Promise<DataKey>;
  unwrapKey(wrapped: string): Promise<Buffer>;
  /**
   * Wrap a data key we ALREADY hold under the current CMK version (TDA-005 §7.1).
   * Unlike generateDataKey (which mints a fresh random key), this re-wraps an
   * existing plaintext DEK — the primitive the key-rotation re-wrap job needs so
   * it can rotate the KEK without re-encrypting any field ciphertext. Additive,
   * backward-compatible extension to the TDA-004 seam.
   */
  wrapKey(plaintext: Buffer): Promise<{ wrapped: string; keyVersion: string }>;
  keyVersion(): string;
}
