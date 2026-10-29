import { istDay } from '../candles/trading-calendar';
import type { SessionClock } from '../session-clock';
import type { ChainRepo } from './chain-repository';
import type { ChainContract, HubChain, OiRow } from './chain.types';

export const OI_SNAPSHOT_EVERY_MS = 180_000;
export const CHAIN_JSON_EVERY_RUNS = 5;
/** Ticks run every 30 s; allow a run a little early so a 3-minute cadence does not drift to 3.5. */
const EARLY_MS = 15_000;

export interface SnapshotTarget {
  underlying: string;
  expiry: string;
  /** Strikes each side of ATM for this target's build; absent = the hub's HUB_CHAIN_STRIKES_AROUND. */
  strikesAround?: number;
}

export interface OiSnapshotJobDeps {
  targets(now: number): Promise<SnapshotTarget[]>;
  contracts(underlying: string, expiry: string): Promise<ChainContract[]>;
  freshChain(underlying: string, expiry: string, strikesAround?: number): Promise<HubChain | null>;
  repo: Pick<ChainRepo, 'writeOi' | 'writeChainSnapshot'>;
  clock: Pick<SessionClock, 'isOpen'>;
  /**
   * Whether chain JSON (`OptionChainSnapshot`) may be written; OI rows are written regardless.
   * Off while HUB_SERVES_CHAIN is off: legacy readers would otherwise read the hub's ±N-strike chain.
   * Default true.
   */
  writeChainJson?: () => boolean;
  log?: (m: string) => void;
}

interface TargetState {
  lastAt: number;
  runs: number;
  wasOpen: boolean;
}

/**
 * Spec §3 OiSnapshotJob: every 3 minutes while a target's venue is open, one oi_snapshots row per
 * quoted contract; the full chain JSON on the first run, every 5th run, and once at the venue's close
 * (what the closed-market view and the overnight review read), while writeChainJson() allows it.
 * Never throws.
 */
export class OiSnapshotJob {
  private readonly state = new Map<string, TargetState>();
  private counts = { day: '', rows: 0, failures: 0 };
  private readonly lastAt: Record<string, number> = {};

  constructor(private readonly d: OiSnapshotJobDeps) {}

  async tick(now: number): Promise<void> {
    this.rollDay(now);
    let targets: SnapshotTarget[];
    try {
      targets = await this.d.targets(now);
    } catch (err) {
      this.counts.failures++;
      this.d.log?.(`OI snapshot targets failed: ${(err as Error)?.message ?? err}`);
      return;
    }
    for (const t of targets) await this.one(t, now);
  }

  status(now: number): { rowsToday: number; failures: number; lastAt: Record<string, number> } {
    this.rollDay(now);
    return { rowsToday: this.counts.rows, failures: this.counts.failures, lastAt: { ...this.lastAt } };
  }

  private async one(t: SnapshotTarget, now: number): Promise<void> {
    const key = `${t.underlying.toUpperCase()}:${t.expiry}`;
    try {
      const contracts = await this.d.contracts(t.underlying, t.expiry);
      if (contracts.length === 0) return;
      const open = this.d.clock.isOpen(contracts[0].ref.exchange, new Date(now));
      const st = this.state.get(key) ?? { lastAt: Number.NEGATIVE_INFINITY, runs: 0, wasOpen: false };
      this.state.set(key, st);
      const due = open && now - st.lastAt >= OI_SNAPSHOT_EVERY_MS - EARLY_MS;
      const closing = !open && st.wasOpen;
      st.wasOpen = open;
      if (!due && !closing) return;
      st.lastAt = now;

      const chain = await this.d.freshChain(t.underlying, t.expiry, t.strikesAround);
      if (!chain) {
        this.counts.failures++;
        return;
      }
      const idByToken = new Map(contracts.map((c) => [c.ref.token, c.instrumentId]));
      const at = new Date(chain.at);
      const rows: OiRow[] = [];
      for (const e of chain.entries) {
        for (const leg of [e.ceData, e.peData]) {
          const id = leg?.token ? idByToken.get(leg.token) : undefined;
          if (!leg || !id) continue;
          rows.push({ instrumentId: id, oi: leg.oi, oiChange: leg.oiChange, volume: leg.volume, ltp: leg.ltp, at });
        }
      }
      this.counts.rows += await this.d.repo.writeOi(rows);
      st.runs++;
      const jsonDue = closing || st.runs % CHAIN_JSON_EVERY_RUNS === 1;
      if (jsonDue && (this.d.writeChainJson?.() ?? true)) await this.d.repo.writeChainSnapshot(chain);
      this.lastAt[key] = chain.at;
    } catch (err) {
      this.counts.failures++;
      this.d.log?.(`OI snapshot ${key} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private rollDay(now: number): void {
    const day = istDay(now);
    if (this.counts.day !== day) this.counts = { day, rows: 0, failures: 0 };
  }
}
