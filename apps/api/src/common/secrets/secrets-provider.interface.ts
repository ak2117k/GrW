export const SECRETS_PROVIDER = Symbol('SECRETS_PROVIDER');

export class MissingSecretError extends Error {
  constructor(public readonly name: string) {
    super(`Required secret "${name}" is not set. Refusing to start with no value (no defaults).`);
    this.name = 'MissingSecretError';
  }
}

export interface SecretsProvider {
  getSecret(name: string): Promise<string | undefined>;
  getRequiredSecret(name: string): Promise<string>;
}
