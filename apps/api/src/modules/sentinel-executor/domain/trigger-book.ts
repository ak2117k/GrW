// apps/api/src/modules/sentinel-executor/domain/trigger-book.ts
import { EMPTY_CONFIRM, stepConfirm, type ConfirmState } from './confirmation';
import { TRIGGER_TIMING, type TriggerInstrument, type TriggerOp } from './trigger.types';

export interface ArmedTrigger {
  id: string;
  userId: string;
  trackerId: string;
  symbol: string;
  verdictId: string;
  instrument: TriggerInstrument;
  op: TriggerOp;
  price: number;
  watch: { key: string; exchange: string; token: string; symbol: string };
  /** The POSITION's exchange — what expiry at close is judged on. */
  trackerExchange: string;
  armedAt: number;
  confirm: ConfirmState;
}

export interface BookTick {
  key: string;
  exchange: string;
  ltp: number;
  /** Receipt time (hub Price.at), ms epoch. */
  at: number;
  source: string;
}

export interface Fire {
  trigger: ArmedTrigger;
  tick: { price: number; at: number; count: number; heldMs: number };
}

const NONE: Fire[] = [];

/**
 * The ARMED triggers, in memory, keyed by EXCHANGE:token. `onTick` is THE tick
 * path: synchronous, no I/O, O(triggers on this key) — 0 for almost every tick,
 * 1 in practice otherwise. A firing trigger is removed before `onTick` returns
 * (ruling R7 layer 1), so no later tick in this process can fire it again.
 */
export class TriggerBook {
  private readonly byKey = new Map<string, Map<string, ArmedTrigger>>();
  private readonly byId = new Map<string, ArmedTrigger>();
  private readonly trackerToId = new Map<string, string>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly cfg: { ticks: number; ms: number },
    private readonly isOpen: (exchange: string, at: Date) => boolean,
  ) {}

  /** Arm `t` (fresh confirmation). Returns the trigger it replaced on the same tracker, if any. */
  add(t: ArmedTrigger): ArmedTrigger | null {
    const prev = this.byTracker(t.trackerId);
    if (prev) this.remove(prev.id);
    const armed = { ...t, confirm: EMPTY_CONFIRM };
    this.byId.set(armed.id, armed);
    this.trackerToId.set(armed.trackerId, armed.id);
    let bucket = this.byKey.get(armed.watch.key);
    if (!bucket) {
      bucket = new Map();
      this.byKey.set(armed.watch.key, bucket);
    }
    bucket.set(armed.id, armed);
    return prev ?? null;
  }

  remove(id: string): ArmedTrigger | null {
    const t = this.byId.get(id);
    if (!t) return null;
    this.byId.delete(id);
    if (this.trackerToId.get(t.trackerId) === id) this.trackerToId.delete(t.trackerId);
    const bucket = this.byKey.get(t.watch.key);
    bucket?.delete(id);
    if (bucket && bucket.size === 0) {
      this.byKey.delete(t.watch.key);
      this.seen.delete(t.watch.key);
    }
    return t;
  }

  get(id: string): ArmedTrigger | undefined {
    return this.byId.get(id);
  }

  byTracker(trackerId: string): ArmedTrigger | undefined {
    const id = this.trackerToId.get(trackerId);
    return id === undefined ? undefined : this.byId.get(id);
  }

  all(): ArmedTrigger[] {
    return [...this.byId.values()];
  }

  hasKey(key: string): boolean {
    return this.byKey.has(key);
  }

  lastSeen(key: string): number | undefined {
    return this.seen.get(key);
  }

  size(): number {
    return this.byId.size;
  }

  onTick(t: BookTick, now: number): Fire[] {
    const bucket = this.byKey.get(t.key);
    if (bucket === undefined) return NONE;
    if (t.source === 'db' || !Number.isFinite(t.ltp) || t.ltp <= 0) return NONE;
    if (Math.abs(now - t.at) > TRIGGER_TIMING.tickMaxAgeMs) return NONE;
    if (!this.isOpen(t.exchange, new Date(t.at))) return NONE;
    this.seen.set(t.key, t.at);
    let fires: Fire[] | null = null;
    for (const trig of bucket.values()) {
      const r = stepConfirm(trig.confirm, { price: t.ltp, at: t.at }, trig, {
        ticks: this.cfg.ticks, ms: this.cfg.ms, gapResetMs: TRIGGER_TIMING.tickGapResetMs,
      });
      trig.confirm = r.state;
      if (r.fire) {
        (fires ??= []).push({
          trigger: trig,
          tick: { price: t.ltp, at: t.at, count: r.state.count, heldMs: t.at - (r.state.firstAt ?? t.at) },
        });
      }
    }
    if (fires === null) return NONE;
    for (const f of fires) this.remove(f.trigger.id);
    return fires;
  }
}
