import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal localStorage polyfill — vitest runs in node env in this project
// and we deliberately don't pull jsdom/happy-dom just for these unit tests.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => { store.delete(k); },
    setItem: (k, v) => { store.set(k, String(v)); },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    configurable: true,
    writable: true,
  });
}
if (typeof globalThis.DOMException === 'undefined') {
  class DOMExceptionShim extends Error {
    constructor(message?: string, name?: string) {
      super(message);
      this.name = name ?? 'Error';
    }
  }
  (globalThis as unknown as { DOMException: typeof DOMException }).DOMException =
    DOMExceptionShim as unknown as typeof DOMException;
}

import { storageKey, readDrawings, writeDrawings, SCHEMA_VERSION } from './useDrawingPersistence';
import { makeDrawing } from '@/types/drawings';

beforeEach(() => {
  localStorage.clear();
});

describe('drawing persistence', () => {
  it('builds a token-scoped storage key', () => {
    expect(storageKey('459277')).toBe('td:drawings:v1:459277');
  });

  it('returns empty list when no key exists', () => {
    expect(readDrawings('NOPE')).toEqual([]);
  });

  it('round-trips drawings', () => {
    const list = [makeDrawing('hline', { price: 100 })];
    writeDrawings('TOK', list);
    expect(readDrawings('TOK')).toEqual(list);
  });

  it('skips writing for empty / 0 tokens', () => {
    writeDrawings('', [makeDrawing('hline', { price: 100 })]);
    writeDrawings('0', [makeDrawing('hline', { price: 100 })]);
    expect(localStorage.length).toBe(0);
  });

  it('returns empty on parse failure (does NOT auto-wipe)', () => {
    localStorage.setItem(storageKey('BAD'), '{not valid json');
    expect(readDrawings('BAD')).toEqual([]);
    expect(localStorage.getItem(storageKey('BAD'))).toBe('{not valid json');
  });

  it('returns empty on schema-version mismatch', () => {
    localStorage.setItem(
      storageKey('OLD'),
      JSON.stringify({ version: 999, drawings: [{ id: 'x' }], updatedAt: 0 }),
    );
    expect(readDrawings('OLD')).toEqual([]);
  });

  it('survives quota-exceeded by surfacing the error', () => {
    const original = localStorage.setItem;
    localStorage.setItem = vi.fn(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => writeDrawings('TOK', [makeDrawing('hline', { price: 100 })])).toThrow();
    localStorage.setItem = original;
  });

  it('writes the current schema version', () => {
    writeDrawings('TOK', [makeDrawing('hline', { price: 100 })]);
    const raw = localStorage.getItem(storageKey('TOK'));
    expect(JSON.parse(raw!).version).toBe(SCHEMA_VERSION);
  });
});
