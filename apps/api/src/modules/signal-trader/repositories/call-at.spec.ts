import { callAtOf } from './signal-trader.repository';

describe('callAtOf (a screenshot call time, owner 2026-11-12)', () => {
  // The CRUDE 8250 PE re-post: posted 15:40:45 IST, the screenshot's own call time 14:34.
  const posted = new Date('2026-11-12T10:10:45Z');

  it('CALL_AT:14:34 on the post IST day', () => {
    expect(callAtOf(['LLM', 'VISION', 'CALL_AT:14:34'], posted)?.toISOString()).toBe('2026-11-12T09:04:00.000Z');
  });

  it('absent, malformed or after the post = null', () => {
    expect(callAtOf(['LLM'], posted)).toBeNull();
    expect(callAtOf(['CALL_AT:2:34 PM'], posted)).toBeNull();
    expect(callAtOf(['CALL_AT:16:00'], posted)).toBeNull();
    expect(callAtOf(null, posted)).toBeNull();
    expect(callAtOf(['CALL_AT:14:34'], null)).toBeNull();
  });
});
