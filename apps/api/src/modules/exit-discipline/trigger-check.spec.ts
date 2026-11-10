import { parseInvalidationText, triggerCheck, triggerCheckFromPacket, type TriggerCheckInput } from './trigger-check';

/** Paper trade cmwaqfnbs0g1epm01gowo9h2t, 2026-11-10 21:21 IST: GOLD 141000 PE long, net −₹7.8k. */
const GOLD: TriggerCheckInput = {
  op: 'ABOVE', instrument: 'UNDERLYING', triggerPrice: 141150, refPrice: 141021,
  noiseUnit: 56, noiseSource: 'packet.underlying:atr14-1m', invalidation: 141860, invalidationSource: 'VERDICT_TEXT',
  positionWant: 'DOWN', netPnl: -7800, greenFloorArmed: false,
};

const goldPacket = (patch: Record<string, unknown> = {}) => ({
  position: { symbol: 'GOLD26DEC26141000PE', side: 'LONG', qty: 1, entryPrice: 2900, ltp: 2635.5,
    underlyingLtp: { available: true, value: 141021, source: 's', at: 'a' } },
  money: { netPnl: -7800, charges: 60, greenFloorPrice: null, greenFloorArmed: false },
  thesis: { available: true, value: { direction: 'SHORT', invalidation: 141900, source: 'AGENT' }, source: 's', at: 'a' },
  flow: { noiseUnit: { available: true, source: 's', at: 'a', value: {
    contract: { n: 21.5, method: 'atr14-1m', bars: 60, at: 'x' }, underlying: { n: 56, method: 'atr14-1m', bars: 60, at: 'x' } } } },
  ...patch,
});

describe('triggerCheck (record only)', () => {
  it('the gold case: 2.3 N away, inside its own invalidation, cutting a loss, tight', () => {
    expect(triggerCheck(GOLD)).toEqual({
      v: 1, op: 'ABOVE', instrument: 'UNDERLYING', triggerPrice: 141150, refPrice: 141021,
      distance: 129, distanceN: 2.3, insideInvalidation: true, invalidation: 141860, invalidationSource: 'VERDICT_TEXT',
      noiseUnit: 56, noiseSource: 'packet.underlying:atr14-1m', positionWant: 'DOWN',
      netPnl: -7800, pnlState: 'RED', greenFloorArmed: false, purpose: 'CUT_LOSS', tight: true,
    });
  });

  it('a trigger at or beyond the invalidation is not inside it', () => {
    expect(triggerCheck({ ...GOLD, triggerPrice: 141860 }).insideInvalidation).toBe(false);
    expect(triggerCheck({ ...GOLD, triggerPrice: 141900 }).insideInvalidation).toBe(false);
  });

  it('a long call (want UP): a BELOW trigger between the price and a lower invalidation is inside', () => {
    const c = triggerCheck({ ...GOLD, op: 'BELOW', triggerPrice: 140900, invalidation: 140500, positionWant: 'UP' });
    expect(c).toMatchObject({ distance: -121, distanceN: 2.16, insideInvalidation: true });
  });

  it('an invalidation already breached (on the wrong side of the price) ⇒ false', () => {
    expect(triggerCheck({ ...GOLD, invalidation: 140900 }).insideInvalidation).toBe(false);
  });

  it('PREMIUM, no invalidation or no direction ⇒ insideInvalidation null', () => {
    expect(triggerCheck({ ...GOLD, instrument: 'PREMIUM' }).insideInvalidation).toBeNull();
    expect(triggerCheck({ ...GOLD, invalidation: null }).insideInvalidation).toBeNull();
    expect(triggerCheck({ ...GOLD, positionWant: null }).insideInvalidation).toBeNull();
  });

  it('no noise unit ⇒ distanceN null and never tight', () => {
    expect(triggerCheck({ ...GOLD, noiseUnit: null })).toMatchObject({ distanceN: null, tight: false, noiseSource: null });
    expect(triggerCheck({ ...GOLD, noiseUnit: 0 })).toMatchObject({ distanceN: null, tight: false });
  });

  it('wide trigger is not tight', () => {
    expect(triggerCheck({ ...GOLD, triggerPrice: 141250 })).toMatchObject({ distanceN: 4.09, tight: false });
  });

  it('purpose: green or a green floor armed ⇒ PROTECT_PROFIT; flat/red without a floor ⇒ CUT_LOSS', () => {
    expect(triggerCheck({ ...GOLD, netPnl: 500 })).toMatchObject({ pnlState: 'GREEN', purpose: 'PROTECT_PROFIT' });
    expect(triggerCheck({ ...GOLD, greenFloorArmed: true })).toMatchObject({ pnlState: 'RED', purpose: 'PROTECT_PROFIT' });
    expect(triggerCheck({ ...GOLD, netPnl: 0 })).toMatchObject({ pnlState: 'FLAT', purpose: 'CUT_LOSS' });
    expect(triggerCheck({ ...GOLD, netPnl: null })).toMatchObject({ pnlState: 'FLAT', purpose: 'CUT_LOSS' });
  });
});

describe('parseInvalidationText', () => {
  it.each([
    ['GOLD 15m close above 141860', 141860],
    ['sustained trade above 141,860 (VWAP 141725)', 141860],
    ['2 N above 141860', 141860],
    ['close below 1450', null], // off the 141021 scale
    ['thesis breaks if momentum fades', null],
    ['', null],
  ])('%s → %s', (text, want) => {
    expect(parseInvalidationText(text, 141021)).toBe(want);
  });

  it('no text or no reference ⇒ null', () => {
    expect(parseInvalidationText(null, 141021)).toBeNull();
    expect(parseInvalidationText('above 141860', null)).toBeNull();
  });
});

describe('triggerCheckFromPacket', () => {
  it('the gold case from the stored packet: verdict text wins over the packet thesis', () => {
    const c = triggerCheckFromPacket({ op: 'ABOVE', instrument: 'UNDERLYING', triggerPrice: 141150, refPrice: 141021,
      packet: goldPacket(), invalidationPoint: 'GOLD sustains above 141860 (VWAP 141725 reclaimed)', netPnl: -7800 });
    expect(c).toMatchObject({ distanceN: 2.3, insideInvalidation: true, invalidation: 141860, invalidationSource: 'VERDICT_TEXT',
      noiseUnit: 56, noiseSource: 'packet.underlying:atr14-1m', positionWant: 'DOWN', purpose: 'CUT_LOSS', tight: true });
  });

  it('falls back to the packet thesis invalidation, and the packet netPnl', () => {
    const c = triggerCheckFromPacket({ op: 'ABOVE', instrument: 'UNDERLYING', triggerPrice: 141150, refPrice: 141021,
      packet: goldPacket(), invalidationPoint: 'momentum fades' });
    expect(c).toMatchObject({ invalidation: 141900, invalidationSource: 'PACKET_THESIS', netPnl: -7800 });
  });

  it('PREMIUM uses the contract noise unit', () => {
    const c = triggerCheckFromPacket({ op: 'BELOW', instrument: 'PREMIUM', triggerPrice: 2600, refPrice: 2635.5,
      packet: goldPacket(), invalidationPoint: 'above 141860' });
    expect(c).toMatchObject({ noiseUnit: 21.5, noiseSource: 'packet.contract:atr14-1m', distanceN: 1.65, insideInvalidation: null, invalidation: 141860 });
  });

  it('a packet with no noise unit and no thesis still records distance', () => {
    const c = triggerCheckFromPacket({ op: 'ABOVE', instrument: 'UNDERLYING', triggerPrice: 141150, refPrice: 141021,
      packet: goldPacket({ flow: {}, thesis: { available: false, reason: 'x' } }), invalidationPoint: null });
    expect(c).toMatchObject({ distance: 129, distanceN: null, insideInvalidation: null, invalidation: null, tight: false });
  });

  it('unreadable packet ⇒ null, never a throw', () => {
    expect(triggerCheckFromPacket({ op: 'ABOVE', instrument: 'UNDERLYING', triggerPrice: 1, refPrice: 1, packet: null, invalidationPoint: null })).toBeNull();
    const evil = { get position() { throw new Error('boom'); } };
    expect(triggerCheckFromPacket({ op: 'ABOVE', instrument: 'UNDERLYING', triggerPrice: 1, refPrice: 1, packet: evil, invalidationPoint: null })).toBeNull();
  });
});
