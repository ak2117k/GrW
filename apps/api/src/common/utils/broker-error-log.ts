/**
 * smartapi-javascript's own error log, kept across deploys, size-capped and redacted.
 *
 * The SDK (lib/winston_log.js) builds ONE module-level winston logger whose only
 * transport is `new transports.File({ filename: 'error.log' })` — relative to the
 * process cwd (/app in the container), so every redeploy threw it away (2026-11-10:
 * it was the only record of the Angel timeouts behind a lost exit order). It never
 * rotates, and its line format includes the axios request headers and body, i.e. the
 * `Authorization: Bearer <jwt>` and `X-PrivateKey` headers (and, for a failed login,
 * the password / TOTP).
 *
 * At boot this swaps that transport for one of the SAME class (the SDK's own winston,
 * so nothing in node_modules is patched and no winston dependency is added) that:
 *  - writes `<BROKER_ERROR_LOG_DIR>/error.log` (default: the cwd, as before) — the
 *    prod compose mounts a named volume there;
 *  - rotates at BROKER_ERROR_LOG_MAX_BYTES, keeping BROKER_ERROR_LOG_MAX_FILES files;
 *  - redacts tokens, keys and passwords from every line before it is written.
 * Never throws: on any problem the SDK's logger is left as it was and null is returned.
 */
import { mkdirSync } from 'fs';
import { join } from 'path';

export const BROKER_ERROR_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const BROKER_ERROR_LOG_MAX_FILES = 5;
const MESSAGE = Symbol.for('message');

const SECRET_KEYS = [
  'authorization', 'x-privatekey', 'password', 'totp', 'pin', 'jwttoken', 'refreshtoken', 'feedtoken',
  'access_token', 'refresh_token', 'api_key', 'apikey', 'privatekey', 'secret', 'token',
];
// "key":"value" and the escaped \"key\":\"value\" (the SDK JSON.stringifies an already-JSON body).
const KEYED = new RegExp(`(\\\\?"(?:${SECRET_KEYS.join('|')})\\\\?"\\s*:\\s*\\\\?")[^"\\\\]*`, 'gi');

/** Strip credentials from one SDK log line. Pure. */
export function redactBrokerLogLine(line: string): string {
  return String(line)
    .replace(KEYED, '$1<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/eyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, '<redacted-jwt>');
}

interface TransportLike {
  close?: () => void;
  constructor: new (opts: Record<string, unknown>) => TransportLike;
}
interface LoggerLike {
  transports: TransportLike[];
  add(t: TransportLike): unknown;
  remove(t: TransportLike): unknown;
}

export interface BrokerErrorLogResult {
  path: string;
}

export function configureBrokerErrorLog(
  env: Record<string, string | undefined> = process.env,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  load: () => { errorLogger?: unknown } = () => require('smartapi-javascript/lib/winston_log'),
  cwd: string = process.cwd(),
): BrokerErrorLogResult | null {
  try {
    const logger = load()?.errorLogger as LoggerLike | undefined;
    if (!logger || !Array.isArray(logger.transports) || logger.transports.length === 0) return null;
    const current = logger.transports[0];
    const FileTransport = current.constructor;
    const dir = (env.BROKER_ERROR_LOG_DIR ?? '').trim() || cwd;
    mkdirSync(dir, { recursive: true });
    const filename = join(dir, 'error.log');
    const replacement = new FileTransport({
      filename,
      level: 'error',
      maxsize: BROKER_ERROR_LOG_MAX_BYTES,
      maxFiles: BROKER_ERROR_LOG_MAX_FILES,
      tailable: true,
      // A logform-shaped format: runs after the SDK's own printf has built the line.
      format: {
        transform: (info: Record<string | symbol, unknown>) => {
          info[MESSAGE] = redactBrokerLogLine(String(info[MESSAGE] ?? info.message ?? ''));
          return info;
        },
      },
    });
    logger.add(replacement);
    logger.remove(current);
    try {
      current.close?.();
    } catch {
      // the old file handle is best-effort
    }
    return { path: filename };
  } catch {
    return null;
  }
}
