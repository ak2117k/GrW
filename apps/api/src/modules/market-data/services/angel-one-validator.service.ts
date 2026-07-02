import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
// @ts-ignore — smartapi-javascript has no type declarations
import { SmartAPI } from 'smartapi-javascript';
import { generateTOTP } from '../utils/angel-one-totp';

/** Minimal shape of the SmartAPI client we exercise (login only). */
export interface SmartApiLike {
  generateSession(clientId: string, password: string, totp: string): Promise<any>;
}

/** Builds a throwaway SmartAPI client for one validation attempt. */
export type SmartApiFactory = (apiKey: string) => SmartApiLike;

/** DI token for an overridable SmartAPI factory (defaults to the real client). */
export const SMARTAPI_FACTORY = Symbol('SMARTAPI_FACTORY');

export interface ValidateCreds {
  apiKey: string;
  clientId: string;
  password: string;
  totpSecret: string;
}

export interface ValidateResult {
  success: boolean;
  clientName?: string;
  reason?: string;
}

/**
 * Validates a user's Angel One credentials via a REAL but EPHEMERAL login
 * (TDA-005 §5). Creates a throwaway SmartAPI client, computes a fresh TOTP from
 * the submitted secret, calls `generateSession`, and immediately discards the
 * session — no token retention, no scheduled refresh.
 *
 * CRITICAL: this NEVER touches the market-data singleton (`AngelOneAuthService`).
 * A user's connect attempt can never clobber the global engine feed session.
 *
 * Failures return a GENERIC reason to the caller; the raw broker error is logged
 * server-side at `warn` with the secrets stripped (never the password/TOTP).
 */
@Injectable()
export class AngelOneValidator {
  private readonly logger = new Logger(AngelOneValidator.name);
  private readonly factory: SmartApiFactory;

  constructor(
    @Optional() @Inject(SMARTAPI_FACTORY) factory?: SmartApiFactory,
  ) {
    this.factory = factory ?? ((apiKey: string) => new SmartAPI({ api_key: apiKey }));
  }

  async validateLogin(creds: ValidateCreds): Promise<ValidateResult> {
    const client = this.factory(creds.apiKey);
    try {
      const totp = generateTOTP(creds.totpSecret);
      const session = await client.generateSession(creds.clientId, creds.password, totp);
      if (!session?.data?.jwtToken) {
        // No throw, but no session either — treat as a rejected login.
        this.logger.warn(
          `Angel One validation for client ${maskClientId(creds.clientId)} returned no session`,
        );
        return { success: false, reason: 'Angel One rejected the credentials' };
      }
      return { success: true, clientName: session.data.name };
    } catch (error) {
      // Log the broker error WITHOUT the password/TOTP (they are never in `creds`
      // interpolated below; the error message itself may echo a masked id only).
      this.logger.warn(
        `Angel One validation failed for client ${maskClientId(creds.clientId)}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return { success: false, reason: 'Angel One rejected the credentials' };
    }
  }
}

/** e.g. "AB1234" -> "A•••34" (defensive: short ids collapse gracefully). */
function maskClientId(clientId: string): string {
  if (!clientId) return '••';
  if (clientId.length <= 2) return `${clientId[0] ?? ''}••`;
  return `${clientId[0]}•••${clientId.slice(-2)}`;
}
