import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * THE ONLY DOOR. The market hub is the only component allowed to request
 * market data from Angel One. Today's code still has direct callers; they are
 * listed here and the list may only SHRINK — M6 empties it. Orders (placeOrder
 * etc.) are not market data and are out of scope.
 */
const SRC = join(__dirname, '..', '..');
const BROKER_DATA_CALL = /\.(getCandleData|marketData|searchScrip|optionGreek)\(|new WebSocketV2\(/;

export const KNOWN_VIOLATORS: readonly string[] = [
  // M2/M6: chart endpoints move to the hub's CandleStore; debug getCandleData endpoint deleted.
  'modules/market-data/controllers/market-data.controller.ts',
  // M6: WebSocketV2 construction moves into the hub's BrokerSession.
  'modules/market-data/market-data.module.ts',
  // M6: the shared "feed account" stack is deleted.
  'modules/market-data/services/angel-one-adapter.service.ts',
  'modules/market-data/services/angel-one-websocket.service.ts',
  // M6: the per-user session moves under modules/market-hub (it IS the hub's broker session).
  'modules/market-data/services/user-feed-session.ts',
  // M5: option chain served by the hub.
  'modules/options-chain/services/options-chain.service.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

function violators(): string[] {
  return walk(SRC)
    .map((p) => relative(SRC, p).split(sep).join('/'))
    .filter((rel) => !rel.startsWith('modules/market-hub/'))
    .filter((rel) => BROKER_DATA_CALL.test(readFileSync(join(SRC, rel), 'utf8')))
    .sort();
}

describe('only door to the broker for market data', () => {
  it('no file outside market-hub calls the broker for market data, except the shrinking list', () => {
    const unexpected = violators().filter((f) => !KNOWN_VIOLATORS.includes(f));
    expect(unexpected).toEqual([]);
  });

  it('every listed file still violates — remove it from the list once it is fixed', () => {
    const now = new Set(violators());
    expect(KNOWN_VIOLATORS.filter((f) => !now.has(f))).toEqual([]);
  });
});
