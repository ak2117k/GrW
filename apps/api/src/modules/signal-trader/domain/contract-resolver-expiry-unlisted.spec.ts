import { findContract, listedExpiries } from '../../signal-intake/domain/contract';
import { inferExpiry } from '../../signal-intake/domain/expiry';
import { expiryHintOfText } from '../../signal-intake/domain/text';
import { resolveContract } from './contract-resolver';
import type { SignalView } from './signal.types';

/**
 * Fix 3 (2026-11-28): an EXPIRY_UNLISTED signal keeps the date the post named, and the trader's exact-expiry resolve
 * refuses it — it never falls back to the nearest listed contract.
 */
const row = (d: string, mon: string, y: string, token: string) => ({
  token, symbol: `SENSEX${d}${mon}${y}83700PE`, name: 'SENSEX', expiry: `${d}${mon}20${y}`, strike: '8370000.000000',
  lotsize: '20', instrumenttype: 'OPTIDX', exch_seg: 'BFO', tick_size: '5.000000',
});
// The real SENSEX weekly calendar around the post (26-Nov, then Thursdays; 24-Dec listed, no 26-Dec).
const master = [row('26', 'NOV', '26', '1'), row('03', 'DEC', '26', '2'), row('24', 'DEC', '26', '3'), row('31', 'DEC', '26', '4')];

const sig = (over: Partial<SignalView>): SignalView => ({
  id: 's', channelId: null, receivedAt: null, underlying: 'SENSEX', instrumentKind: 'PE', strike: 83700, expiry: null,
  side: 'BUY', entryLow: 180, entryHigh: 180, entryType: 'AT', sl: null, targets: [], qty: null, confidence: null, rawText: '',
  ...over,
});

describe('signal-trader refuses an EXPIRY_UNLISTED signal', () => {
  it('"Sensex 83700 PE (26 DEC𝗘𝘅)" → intake keeps 2026-12-26 with a mismatch; the trader refuses, never the nearest', () => {
    const postedAt = new Date('2026-11-26T03:58:32Z');
    const hint = expiryHintOfText('📈𝗕𝘂𝘆 Sensex 83700 P𝗘(26 DEC𝗘𝘅)\n\n➡️𝗕𝘂𝘆:- 180/');
    const ex = inferExpiry('SENSEX', 'PE', hint, postedAt, listedExpiries(master, 'SENSEX', 'PE', 'BFO'), { exchange: 'BFO' });
    expect(ex).toMatchObject({ expiry: '2026-12-26', mismatch: expect.stringMatching(/not listed/) });
    expect(findContract(master, { underlying: 'SENSEX', instrumentKind: 'PE', strike: 83700, expiry: ex.expiry }, 'BFO')).toBeNull();

    const r = resolveContract(master, sig({ expiry: ex.expiry }), new Date(2026, 10, 26));
    expect(r).toEqual({ ok: false, reason: 'no live contract for SENSEX on expiry 2026-12-26' });
    // Without the named expiry the same signal would have traded the nearest weekly.
    expect(resolveContract(master, sig({ expiry: null }), new Date(2026, 10, 26))).toMatchObject({ ok: true, contract: { token: '1' } });
  });
});
