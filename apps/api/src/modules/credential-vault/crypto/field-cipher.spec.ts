import { randomBytes } from 'crypto';
import { decryptWithDataKey, encryptWithDataKey } from './field-cipher';

const key = () => randomBytes(32);

describe('field-cipher', () => {
  it('round-trips under the same key', () => {
    const k = key();
    expect(decryptWithDataKey(encryptWithDataKey('angel-secret', k), k)).toBe('angel-secret');
  });

  it('rejects a malformed blob by shape', () => {
    expect(() => decryptWithDataKey('nope', key())).toThrow(/expected iv:tag:ct/);
  });

  describe('the WRONG-KEY message', () => {
    // THE BUG THIS EXISTS FOR — a diagnostic one, and it cost a full day.
    //
    // Node's AES-GCM failure is "Unsupported state or unable to authenticate
    // data". That names a crypto fault, but it reaches the top through a broker
    // session, so every quote, candle and option-chain read failed with it and
    // the conclusion drawn was "the Angel session is broken". Time then went
    // into a broker problem that did not exist, while the real cause was a
    // process holding a different ENCRYPTION_KEY than the one that sealed the
    // credential. The broker was never even contacted.

    it('says it is a KEY problem, not a broker rejection', () => {
      const sealed = encryptWithDataKey('angel-secret', key());
      let caught: Error | null = null;
      try {
        decryptWithDataKey(sealed, key()); // a DIFFERENT key
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/ENCRYPTION_KEY/);
      expect(caught!.message).toMatch(/NOT a broker/i);
      // The raw Node string must not survive — it is the thing that misled.
      expect(caught!.message).not.toMatch(/unsupported state/i);
    });

    it('states plainly that the broker was never contacted', () => {
      const sealed = encryptWithDataKey('x', key());
      expect(() => decryptWithDataKey(sealed, key())).toThrow(/never contacted/i);
    });

    it('does not swallow unrelated crypto errors', () => {
      // A wrong-LENGTH key is a different fault and must surface as itself,
      // not be relabelled as a key-mismatch.
      const sealed = encryptWithDataKey('x', key());
      expect(() => decryptWithDataKey(sealed, randomBytes(16))).toThrow(/invalid key length/i);
    });
  });
});
