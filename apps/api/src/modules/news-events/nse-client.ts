/**
 * The ONE client for every NSE call in news-events v2 (spec §4.3): a serial queue
 * (never two requests in flight), one request + one retry, a browser UA, a
 * per-endpoint exponential backoff (60 s doubling, max 30 min) during which the
 * endpoint is not asked, and — owner decision N4 — a homepage warm-up for hosts
 * ending in nseindia.com ONLY, after a 401/403. The cookie jar lives in memory
 * and is never logged; log lines carry endpoint labels and HTTP status only.
 */
export interface NseFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
}
export type NseFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<NseFetchResponse>;

export interface NseClientOptions {
  userAgent: string;
  timeoutMs: number;
  retryDelayMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  fetchImpl: NseFetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export const NSE_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const NSE_HOME = 'https://www.nseindia.com/';

class NseHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export function isNseHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'nseindia.com' || h.endsWith('.nseindia.com');
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'request timed out';
    const cause = (err as { cause?: { code?: unknown } }).cause;
    return cause && typeof cause.code === 'string' ? `${err.message} (cause ${cause.code})` : err.message;
  }
  return String(err);
}

function splitSetCookie(header: string | null): string[] {
  return header ? header.split(/,(?=\s*[A-Za-z0-9_-]+=)/) : [];
}

export class NseClient {
  private readonly o: NseClientOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly backoff = new Map<string, { failures: number; until: number }>();
  private cookie: string | null = null;

  constructor(opts: Partial<NseClientOptions> = {}) {
    this.o = {
      userAgent: NSE_BROWSER_UA,
      timeoutMs: 15_000,
      retryDelayMs: 2_000,
      backoffBaseMs: 60_000,
      backoffMaxMs: 30 * 60_000,
      fetchImpl: fetch as unknown as NseFetch,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: () => undefined,
      ...opts,
    };
  }

  getText(endpoint: string, url: string): Promise<string> {
    return this.enqueue(endpoint, url, (body) => body);
  }

  getJson(endpoint: string, url: string): Promise<unknown> {
    return this.enqueue(endpoint, url, (body) => {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new Error(`response was not JSON (${body.slice(0, 40).replace(/\s+/g, ' ')}…)`);
      }
    });
  }

  backoffState(): Record<string, { failures: number; until: string }> {
    const out: Record<string, { failures: number; until: string }> = {};
    for (const [k, v] of this.backoff) out[k] = { failures: v.failures, until: new Date(v.until).toISOString() };
    return out;
  }

  private enqueue<T>(endpoint: string, url: string, parse: (body: string) => T): Promise<T> {
    const run = () => this.guarded(endpoint, url, parse);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async guarded<T>(endpoint: string, url: string, parse: (body: string) => T): Promise<T> {
    const now = this.o.now();
    const b = this.backoff.get(endpoint);
    if (b && now < b.until) {
      throw new Error(`${endpoint} in backoff after ${b.failures} failure(s) until ${new Date(b.until).toISOString()}`);
    }
    try {
      const out = parse(await this.fetchWithRetry(url));
      this.backoff.delete(endpoint);
      return out;
    } catch (err) {
      const failures = (b?.failures ?? 0) + 1;
      const wait = Math.min(this.o.backoffBaseMs * 2 ** (failures - 1), this.o.backoffMaxMs);
      this.backoff.set(endpoint, { failures, until: now + wait });
      const why = describe(err);
      this.o.log(`[nse-client] ${endpoint} failed (${failures} consecutive): ${why}; next try after ${Math.round(wait / 1000)}s`);
      throw new Error(`${endpoint}: ${why}`);
    }
  }

  private async fetchWithRetry(url: string): Promise<string> {
    try {
      return await this.once(url);
    } catch (err) {
      if (err instanceof NseHttpError && (err.status === 401 || err.status === 403) && isNseHost(url)) await this.warmUp();
      else if (this.o.retryDelayMs > 0) await this.o.sleep(this.o.retryDelayMs);
      return this.once(url);
    }
  }

  private async once(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
    const headers: Record<string, string> = {
      'User-Agent': this.o.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (isNseHost(url)) {
      headers.Referer = NSE_HOME;
      if (this.cookie) headers.Cookie = this.cookie;
    }
    try {
      const res = await this.o.fetchImpl(url, { headers, signal: controller.signal });
      if (!res.ok) throw new NseHttpError(res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private async warmUp(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
    try {
      const res = await this.o.fetchImpl(NSE_HOME, {
        headers: { 'User-Agent': this.o.userAgent, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: controller.signal,
      });
      const raw = res.headers.getSetCookie?.() ?? splitSetCookie(res.headers.get('set-cookie'));
      const pairs = raw.map((c) => c.split(';')[0].trim()).filter((p) => p.includes('='));
      if (pairs.length > 0) this.cookie = pairs.join('; ');
      this.o.log(`[nse-client] warm-up: ${pairs.length} cookie(s) held in memory`);
    } catch (err) {
      this.o.log(`[nse-client] warm-up failed: ${describe(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
