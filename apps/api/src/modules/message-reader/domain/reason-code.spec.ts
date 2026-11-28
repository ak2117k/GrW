import { fillReasonCodes } from './reason-code';
import type { Claim } from './reading.types';

const claim = (over: Partial<Claim>): Claim => ({ subject: 'NIFTY', verdict: 'NOT_CHECKABLE', reasonCode: null, ...over }) as unknown as Claim;
const refused = { status: 'unavailable', source: 'x', reason: 'reader quote budget: 6 quotes (underlyings + options) already fetched in the last minute' };

describe('fillReasonCodes', () => {
  it('a failed block on the subject sets the code, but never over the model\'s FORWARD_LOOKING', () => {
    const packet = { instruments: { NIFTY: { quote: { status: 'present', source: 'q', value: {} }, option: refused } } };
    const [fwd, other] = fillReasonCodes([claim({ reasonCode: 'FORWARD_LOOKING' }), claim({ reasonCode: 'OTHER' })], packet);
    expect(fwd.reasonCode).toBe('FORWARD_LOOKING');
    expect(other.reasonCode).toBe('QUOTE_BUDGET');
  });
});
