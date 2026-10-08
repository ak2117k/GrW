import type { CandleRepo } from '../candles/candle-repository';
import { bucketOrigin } from '../candles/candle-repository';
import type { CandleTable, HubCandle } from '../candles/candle.types';
import { istDay } from '../candles/trading-calendar';
import { refKey, type HubExchange, type InstrumentRef } from '../hub.types';

type Row = HubCandle & { source?: 'tick' | 'broker' };

/** In-memory CandleRepo with the same semantics as PrismaCandleRepo (see its integration test). */
export class MemoryCandleRepo implements CandleRepo {
  readonly rows: Record<CandleTable, Map<string, Map<number, Row>>> = { '1m': new Map(), '1h': new Map(), '1d': new Map() };
  readonly coverage = new Set<string>();
  failWrites = false;

  async read(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<HubCandle[]> {
    return this.range(table, ref, from, to);
  }

  async readBucketed(ref: InstrumentRef, stepMin: number, originMinIst: number, from: number, to: number): Promise<HubCandle[]> {
    const origin = Date.parse(bucketOrigin(originMinIst));
    const step = stepMin * 60_000;
    const buckets = new Map<number, HubCandle>();
    for (const r of this.range('1m', ref, from, to)) {
      const b = origin + Math.floor((r.ts - origin) / step) * step;
      const c = buckets.get(b);
      if (!c) {
        buckets.set(b, { ...r, ts: b });
      } else {
        c.high = Math.max(c.high, r.high);
        c.low = Math.min(c.low, r.low);
        c.close = r.close;
        c.volume += r.volume;
        if (r.oi !== undefined) c.oi = r.oi;
      }
    }
    return [...buckets.values()].sort((a, b) => a.ts - b.ts);
  }

  async dayCounts(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const r of this.range(table, ref, from, to)) out.set(istDay(r.ts), (out.get(istDay(r.ts)) ?? 0) + 1);
    return out;
  }

  async upsert(table: CandleTable, ref: InstrumentRef, candles: readonly HubCandle[], source: 'tick' | 'broker'): Promise<void> {
    if (this.failWrites) throw new Error('db down');
    const s = this.series(table, ref);
    for (const c of candles) {
      const existing = s.get(c.ts);
      if (table === '1m' && existing?.source === 'broker' && source === 'tick') continue;
      s.set(c.ts, table === '1m' ? { ...c, source } : { ...c });
    }
  }

  async coveredDays(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<Set<string>> {
    return new Set(days.filter((d) => this.coverage.has(`${table}:${refKey(ref)}:${d}`)));
  }

  async markCovered(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<void> {
    for (const d of days) this.coverage.add(`${table}:${refKey(ref)}:${d}`);
  }

  async tickInstruments(sinceMs: number): Promise<Array<Pick<InstrumentRef, 'exchange' | 'token'>>> {
    const out: Array<Pick<InstrumentRef, 'exchange' | 'token'>> = [];
    for (const [key, s] of this.rows['1m']) {
      if ([...s.values()].some((r) => r.source === 'tick' && r.ts >= sinceMs)) {
        const [exchange, token] = key.split(':');
        out.push({ exchange: exchange as HubExchange, token });
      }
    }
    return out;
  }

  private series(table: CandleTable, ref: InstrumentRef): Map<number, Row> {
    const key = refKey(ref);
    let s = this.rows[table].get(key);
    if (!s) {
      s = new Map();
      this.rows[table].set(key, s);
    }
    return s;
  }

  private range(table: CandleTable, ref: InstrumentRef, from: number, to: number): HubCandle[] {
    return [...this.series(table, ref).values()]
      .filter((r) => r.ts >= from && r.ts < to)
      .sort((a, b) => a.ts - b.ts)
      .map(({ source: _source, ...c }) => c);
  }
}
