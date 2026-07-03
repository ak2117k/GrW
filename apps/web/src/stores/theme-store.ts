import { create } from 'zustand';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'grw-theme';

/** Dark is the default (matches the @theme :root tokens); light is opt-in. */
function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'dark';
}

/** Flip the single attribute the whole token system keys off of. */
function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme'); // dark = default token set
}

/**
 * Apply the persisted theme to <html> before React paints, so the app never
 * flashes the wrong theme on load. Call once from main.tsx.
 */
export function initTheme(): void {
  applyTheme(readStoredTheme());
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage unavailable (private mode) — theme still applies for the session */
    }
    set({ theme });
  },
  toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));
