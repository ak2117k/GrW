import { refKey, type InstrumentRef, type Priority } from './hub.types';

export interface WatchEntry {
  ref: InstrumentRef;
  priority: Priority;
  firstAt: number;
}

interface Holder {
  priority: Priority;
  expiresAt: number | null;
}

interface Slot {
  ref: InstrumentRef;
  firstAt: number;
  holders: Map<string, Holder>;
}

/**
 * Who is interested in which instrument, and how urgently. A watch is a
 * declaration of interest; the hub decides how to serve it. Screen watches
 * carry a TTL so forgotten symbols stop costing broker calls.
 */
export class WatchRegistry {
  private readonly slots = new Map<string, Slot>();

  watch(ref: InstrumentRef, priority: Priority, owner: string, now: number, ttlMs?: number): void {
    const key = refKey(ref);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { ref, firstAt: now, holders: new Map() };
      this.slots.set(key, slot);
    }
    slot.holders.set(owner, { priority, expiresAt: ttlMs === undefined ? null : now + ttlMs });
  }

  unwatch(ref: InstrumentRef, owner: string): void {
    const key = refKey(ref);
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.holders.delete(owner);
    if (slot.holders.size === 0) this.slots.delete(key);
  }

  /** Drop expired holders; true when anything changed. */
  expire(now: number): boolean {
    let changed = false;
    for (const [key, slot] of this.slots) {
      for (const [owner, h] of slot.holders) {
        if (h.expiresAt !== null && now > h.expiresAt) {
          slot.holders.delete(owner);
          changed = true;
        }
      }
      if (slot.holders.size === 0) this.slots.delete(key);
    }
    return changed;
  }

  has(key: string): boolean {
    return this.slots.has(key);
  }

  size(): number {
    return this.slots.size;
  }

  entries(): WatchEntry[] {
    return [...this.slots.values()].map((s) => ({
      ref: s.ref,
      firstAt: s.firstAt,
      priority: Math.min(...[...s.holders.values()].map((h) => h.priority)) as Priority,
    }));
  }
}
