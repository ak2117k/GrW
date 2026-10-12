import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Contract shared with ai-engine `/score` (plan Task B7) — keep field names identical. */
export interface ScoreRequest {
  featureSet: 'fs1-legacy-checks';
  breakdown: unknown;
  context: {
    vixAtEntry?: number | null;
    vixRegime?: string | null;
    adRatio?: number | null;
    decidedAt: string;
    direction: 'LONG' | 'SHORT';
    strategyKey: string;
    profitTargetSource?: string | null;
  };
}

export type ScoreResult =
  | { source: 'model'; pWin: number; expectedR: number; modelId: string; featureSet: string; missing: string[] }
  | { source: 'rule'; pWin: number; expectedR: null; featureSet: string; missing: string[] }
  | { source: 'unavailable'; reason: string };

/** How long a caller ever waits for a score. */
export const SCORER_TIMEOUT_MS = 1500;
const WARN_INTERVAL_MS = 60_000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** The body if it is a well-formed model/rule score, else why not. */
function parseScore(body: unknown): ScoreResult | string {
  if (typeof body !== 'object' || body === null) return 'not an object';
  const b = body as Record<string, unknown>;
  if (!isNum(b.pWin) || b.pWin < 0 || b.pWin > 1) return 'pWin must be a number in [0,1]';
  if (!isStr(b.featureSet)) return 'featureSet must be a string';
  if (!isStrArray(b.missing)) return 'missing must be a string array';
  if (b.source === 'model') {
    if (!isNum(b.expectedR)) return 'model expectedR must be a number';
    if (!isStr(b.modelId)) return 'model modelId must be a string';
    return {
      source: 'model',
      pWin: b.pWin,
      expectedR: b.expectedR,
      modelId: b.modelId,
      featureSet: b.featureSet,
      missing: b.missing,
    };
  }
  if (b.source === 'rule') {
    if (b.expectedR !== null) return 'rule expectedR must be null';
    return { source: 'rule', pWin: b.pWin, expectedR: null, featureSet: b.featureSet, missing: b.missing };
  }
  return `unknown source ${JSON.stringify(b.source)}`;
}

/**
 * Node → ai-engine `/score` (spec: the gated entry scorer). FAIL-OPEN.
 *
 * `score` never throws and never waits longer than {@link SCORER_TIMEOUT_MS}:
 * an unset URL, a network error, a timeout, a non-2xx reply or a body that
 * fails the shape check all resolve to `{ source: 'unavailable', reason }`, so
 * a down or slow ai-engine can only ever cost a caller its score, never its
 * decision path. Failures are logged at warn at most once a minute — a dead
 * engine would otherwise log on every scored setup.
 *
 * The deadline is enforced by our own timer racing the request (which it also
 * aborts), not by trusting `fetch` to honour the signal promptly.
 */
@Injectable()
export class ScorerClient {
  private readonly logger = new Logger(ScorerClient.name);
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly config: ConfigService) {}

  async score(req: ScoreRequest): Promise<ScoreResult> {
    const base = this.config.get<string>('AI_ENGINE_URL')?.trim();
    if (!base) return this.unavailable('AI_ENGINE_URL not set');
    const url = `${base.replace(/\/+$/, '')}/score`;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ScoreResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(this.unavailable(`timeout after ${SCORER_TIMEOUT_MS} ms`));
      }, SCORER_TIMEOUT_MS);
    });

    const attempt = (async (): Promise<ScoreResult> => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
          signal: controller.signal,
        });
        if (!res.ok) return this.unavailable(`http ${res.status}`);
        const parsed = parseScore(await res.json());
        return typeof parsed === 'string' ? this.unavailable(`malformed reply: ${parsed}`) : parsed;
      } catch (err) {
        if (controller.signal.aborted) return { source: 'unavailable', reason: `timeout after ${SCORER_TIMEOUT_MS} ms` };
        return this.unavailable(`request failed: ${(err as Error)?.message ?? String(err)}`);
      }
    })();

    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private unavailable(reason: string): ScoreResult {
    const now = Date.now();
    if (now - this.lastWarnAt >= WARN_INTERVAL_MS) {
      this.lastWarnAt = now;
      this.logger.warn(`scorer unavailable: ${reason} (further failures suppressed for 60 s)`);
    }
    return { source: 'unavailable', reason };
  }
}
