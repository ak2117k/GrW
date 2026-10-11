import type { OptionsChainEntry } from '@td/shared/types';
import type { HubExchange, InstrumentRef } from '../hub.types';
import { refKey } from '../hub.types';
import type { ChainRepo } from '../chain/chain-repository';
import type { ChainContract, HubChain, OiRow } from '../chain/chain.types';

/** In-memory ChainRepo for tests; same semantics as PrismaChainRepo (exact names, expiry days). */
export class MemoryChainRepo implements ChainRepo {
  /** name → expiry → contracts */
  readonly contractsRows = new Map<string, Map<string, ChainContract[]>>();
  readonly underlyings = new Map<string, InstrumentRef>();
  /** refKey → { name, expiry } */
  readonly heldInfo = new Map<string, { name: string; expiry: string }>();
  readonly oiRows: OiRow[] = [];
  readonly chainSnapshots: HubChain[] = [];
  failBaseline = false;
  contractCalls = 0;

  addContracts(name: string, expiry: string, contracts: ChainContract[]): void {
    const byExpiry = this.contractsRows.get(name) ?? new Map<string, ChainContract[]>();
    byExpiry.set(expiry, contracts);
    this.contractsRows.set(name, byExpiry);
  }

  async contracts(name: string, expiry: string): Promise<ChainContract[]> {
    this.contractCalls++;
    return this.contractsRows.get(name.toUpperCase())?.get(expiry) ?? [];
  }

  async expiries(name: string, today: string): Promise<string[]> {
    return [...(this.contractsRows.get(name.toUpperCase())?.keys() ?? [])].filter((e) => e >= today).sort();
  }

  async underlyingRef(name: string, _exchange: HubExchange, _expiry: string): Promise<InstrumentRef | null> {
    return this.underlyings.get(name.toUpperCase()) ?? null;
  }

  async describe(refs: readonly InstrumentRef[]): Promise<Array<{ name: string; expiry: string }>> {
    return refs.map((r) => this.heldInfo.get(refKey(r))).filter((x): x is { name: string; expiry: string } => !!x);
  }

  async baseline(instrumentIds: readonly string[], before: Date): Promise<Map<string, number>> {
    if (this.failBaseline) throw new Error('baseline down');
    const out = new Map<string, { at: number; oi: number }>();
    for (const r of this.oiRows) {
      if (!instrumentIds.includes(r.instrumentId) || r.at.getTime() >= before.getTime()) continue;
      const prev = out.get(r.instrumentId);
      if (!prev || r.at.getTime() > prev.at) out.set(r.instrumentId, { at: r.at.getTime(), oi: r.oi });
    }
    return new Map([...out].map(([k, v]) => [k, v.oi]));
  }

  async writeOi(rows: readonly OiRow[]): Promise<number> {
    this.oiRows.push(...rows);
    return rows.length;
  }

  async writeChainSnapshot(chain: HubChain): Promise<void> {
    this.chainSnapshots.push({ ...chain, entries: JSON.parse(JSON.stringify(chain.entries)) as OptionsChainEntry[] });
  }

  async latestChainSnapshot(underlying: string, expiry: string, exchange: HubExchange): Promise<HubChain | null> {
    const rows = this.chainSnapshots.filter((s) => s.underlying === underlying.toUpperCase() && s.expiry === expiry);
    const last = rows.sort((a, b) => b.at - a.at)[0];
    return last ? { ...last, exchange } : null;
  }

  async pruneOi(before: Date): Promise<number> {
    const keep = this.oiRows.filter((r) => r.at.getTime() >= before.getTime());
    const removed = this.oiRows.length - keep.length;
    this.oiRows.splice(0, this.oiRows.length, ...keep);
    return removed;
  }
}
