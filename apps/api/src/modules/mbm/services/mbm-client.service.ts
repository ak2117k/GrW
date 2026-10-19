// apps/api/src/modules/mbm/services/mbm-client.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MBM_CONFIG, type MbmConfig } from '../mbm.config';

/** One horizon of `GET /behaviour/{instrument}` (plan §3). */
export interface MbmHorizon {
  p: number;
  regime: 'QUIET' | 'NORMAL' | 'ACTIVE' | string;
  q25Bp: number | null;
  q50Bp: number | null;
  q75Bp: number | null;
}

/** The MBM service's behaviour response; `absent` is also what every failure becomes here. */
export interface MbmBehaviour {
  instrument?: string;
  status: 'ok' | 'stale' | 'absent';
  asOf?: string | null;
  horizons?: Record<string, MbmHorizon>;
  modelIds?: Record<string, string>;
  featureSet?: string;
  dataQuality?: string;
}

export const MBM_FETCH = Symbol('MBM_FETCH');
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const MBM_TIMEOUT_MS = 800;
export const MBM_CACHE_MS = 60_000;
const INSTRUMENT_RE = /^[A-Z0-9_]{1,32}$/;
const STATUSES = new Set(['ok', 'stale', 'absent']);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Read-only proxy to the MBM service (plan §4). FAIL-OPEN: any error, timeout, non-2xx or malformed
 * body ⇒ `{status:'absent'}`; never throws. Successful answers are cached in memory for 60 s.
 */
@Injectable()
export class MbmClient {
  private readonly logger = new Logger(MbmClient.name);
  private readonly cache = new Map<string, { at: number; value: MbmBehaviour }>();

  constructor(
    @Inject(MBM_CONFIG) private readonly config: MbmConfig,
    @Inject(MBM_FETCH) private readonly fetchFn: FetchLike,
  ) {}

  async behaviour(instrument: string, nowMs: number = Date.now()): Promise<MbmBehaviour> {
    const inst = String(instrument ?? '').trim().toUpperCase();
    if (this.config.mode === 'off' || !INSTRUMENT_RE.test(inst)) return { instrument: inst, status: 'absent' };

    const hit = this.cache.get(inst);
    if (hit && nowMs - hit.at < MBM_CACHE_MS) return hit.value;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), MBM_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`${this.config.url}/behaviour/${inst}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as MbmBehaviour | null;
      if (!body || typeof body !== 'object' || !STATUSES.has(body.status)) throw new Error('malformed body');
      this.cache.set(inst, { at: nowMs, value: body });
      return body;
    } catch (e) {
      this.logger.debug(`[mbm] behaviour(${inst}) unavailable: ${errText(e)}`);
      return { instrument: inst, status: 'absent' };
    } finally {
      clearTimeout(timer);
    }
  }
}
