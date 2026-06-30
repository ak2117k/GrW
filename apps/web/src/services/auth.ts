import axios from 'axios';

// Dedicated axios instance for the auth routes. The backend mounts these
// at `/auth/*` (NOT under `/api`), so we point at the `/auth` Vite proxy.
// This instance is intentionally interceptor-free: it must never trigger
// the access-token refresh flow that lives on the shared `/api` instance
// (refreshing inside login/refresh would loop).
const authApi = axios.create({
  baseURL: '/auth',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

// `/auth/login` returns either a token pair (no MFA) or an MFA challenge
// (user has TOTP enabled). Discriminated on the presence of `mfaRequired`.
export type LoginResult = TokenPair | MfaChallenge;

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  mfaEnabled?: boolean;
  [key: string]: unknown;
}

export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return (result as MfaChallenge).mfaRequired === true;
}

export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  const res = await authApi.post<LoginResult>('/login', { email, password });
  return res.data;
}

export async function loginMfa(
  mfaToken: string,
  code: string,
): Promise<TokenPair> {
  const res = await authApi.post<TokenPair>('/login/mfa', { mfaToken, code });
  return res.data;
}

export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  const res = await authApi.post<TokenPair>('/refresh', { refreshToken });
  return res.data;
}

export async function getMe(accessToken: string): Promise<AuthUser> {
  const res = await authApi.get<AuthUser>('/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data;
}

export async function logout(accessToken: string): Promise<void> {
  await authApi.post(
    '/logout',
    {},
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

export async function signup(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ message: string; verificationToken?: string }> {
  const res = await authApi.post('/signup', { email, password, displayName });
  return res.data;
}

export async function verifyEmail(token: string): Promise<{ message: string }> {
  const res = await authApi.post('/verify-email', { token });
  return res.data;
}

export default authApi;
