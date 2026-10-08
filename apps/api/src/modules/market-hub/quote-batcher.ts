import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import type { Governor } from './governor';
import { refKey, type InstrumentRef, type Lane } from './hub.types';

export type QuoteOutcome =
  | { kind: 'ok'; tick: TickData }
  | { kind: 'missing' }
  | { kind: 'throttled'; retryAfterMs: number }
  | { kind: 'busy' }
  | { kind: 'error'; error: unknown };

/** One broker call for these refs; result keyed by token (Angel's shape). */
export type FetchQuotes = (refs: InstrumentRef[]) => Promise<Map<string, TickData>>;

interface Waiting {
  ref: InstrumentRef;
  lane: Lane;
  resolvers: Array<(o: QuoteOutcome) => void>;
}

export interface QuoteBatcherOptions {
  windowMs: number;
  maxPerCall: number;
}

/**
 * Chunks of at most `max`, and never the same token twice in one chunk:
 * the broker answers keyed by token alone, so two exchanges' identical tokens
 * in one call could not be told apart.
 */
export function chunkRefs<T extends { ref: InstrumentRef }>(items: readonly T[], max: number): T[][] {
  const chunks: { items: T[]; tokens: Set<string> }[] = [];
  for (const item of items) {
    let chunk = chunks.find((c) => c.items.length < max && !c.tokens.has(item.ref.token));
    if (!chunk) {
      chunk = { items: [], tokens: new Set() };
      chunks.push(chunk);
    }
    chunk.items.push(item);
    chunk.tokens.add(item.ref.token);
  }
  return chunks.map((c) => c.items);
}

/** Collects single-quote requests for a short window and sends them as ≤ 50-symbol calls. */
export class QuoteBatcher {
  private readonly pending = new Map<string, Waiting>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly gov: Governor,
    private readonly fetchQuotes: FetchQuotes,
    private readonly opts: QuoteBatcherOptions = { windowMs: 150, maxPerCall: 50 },
  ) {}

  quote(ref: InstrumentRef, lane: Lane): Promise<QuoteOutcome> {
    const key = refKey(ref);
    return new Promise<QuoteOutcome>((resolve) => {
      const existing = this.pending.get(key);
      if (existing) {
        existing.resolvers.push(resolve);
        if (lane < existing.lane) existing.lane = lane;
      } else {
        this.pending.set(key, { ref, lane, resolvers: [resolve] });
      }
      if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.windowMs);
    });
  }

  private flush(): void {
    this.timer = null;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const chunk of chunkRefs(batch, this.opts.maxPerCall)) void this.send(chunk);
  }

  private async send(chunk: Waiting[]): Promise<void> {
    const lane = Math.min(...chunk.map((w) => w.lane)) as Lane;
    const res = await this.gov.submit({
      endpoint: 'quote',
      lane,
      run: () => this.fetchQuotes(chunk.map((w) => w.ref)),
    });
    for (const w of chunk) {
      let out: QuoteOutcome;
      if (res.kind === 'ok') {
        const tick = res.value.get(w.ref.token);
        out = tick ? { kind: 'ok', tick } : { kind: 'missing' };
      } else {
        out = res;
      }
      for (const resolve of w.resolvers) resolve(out);
    }
  }
}
