import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import type { FeedState } from '../../market-data/services/user-feed.types';
import type { HubBroker } from '../hub-broker';
import { refKey, type InstrumentRef } from '../hub.types';

/** In-memory broker for hub tests: records calls, emits ticks/states on demand. */
export class FakeBroker implements HubBroker {
  readonly subscribed = new Set<string>();
  readonly quoteCalls: InstrumentRef[][] = [];
  connected = false;
  quoteImpl: (refs: InstrumentRef[]) => Promise<Map<string, TickData>> = async (refs) =>
    new Map(refs.map((r) => [r.token, FakeBroker.tick(r.token, 100)]));
  private tickFns: Array<(t: TickData) => void> = [];
  private stateFns: Array<(s: FeedState) => void> = [];

  static tick(token: string, ltp: number, exchange?: string): TickData {
    return { token, symbol: token, ltp, open: 0, high: 0, low: 0, close: 0, volume: 0, timestamp: new Date(), exchange };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async subscribe(refs: InstrumentRef[]): Promise<void> {
    for (const r of refs) this.subscribed.add(refKey(r));
  }
  async unsubscribe(refs: InstrumentRef[]): Promise<void> {
    for (const r of refs) this.subscribed.delete(refKey(r));
  }
  quotes(refs: InstrumentRef[]): Promise<Map<string, TickData>> {
    this.quoteCalls.push(refs);
    return this.quoteImpl(refs);
  }
  onTick(fn: (t: TickData) => void): void {
    this.tickFns.push(fn);
  }
  onState(fn: (s: FeedState) => void): void {
    this.stateFns.push(fn);
  }
  emitTick(t: TickData): void {
    for (const fn of this.tickFns) fn(t);
  }
  emitState(s: FeedState): void {
    for (const fn of this.stateFns) fn(s);
  }
}
