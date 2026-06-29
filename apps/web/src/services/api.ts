import axios, {
  type AxiosError,
  type InternalAxiosRequestConfig,
} from 'axios';
import toast from 'react-hot-toast';
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  getStoredAccessToken,
  getStoredRefreshToken,
} from './auth-storage';

const api = axios.create({
  baseURL: '/api',
  // 30s: chart historical fetches chunk per trading day and pace 350ms
  // between Angel One calls (3 req/sec hard cap). A 7-day 15m view = 7
  // chunks = ~4-6s typical, but parallel fetches (candles + OI + quote
  // + fundamentals) can serialize behind the global pacer. 15s was too
  // tight — chart would time out and fall back to "demo data" even
  // though the backend was minutes away from a successful response.
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Per-request flag so we only ever attempt a single refresh+retry.
type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

// REQUEST: attach the stored access token. We read localStorage directly
// (rather than importing the auth-store) to avoid an import cycle —
// auth-store imports services, services must not import the store.
api.interceptors.request.use((config) => {
  const token = getStoredAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// A single in-flight refresh shared across concurrent 401s, so a burst of
// failing requests triggers exactly one /auth/refresh round-trip.
let refreshPromise: Promise<string | null> | null = null;

async function performRefresh(): Promise<string | null> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return null;
  try {
    // BARE axios (not `api`) so this call carries no interceptors and can't
    // recurse into another refresh attempt.
    const res = await axios.post<{ accessToken: string; refreshToken: string }>(
      '/auth/refresh',
      { refreshToken },
    );
    const pair = res.data;
    localStorage.setItem(ACCESS_TOKEN_KEY, pair.accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, pair.refreshToken);
    return pair.accessToken;
  } catch {
    return null;
  }
}

function redirectToLogin(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  if (window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ message?: string }>) => {
    const status = error.response?.status;
    const original = error.config as RetriableConfig | undefined;

    const url = original?.url ?? '';
    const isAuthCall = url.includes('/auth/');

    // Attempt one silent refresh on a 401 for a normal (non-auth) request.
    if (status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      if (!refreshPromise) {
        refreshPromise = performRefresh().finally(() => {
          refreshPromise = null;
        });
      }
      const newToken = await refreshPromise;
      if (newToken) {
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original); // retry — refresh succeeded, no toast
      }
      // Refresh failed: clear + bounce to login.
      redirectToLogin();
      toast.error('Session expired. Please sign in again.');
      return Promise.reject(error);
    }

    const message =
      error.response?.data?.message ||
      error.message ||
      'An unexpected error occurred';

    if (status === 401 && !isAuthCall) {
      // Already-retried 401 (refresh unavailable/failed earlier in chain).
      redirectToLogin();
      toast.error('Session expired. Please sign in again.');
    } else if (status === 429) {
      toast.error('Rate limit exceeded. Please wait.');
    } else if (status && status >= 500) {
      toast.error(`Server error: ${message}`);
    }

    return Promise.reject(error);
  },
);

export default api;
