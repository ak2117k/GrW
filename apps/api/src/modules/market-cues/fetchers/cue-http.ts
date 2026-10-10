/**
 * One HTTP GET for one cue source: browser User-Agent, an Accept header, a
 * timeout, and exactly ONE retry. No cookies. The thrown error carries the
 * HTTP status or the network cause (`err.cause.code`) — never the headers.
 */

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface CueHttpOptions {
  timeoutMs: number;
  userAgent: string;
  accept: string;
  /** Pause before the single retry. */
  retryDelayMs: number;
  fetchImpl?: FetchLike;
}

export class CueFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly causeCode: string | null,
  ) {
    super(message);
    this.name = 'CueFetchError';
  }
}

/** "HTTP 503", or "fetch failed (cause UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)". Never headers. */
export function describeFetchError(err: unknown): string {
  if (err instanceof CueFetchError) return err.message;
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    const code = cause && typeof cause.code === 'string' ? cause.code : null;
    const msg = cause && typeof cause.message === 'string' ? cause.message : null;
    return code || msg ? `${err.message} (cause ${[code, msg].filter(Boolean).join(': ')})` : err.message;
  }
  return String(err);
}

function toCueError(err: unknown): CueFetchError {
  if (err instanceof CueFetchError) return err;
  const cause = (err as { cause?: { code?: unknown } })?.cause;
  const code = cause && typeof cause.code === 'string' ? cause.code : null;
  const aborted = (err as { name?: string })?.name === 'AbortError' || (err as { name?: string })?.name === 'TimeoutError';
  return new CueFetchError(aborted ? 'request timed out' : describeFetchError(err), null, code ?? (aborted ? 'TIMEOUT' : null));
}

async function once(url: string, o: CueHttpOptions): Promise<string> {
  const doFetch: FetchLike = o.fetchImpl ?? (fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs);
  try {
    const res = await doFetch(url, {
      headers: { 'User-Agent': o.userAgent, Accept: o.accept },
      signal: controller.signal,
    });
    if (!res.ok) throw new CueFetchError(`HTTP ${res.status}`, res.status, null);
    return await res.text();
  } catch (err) {
    throw toCueError(err);
  } finally {
    clearTimeout(timer);
  }
}

/** GET `url` as text; one retry after `retryDelayMs`. Throws {@link CueFetchError}. */
export async function cueGet(url: string, o: CueHttpOptions): Promise<string> {
  try {
    return await once(url, o);
  } catch {
    if (o.retryDelayMs > 0) await new Promise((r) => setTimeout(r, o.retryDelayMs));
    return once(url, o);
  }
}

/** {@link cueGet} parsed as JSON; a body that is not JSON is a CueFetchError naming it. */
export async function cueGetJson(url: string, o: CueHttpOptions): Promise<unknown> {
  const body = await cueGet(url, o);
  try {
    return JSON.parse(body);
  } catch {
    throw new CueFetchError(`response was not JSON (${body.slice(0, 40).replace(/\s+/g, ' ')}…)`, null, null);
  }
}
