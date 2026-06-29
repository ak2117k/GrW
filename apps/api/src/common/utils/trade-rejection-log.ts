/**
 * Shared formatter for "why was this not traded" console logging.
 *
 * Every Chartink stock that does NOT become a trade persists a reason to the
 * DB. This formatter produces a single, consistent console line so the API
 * terminal explains every non-executed stock at every pipeline stage.
 *
 * Both the process/scoring stage and the watch/execution stage use this — the
 * output contract is locked; do not change the shape without updating both.
 */
export interface RejectionLogFields {
  symbol: string;
  stage: 'ingest' | 'process' | 'scoring' | 'watch' | 'execution';
  reason: string; // why it was not executed
  scan?: string; // Chartink scanner name (what we received)
  hitPrice?: number; // Chartink trigger/hit price (what we received)
  side?: string; // BUY / SELL if known
  score?: number; // 0-100 score if scored
}

/**
 * Render a rejection as a single line:
 *   `[trade-rejected] <symbol> | <ctx> | stage=<stage> reason="<reason>"`
 * where `<ctx>` is the space-joined subset of
 *   `scan="<scan>" hit=<hitPrice> side=<side> score=<score>`
 * for the fields that are defined. When no ctx fields are defined the
 * `<ctx> | ` segment is omitted entirely.
 */
export function formatTradeRejection(f: RejectionLogFields): string {
  const ctxParts: string[] = [];
  if (f.scan !== undefined) ctxParts.push(`scan="${f.scan}"`);
  if (f.hitPrice !== undefined) ctxParts.push(`hit=${f.hitPrice}`);
  if (f.side !== undefined) ctxParts.push(`side=${f.side}`);
  if (f.score !== undefined) ctxParts.push(`score=${f.score}`);

  const ctx = ctxParts.length > 0 ? `${ctxParts.join(' ')} | ` : '';
  return `[trade-rejected] ${f.symbol} | ${ctx}stage=${f.stage} reason="${f.reason}"`;
}
