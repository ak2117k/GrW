import { create } from 'zustand';
import type { AuthUser, TokenPair } from '@/services/auth';
import { getMe, logout as apiLogout } from '@/services/auth';
import {
  clearStoredTokens,
  getStoredAccessToken,
  getStoredRefreshToken,
  storeTokens,
} from '@/services/auth-storage';

export type AuthStatus = 'loading' | 'authed' | 'anon';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  status: AuthStatus;

  setTokens: (pair: TokenPair) => void;
  setUser: (user: AuthUser) => void;
  logout: () => Promise<void>;
  hydrate: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  refreshToken: null,
  user: null,
  status: 'loading',

  setTokens: (pair) => {
    storeTokens(pair);
    set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
  },

  setUser: (user) => set({ user, status: 'authed' }),

  logout: async () => {
    const token = get().accessToken ?? getStoredAccessToken();
    // Best-effort backend revoke — never block local logout on a failure.
    if (token) {
      try {
        await apiLogout(token);
      } catch {
        /* ignore — we clear local state regardless */
      }
    }
    clearStoredTokens();
    set({ accessToken: null, refreshToken: null, user: null, status: 'anon' });
  },

  hydrate: async () => {
    const accessToken = getStoredAccessToken();
    const refreshToken = getStoredRefreshToken();

    if (!accessToken) {
      set({ status: 'anon' });
      return;
    }

    set({ accessToken, refreshToken });

    try {
      const user = await getMe(accessToken);
      set({ user, status: 'authed' });
    } catch {
      // Access token may be expired. The shared api instance handles refresh
      // on protected /api calls; here we keep boot simple — if /auth/me fails
      // on a stored access token, try a one-shot refresh before giving up.
      const storedRefresh = getStoredRefreshToken();
      if (storedRefresh) {
        try {
          const { refreshTokens } = await import('@/services/auth');
          const pair = await refreshTokens(storedRefresh);
          storeTokens(pair);
          set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
          const user = await getMe(pair.accessToken);
          set({ user, status: 'authed' });
          return;
        } catch {
          /* fall through to anon */
        }
      }
      clearStoredTokens();
      set({ accessToken: null, refreshToken: null, user: null, status: 'anon' });
    }
  },
}));
