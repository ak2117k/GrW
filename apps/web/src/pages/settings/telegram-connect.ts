/**
 * Pure form logic for the Telegram connect flow (kept out of the component so vitest covers it).
 * Steps: credentials -> code -> (password, only for 2FA accounts) -> connected.
 */

export type ConnectStep = 'credentials' | 'code' | 'password' | 'connected';

export interface CredentialsForm {
  apiId: string;
  apiHash: string;
  phone: string;
}

export const MAX_CHANNELS = 10;

export function validateCredentials(f: CredentialsForm): string | null {
  if (!/^\d{1,12}$/.test(f.apiId.trim()) || Number(f.apiId) < 1) return 'api_id is the number shown at my.telegram.org.';
  if (!/^[a-f0-9]{32}$/i.test(f.apiHash.trim())) return 'api_hash is the 32-character code shown at my.telegram.org.';
  const digits = f.phone.replace(/\D/g, '');
  if (!f.phone.trim().startsWith('+') || digits.length < 7 || digits.length > 15) {
    return 'Phone must be in international format, e.g. +91 98xxx xxxxx.';
  }
  return null;
}

export function toStartPayload(f: CredentialsForm): { apiId: number; apiHash: string; phone: string } {
  return { apiId: Number(f.apiId.trim()), apiHash: f.apiHash.trim(), phone: f.phone.trim() };
}

/** Telegram login codes are digits; people paste them with spaces or dashes. */
export function cleanCode(code: string): string {
  return code.replace(/\D/g, '');
}

export function validateCode(code: string): string | null {
  const c = cleanCode(code);
  return c.length >= 5 && c.length <= 6 ? null : 'Enter the 5–6 digit code Telegram sent you.';
}

/** Where to resume when the page loads mid-login. */
export function stepFromStatus(s: { connected: boolean; pending: 'code' | 'password' | null }): ConnectStep {
  if (s.pending) return s.pending;
  return s.connected ? 'connected' : 'credentials';
}

/** Toggle a channel in the selection, never exceeding the cap. Returns the same set when refused. */
export function toggleChannel(selected: string[], id: string, max = MAX_CHANNELS): string[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  if (selected.length >= max) return selected;
  return [...selected, id];
}

export function sameSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** Pull the server's message out of an axios error without ever echoing what the user typed. */
export function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { message?: unknown } } };
  const m = e?.response?.data?.message;
  if (typeof m === 'string' && m) return m;
  if (Array.isArray(m) && typeof m[0] === 'string') return m[0];
  return fallback;
}
