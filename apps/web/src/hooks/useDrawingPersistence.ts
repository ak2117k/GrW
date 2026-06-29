import { useEffect, useRef } from 'react';
import { useDrawingStore, selectDrawingsForToken } from '@/stores/drawing-store';
import type { Drawing } from '@/types/drawings';

export const SCHEMA_VERSION = 1;
const DEBOUNCE_MS = 500;

export function storageKey(token: string): string {
  return `td:drawings:v${SCHEMA_VERSION}:${token}`;
}

interface StoredShape {
  version: number;
  drawings: Drawing[];
  updatedAt: number;
}

export function readDrawings(token: string): Drawing[] {
  if (!token || token === '0') return [];
  try {
    const raw = localStorage.getItem(storageKey(token));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredShape;
    if (parsed.version !== SCHEMA_VERSION) {
      // eslint-disable-next-line no-console
      console.warn(`[drawings] schema mismatch v${parsed.version} for ${token}; ignoring`);
      return [];
    }
    return Array.isArray(parsed.drawings) ? parsed.drawings : [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[drawings] parse failed for ${token}; ignoring (kept in storage):`, err);
    return [];
  }
}

export function writeDrawings(token: string, drawings: Drawing[]): void {
  if (!token || token === '0') return;
  const payload: StoredShape = {
    version: SCHEMA_VERSION,
    drawings,
    updatedAt: Date.now(),
  };
  localStorage.setItem(storageKey(token), JSON.stringify(payload));
}

export function useDrawingPersistence(token: string): void {
  const setDrawingsForToken = useDrawingStore((s) => s.setDrawingsForToken);
  const drawings = useDrawingStore(selectDrawingsForToken(token));
  const timeoutRef = useRef<number | null>(null);
  const lastHydratedToken = useRef<string | null>(null);

  useEffect(() => {
    if (token === lastHydratedToken.current) return;
    lastHydratedToken.current = token;
    setDrawingsForToken(token, readDrawings(token));
  }, [token, setDrawingsForToken]);

  useEffect(() => {
    if (!token || token === '0') return;
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      try {
        writeDrawings(token, drawings);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[drawings] write failed:', err);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, [drawings, token]);

  useEffect(() => {
    if (!token || token === '0') return;
    const onUnload = () => {
      try {
        writeDrawings(token, drawings);
      } catch {
        // best-effort on unload
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [drawings, token]);

  useEffect(() => {
    if (!token || token === '0') return;
    const key = storageKey(token);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      setDrawingsForToken(token, readDrawings(token));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [token, setDrawingsForToken]);
}
