import * as argon2 from 'argon2';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('hashes to an argon2id phc string that is not the plaintext', async () => {
    const hash = await svc.hash('s3cret-passw0rd');
    expect(hash).not.toContain('s3cret-passw0rd');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('produces different hashes for the same input (random salt)', async () => {
    const a = await svc.hash('same-input');
    const b = await svc.hash('same-input');
    expect(a).not.toBe(b);
  });

  it('verify returns true for the correct password', async () => {
    const hash = await svc.hash('correct-horse');
    await expect(svc.verify(hash, 'correct-horse')).resolves.toBe(true);
  });

  it('verify returns false for a wrong password', async () => {
    const hash = await svc.hash('correct-horse');
    await expect(svc.verify(hash, 'battery-staple')).resolves.toBe(false);
  });

  it('verify returns false (does not throw) for a malformed hash', async () => {
    await expect(svc.verify('not-a-hash', 'whatever')).resolves.toBe(false);
  });

  it('uses the configured argon2id params', async () => {
    const hash = await svc.hash('param-check');
    // argon2 phc encodes m (memoryCost), t (timeCost), p (parallelism)
    expect(hash).toContain('$argon2id$');
    expect(hash).toMatch(/m=19456/);
    expect(hash).toMatch(/t=2/);
    expect(hash).toMatch(/p=1/);
    // sanity: library agrees the hash verifies
    await expect(argon2.verify(hash, 'param-check')).resolves.toBe(true);
  });
});
