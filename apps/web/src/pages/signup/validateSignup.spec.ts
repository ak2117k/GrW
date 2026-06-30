import { describe, it, expect } from 'vitest';
import { validateSignup } from './validateSignup';

const ok = { email: 'a@b.com', password: 'password1', confirm: 'password1' };
describe('validateSignup', () => {
  it('accepts a valid payload', () => expect(validateSignup(ok)).toEqual({}));
  it('rejects a malformed email', () =>
    expect(validateSignup({ ...ok, email: 'nope' }).email).toBeTruthy());
  it('rejects a short password', () =>
    expect(validateSignup({ ...ok, password: 'short', confirm: 'short' }).password).toBeTruthy());
  it('rejects a >128 char password', () => {
    const p = 'x'.repeat(129);
    expect(validateSignup({ ...ok, password: p, confirm: p }).password).toBeTruthy();
  });
  it('flags a confirm mismatch', () =>
    expect(validateSignup({ ...ok, confirm: 'different' }).confirm).toBeTruthy());
  it('rejects a >120 char display name', () =>
    expect(validateSignup({ ...ok, displayName: 'y'.repeat(121) }).displayName).toBeTruthy());
});
