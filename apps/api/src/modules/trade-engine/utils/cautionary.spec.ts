import {
  seriesCautionary,
  isSurveillanceRejection,
  cautionaryHint,
} from './cautionary';

/**
 * The EXACT real broker rejection message Angel One returns for a
 * cautionary/surveillance-listed token. Used verbatim below so the
 * matcher + hint stay pinned to production reality.
 */
const REAL_REJECTION =
  'Order rejected by broker: The order cannot be processed as the token is ' +
  'categorised under cautionary listings by the exchange.';

describe('seriesCautionary', () => {
  it('flags a -BE (Trade-to-Trade) symbol as cautionary, delivery-only', () => {
    expect(seriesCautionary('TATASTEEL-BE')).toEqual({
      cautionary: true,
      reason: 'Trade-to-Trade (delivery-only)',
      deliveryOnly: true,
    });
  });

  it('flags a -BZ (Trade-to-Trade) symbol as cautionary, delivery-only', () => {
    expect(seriesCautionary('SOMECO-BZ')).toEqual({
      cautionary: true,
      reason: 'Trade-to-Trade (delivery-only)',
      deliveryOnly: true,
    });
  });

  it('treats a normal -EQ symbol as not cautionary', () => {
    expect(seriesCautionary('RELIANCE-EQ')).toEqual({
      cautionary: false,
      reason: '',
      deliveryOnly: false,
    });
  });

  it('treats a suffix-less symbol as not cautionary', () => {
    expect(seriesCautionary('INFY')).toEqual({
      cautionary: false,
      reason: '',
      deliveryOnly: false,
    });
  });

  it('is case-insensitive on the series suffix', () => {
    expect(seriesCautionary('tatasteel-be').cautionary).toBe(true);
    expect(seriesCautionary('tatasteel-Bz').cautionary).toBe(true);
    expect(seriesCautionary('reliance-eq').cautionary).toBe(false);
  });

  it('handles empty / nullish input gracefully (not cautionary)', () => {
    expect(seriesCautionary('')).toEqual({
      cautionary: false,
      reason: '',
      deliveryOnly: false,
    });
    expect(seriesCautionary(undefined as unknown as string).cautionary).toBe(false);
    expect(seriesCautionary(null as unknown as string).cautionary).toBe(false);
  });

  it('only matches the series as a trailing suffix, not mid-symbol text', () => {
    // A symbol that merely *contains* "BE" must not trip the flag.
    expect(seriesCautionary('ABBOTINDIA-EQ').cautionary).toBe(false);
    expect(seriesCautionary('BERGEPAINT-EQ').cautionary).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(seriesCautionary('  TATASTEEL-BE  ').cautionary).toBe(true);
  });
});

describe('isSurveillanceRejection', () => {
  it('matches the EXACT real Angel One cautionary rejection message', () => {
    expect(isSurveillanceRejection(REAL_REJECTION)).toBe(true);
  });

  it('matches a variety of surveillance phrasings (case-insensitive)', () => {
    const positives = [
      'token is under SURVEILLANCE',
      'Trade to Trade segment — delivery only',
      'trade-to-trade restriction applies',
      'This scrip is in ASM stage II',
      'GSM stage 4 — additional surveillance margin',
      'ESM framework applies to this stock',
      'Product not allowed in this product type',
      'Order not allowed in this product',
      'delivery only for this security',
    ];
    for (const msg of positives) {
      expect(isSurveillanceRejection(msg)).toBe(true);
    }
  });

  it('does NOT match unrelated rejections', () => {
    const negatives = [
      'Insufficient funds',
      'RMS: margin shortfall',
      'Invalid quantity',
      'Order rejected: price out of circuit limit',
      'Market is closed',
      '', // empty
    ];
    for (const msg of negatives) {
      expect(isSurveillanceRejection(msg)).toBe(false);
    }
  });

  it('does not false-match substrings of unrelated words (ASM/GSM/ESM word boundaries)', () => {
    // "PLASMA", "ORGASM" etc. contain ASM but are not the ASM flag.
    expect(isSurveillanceRejection('PLASMA cutter order')).toBe(false);
    expect(isSurveillanceRejection('phantasm quantity')).toBe(false);
  });

  it('handles null / undefined safely', () => {
    expect(isSurveillanceRejection(null)).toBe(false);
    expect(isSurveillanceRejection(undefined)).toBe(false);
  });
});

describe('cautionaryHint', () => {
  it('appends the actionable suffix to the original message', () => {
    const out = cautionaryHint(REAL_REJECTION);
    expect(out.startsWith(REAL_REJECTION)).toBe(true);
    expect(out).toContain('delivery-only');
    expect(out).toContain('Switch Product to DELIVERY');
  });

  it('does not double-append when the hint is already present', () => {
    const once = cautionaryHint(REAL_REJECTION);
    const twice = cautionaryHint(once);
    expect(twice).toBe(once);
  });

  it('returns a usable string for an empty original message', () => {
    const out = cautionaryHint('');
    expect(out).toContain('Switch Product to DELIVERY');
  });
});
