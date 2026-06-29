// Pure localStorage helpers for auth tokens. Kept dependency-free (no store,
// no axios) so both the shared api instance (request/response interceptors)
// and the Zustand auth-store can read/write tokens without an import cycle.
import type { TokenPair } from './auth';

export const ACCESS_TOKEN_KEY = 'td_access';
export const REFRESH_TOKEN_KEY = 'td_refresh';

export function getStoredAccessToken(): string | null {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeTokens(pair: TokenPair): void {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, pair.accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, pair.refreshToken);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function clearStoredTokens(): void {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    /* storage unavailable — non-fatal */
  }
}
