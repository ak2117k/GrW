// apps/api/src/modules/mbm/services/mbm-chain-reader.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { istYmd, type ChainSnapshotRow } from '../domain/chain-snapshot';
import { normaliseUnderlying } from '../domain/stock-chain';
import { MbmChainRepository } from '../repositories/mbm-chain.repository';
import { MBM_NOW } from './mbm-bar-refresher.service';

/** Calendar days scanned per session asked for (weekends + holidays), plus slack. */
const DAYS_PER_SESSION = 2;
const SLACK_DAYS = 7;
/** Capture keys read per session asked for: NIFTY writes ~76 captures × 2 expiries a session. */
const KEYS_PER_SESSION = 200;

export interface CaptureKey {
  capturedAt: Date;
  expiry: string;
}

/**
 * Pure: from keys ordered newest capture first (expiry ascending within a capture), the LAST capture of
 * each IST session, newest session first, at its nearest expiry. At most `sessions` keys.
 */
export function lastPerSession<K extends CaptureKey>(keys: readonly K[], sessions: number): K[] {
  const out: K[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    const day = istYmd(k.capturedAt);
    if (seen.has(day)) {
      const prev = out[out.length - 1];
      if (prev && prev.capturedAt.getTime() === k.capturedAt.getTime() && k.expiry < prev.expiry) out[out.length - 1] = k;
      continue;
    }
    if (out.length >= sessions) break;
    seen.add(day);
    out.push(k);
  }
  return out;
}

/**
 * Read helpers over mbm_chain_snapshots for the overnight scorecard (stream B): the newest chain of an
 * underlying, and its per-session history (for "PCR vs its own 5-session median"). DB only; reads the
 * light (capturedAt, expiry) keys first and only then the picked rows' strikes.
 */
@Injectable()
export class MbmChainReader {
  constructor(
    private readonly repo: MbmChainRepository,
    @Inject(MBM_NOW) private readonly now: () => Date,
  ) {}

  /** Newest snapshot (nearest expiry of the newest capture) of `symbol` within the last 10 days; null when none. */
  async latestChain(symbol: string): Promise<ChainSnapshotRow | null> {
    return (await this.read(symbol, 1, 10, 4))[0] ?? null;
  }

  /** The last snapshot of each of `symbol`'s most recent `sessions` captured sessions, newest first. */
  async chainHistory(symbol: string, sessions: number): Promise<ChainSnapshotRow[]> {
    const n = Math.max(0, Math.floor(sessions));
    return this.read(symbol, n, n * DAYS_PER_SESSION + SLACK_DAYS, n * KEYS_PER_SESSION);
  }

  private async read(symbol: string, sessions: number, days: number, take: number): Promise<ChainSnapshotRow[]> {
    const name = normaliseUnderlying(symbol);
    if (!name || sessions <= 0) return [];
    const since = new Date(this.now().getTime() - days * 86_400_000);
    const picks = lastPerSession(await this.repo.captureKeys(name, since, take), sessions);
    return this.repo.snapshotsAt(name, picks);
  }
}
