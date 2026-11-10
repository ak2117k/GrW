import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  BROKER_ERROR_LOG_MAX_BYTES,
  BROKER_ERROR_LOG_MAX_FILES,
  configureBrokerErrorLog,
  redactBrokerLogLine,
} from './broker-error-log';

// The SDK's own winston (no winston dependency of our own).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const winston = require(require.resolve('winston', { paths: [dirname(require.resolve('smartapi-javascript/package.json'))] }));

/** The SDK's logger, rebuilt exactly as lib/winston_log.js builds it, but writing to a temp dir. */
function sdkLikeLogger(dir: string) {
  const { createLogger, format, transports } = winston;
  return createLogger({
    format: format.combine(
      format.timestamp(),
      format.printf((info: any) => {
        let m = `${info.timestamp} [${info.level.toUpperCase()}] - ${info.message}`;
        if (info?.response?.config?.url) m += ` - Request URL : ${info.response.config.url}`;
        if (info?.response?.config?.headers) m += ` - Request Headers : ${JSON.stringify(info.response.config.headers)}`;
        if (info?.response?.config?.data) m += ` - Request Data : ${JSON.stringify(info.response.config.data)}`;
        m += info?.response?.data ? ` - Response Data : ${JSON.stringify(info.response.data)}` : ` - Response Data : ${info.response}`;
        return m;
      }),
    ),
    transports: [new transports.File({ filename: join(dir, 'cwd-error.log'), level: 'error' })],
  });
}

describe('redactBrokerLogLine', () => {
  it('removes bearer tokens, private keys, passwords, TOTPs and JWTs (plain and escaped JSON)', () => {
    const line =
      'Request Headers : {"Authorization":"Bearer eyJhbGciOi.eyJzdWIi.sig","X-PrivateKey":"abcKEY123","X-UserType":"USER"}' +
      ' - Request Data : "{\\"clientcode\\":\\"A123\\",\\"password\\":\\"1234\\",\\"totp\\":\\"654321\\"}"' +
      ' - Response Data : {"data":{"jwtToken":"eyJx.eyJy.z","refreshToken":"rt-secret","feedToken":"ft-secret"}}';
    const out = redactBrokerLogLine(line);
    for (const secret of ['eyJ', 'abcKEY123', '1234\\"', '654321', 'rt-secret', 'ft-secret']) expect(out).not.toContain(secret);
    expect(out).toContain('"X-UserType":"USER"'); // non-secrets kept
    expect(out).toContain('clientcode');
  });

  it('keeps a contract token (symboltoken) — only exact secret keys are redacted', () => {
    expect(redactBrokerLogLine('{"symboltoken":"472790","ordertag":"atMabc"}')).toBe('{"symboltoken":"472790","ordertag":"atMabc"}');
  });
});

describe('configureBrokerErrorLog', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'broker-log-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ } });

  it('moves the SDK error log to BROKER_ERROR_LOG_DIR with rotation, and every line is redacted', async () => {
    const logger = sdkLikeLogger(dir);
    const persisted = join(dir, 'broker-logs');
    const r = configureBrokerErrorLog({ BROKER_ERROR_LOG_DIR: persisted }, () => ({ errorLogger: logger }), dir);
    expect(r).toEqual({ path: join(persisted, 'error.log') });
    expect(logger.transports).toHaveLength(1);
    const t = logger.transports[0];
    expect(t.filename).toBe('error.log');
    expect(t.dirname).toBe(persisted);
    expect(t.maxsize).toBe(BROKER_ERROR_LOG_MAX_BYTES);
    expect(t.maxFiles).toBe(BROKER_ERROR_LOG_MAX_FILES);

    // The SDK's "no HTTP response" branch: the whole axios error, config headers included.
    logger.error({
      message: 'Error Response in else if block', clientId: 'A123',
      response: { config: { url: '/order/v1/placeOrder', headers: { Authorization: 'Bearer eyJa.eyJb.c', 'X-PrivateKey': 'KEY9' }, data: '{"ordertag":"atMabc"}' } },
    });
    await new Promise<void>((resolve) => { logger.on('finish', () => resolve()); logger.end(); });
    await new Promise((res) => setTimeout(res, 50));
    const text = readFileSync(join(persisted, 'error.log'), 'utf8');
    expect(text).toContain('Error Response in else if block');
    expect(text).toContain('/order/v1/placeOrder');
    expect(text).toContain('atMabc');
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('KEY9');
  });

  it('defaults to the cwd (as the SDK did) when BROKER_ERROR_LOG_DIR is unset', () => {
    const logger = sdkLikeLogger(dir);
    expect(configureBrokerErrorLog({}, () => ({ errorLogger: logger }), dir)).toEqual({ path: join(dir, 'error.log') });
  });

  it('never throws; leaves the logger alone when it is not the expected shape', () => {
    expect(configureBrokerErrorLog({}, () => { throw new Error('no sdk'); }, dir)).toBeNull();
    expect(configureBrokerErrorLog({}, () => ({}), dir)).toBeNull();
    expect(configureBrokerErrorLog({}, () => ({ errorLogger: { transports: [] } }), dir)).toBeNull();
    expect(existsSync(join(dir, 'error.log'))).toBe(false);
  });
});
