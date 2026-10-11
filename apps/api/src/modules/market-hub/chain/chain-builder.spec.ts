import { GreeksCalculatorService } from '../../options-chain/services/greeks-calculator.service';
import type { QuoteOutcome } from '../quote-batcher';
import { refKey, type InstrumentRef } from '../hub.types';
import { MemoryChainRepo } from '../testing/memory-chain-repo';
import type { ChainContract } from './chain.types';
import { ChainBuilder, type ChainBuilderDeps } from './chain-builder';

const NIFTY: InstrumentRef = { exchange: 'NSE', token: '99926000', symbol: 'Nifty 50' };
const E = '2026-10-13';
const contract = (strike: number, side: 'CE' | 'PE'): ChainContract => ({
  instrumentId: `id-${side}${strike}`,
  ref: { exchange: 'NFO', token: `${side}${strike}`, symbol: `NIFTY${strike}${side}` },
  strike,
  optionType: side,
  lotSize: 75,
});
function repoWithNifty() {
  const repo = new MemoryChainRepo();
  const rows: ChainContract[] = [];
  for (let s = 24000; s <= 26000; s += 50) rows.push(contract(s, 'CE'), contract(s, 'PE'));
  repo.addContracts('NIFTY', E, rows);
  repo.addContracts('NIFTY', '2026-10-20', rows.map((c) => ({ ...c, instrumentId: `w2-${c.instrumentId}` })));
  repo.underlyings.set('NIFTY', NIFTY);
  return repo;
}
const tick = (ltp: number, oi = 1000): QuoteOutcome => ({
  kind: 'ok',
  tick: { token: 't', symbol: 't', ltp, open: 0, high: 0, low: 0, close: 0, volume: 1, oi, timestamp: new Date() },
});

function builder(over: Partial<ChainBuilderDeps> = {}) {
  let now = Date.parse('2026-10-12T05:00:00Z');
  const quoteCalls: InstrumentRef[][] = [];
  const greekCalls: string[] = [];
  const deps: ChainBuilderDeps = {
    repo: repoWithNifty(),
    quoteNow: async (refs) => {
      quoteCalls.push([...refs]);
      return new Map(refs.map((r) => [refKey(r), r.exchange === 'NSE' ? tick(25010) : tick(100)] as const));
    },
    greeks: async (name, expiry) => {
      greekCalls.push(`${name}:${expiry}`);
      return { kind: 'ok', value: [] };
    },
    bookSpot: () => 25010,
    math: new GreeksCalculatorService(),
    now: () => now,
    ...over,
  };
  return { b: new ChainBuilder(deps), deps, quoteCalls, greekCalls, advance: (ms: number) => (now += ms) };
}

describe('ChainBuilder', () => {
  it('builds ±N strikes around the book spot with one quote call for every leg and no spot ref', async () => {
    const { b, quoteCalls } = builder();
    const out = await b.build('nifty', E, { lane: 1, strikesAround: 2 });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.chain).toEqual(expect.objectContaining({ underlying: 'NIFTY', expiry: E, exchange: 'NFO', spot: 25010 }));
    expect(out.chain.entries.map((e) => e.strikePrice)).toEqual([24900, 24950, 25000, 25050, 25100]);
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0]).toHaveLength(10);
    expect(quoteCalls[0].some((r) => r.exchange === 'NSE')).toBe(false);
  });

  it('quotes the underlying with the legs when the book has no fresh spot, and takes spot from it', async () => {
    const { b, quoteCalls } = builder({ bookSpot: () => null });
    const out = await b.build('NIFTY', E, { lane: 1, strikesAround: 1, hintSpot: 25000 });
    expect(quoteCalls[0].filter((r) => r.exchange === 'NSE')).toEqual([NIFTY]);
    expect(out.kind === 'ok' && out.chain.spot).toBe(25010);
  });

  it('no contracts is unavailable without any broker call', async () => {
    const { b, quoteCalls, greekCalls } = builder();
    await expect(b.build('NOSUCH', E, { lane: 1, strikesAround: 2 })).resolves.toEqual({ kind: 'unavailable', reason: 'no-contracts' });
    expect(quoteCalls).toHaveLength(0);
    expect(greekCalls).toHaveLength(0);
  });

  it('every leg throttled is unavailable: throttled; every leg busy is busy', async () => {
    const throttled = builder({ quoteNow: async (refs) => new Map(refs.map((r) => [refKey(r), { kind: 'throttled', retryAfterMs: 1000 }] as const)) });
    await expect(throttled.b.build('NIFTY', E, { lane: 1, strikesAround: 1 })).resolves.toEqual({ kind: 'unavailable', reason: 'throttled' });
    const busy = builder({ quoteNow: async (refs) => new Map(refs.map((r) => [refKey(r), { kind: 'busy' }] as const)) });
    await expect(busy.b.build('NIFTY', E, { lane: 1, strikesAround: 1 })).resolves.toEqual({ kind: 'unavailable', reason: 'busy' });
  });

  it('a throttled optionGreek still builds the chain, with Greeks computed locally', async () => {
    const { b } = builder({ greeks: async () => ({ kind: 'throttled', retryAfterMs: 1000 }) });
    const out = await b.build('NIFTY', E, { lane: 1, strikesAround: 1 });
    expect(out.kind === 'ok' && out.chain.greeks).toBe('local');
  });

  it('caches Greeks for 60 s per underlying+expiry, and contracts per IST day', async () => {
    const { b, deps, greekCalls, advance } = builder();
    await b.build('NIFTY', E, { lane: 1, strikesAround: 1 });
    advance(30_000);
    await b.build('NIFTY', E, { lane: 1, strikesAround: 1 });
    expect(greekCalls).toHaveLength(1);
    advance(31_000);
    await b.build('NIFTY', E, { lane: 1, strikesAround: 1 });
    expect(greekCalls).toHaveLength(2);
    expect((deps.repo as MemoryChainRepo).contractCalls).toBe(1);
  });

  it('a failed baseline read still builds, with oiChange null, and is counted', async () => {
    const repo = repoWithNifty();
    repo.failBaseline = true;
    const { b } = builder({ repo });
    const out = await b.build('NIFTY', E, { lane: 1, strikesAround: 0 });
    expect(out.kind === 'ok' && out.chain.entries[0].ceData?.oiChange).toBeNull();
    expect(b.baselineFailures).toBe(1);
  });

  it('expiries come from the repo from today (IST), and contractFor matches strike and side exactly', async () => {
    const { b } = builder();
    await expect(b.expiries('NIFTY')).resolves.toEqual([E, '2026-10-20']);
    await expect(b.contractFor('NIFTY', E, 25000, 'PE')).resolves.toEqual(expect.objectContaining({ strike: 25000, optionType: 'PE' }));
    await expect(b.contractFor('NIFTY', E, 25025, 'PE')).resolves.toBeNull();
  });
});
