import { AngelOneValidator } from '../../src/modules/market-data/services/angel-one-validator.service';
import { generateTOTP } from '../../src/modules/market-data/utils/angel-one-totp';

const creds = { apiKey: 'k', clientId: 'C1', password: 'p', totpSecret: 'JBSWY3DPEHPK3PXP' };

describe('AngelOneValidator.validateLogin (ephemeral, no singleton mutation)', () => {
  it('returns success when generateSession yields a jwtToken', async () => {
    const fakeApi = { generateSession: jest.fn().mockResolvedValue({ data: { jwtToken: 'jwt' } }) };
    const v = new AngelOneValidator(() => fakeApi as any);
    const r = await v.validateLogin(creds);
    expect(r.success).toBe(true);
    expect(fakeApi.generateSession).toHaveBeenCalledTimes(1);
  });

  it('passes a fresh TOTP computed from the shared util to generateSession', async () => {
    const fakeApi = { generateSession: jest.fn().mockResolvedValue({ data: { jwtToken: 'jwt' } }) };
    const v = new AngelOneValidator(() => fakeApi as any);
    await v.validateLogin(creds);
    const [, , totp] = fakeApi.generateSession.mock.calls[0];
    expect(totp).toBe(generateTOTP(creds.totpSecret));
  });

  it('maps a jwtToken-less response to a generic failure', async () => {
    const fakeApi = { generateSession: jest.fn().mockResolvedValue({ message: 'no session' }) };
    const v = new AngelOneValidator(() => fakeApi as any);
    const r = await v.validateLogin(creds);
    expect(r.success).toBe(false);
  });

  it('returns a generic failure without leaking the broker error', async () => {
    const fakeApi = { generateSession: jest.fn().mockRejectedValue(new Error('AB1234: invalid password')) };
    const v = new AngelOneValidator(() => fakeApi as any);
    const r = await v.validateLogin({ ...creds, password: 'bad' });
    expect(r.success).toBe(false);
    expect(r.reason ?? '').not.toContain('invalid password');
  });
});
