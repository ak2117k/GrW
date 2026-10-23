import { HttpException } from '@nestjs/common';
import { PENDING_TTL_MS, TelegramAuthService } from '../services/telegram-auth.service';
import { FakeTgClient } from './fake-client';

describe('TelegramAuthService connect state machine', () => {
  const input = { apiId: 1, apiHash: 'a'.repeat(32), phone: '+91 98765 43210' };

  function build(client = new FakeTgClient()) {
    const factory = { create: jest.fn(() => client) };
    const store = { save: jest.fn(async () => undefined) };
    const listener = { restart: jest.fn(async () => undefined) };
    const svc = new TelegramAuthService(factory as any, store as any, listener as any);
    return { svc, client, factory, store, listener };
  }

  it('code -> connected: seals the session and restarts the listener', async () => {
    const { svc, client, store, listener, factory } = build();
    expect(await svc.start('u1', input)).toEqual({ stage: 'code' });
    expect(factory.create).toHaveBeenCalledWith(1, input.apiHash, '');
    expect(svc.pendingStage('u1')).toBe('code');
    expect(await svc.confirm('u1', { code: '12345' })).toEqual({ stage: 'connected' });
    expect(store.save).toHaveBeenCalledWith(
      'u1',
      { apiId: 1, apiHash: input.apiHash, session: 'SESSION', phone: '+919876543210' },
      {},
    );
    expect(listener.restart).toHaveBeenCalled();
    expect(svc.pendingStage('u1')).toBeNull();
    expect(client.calls).toContain('disconnect');
  });

  it('2FA: code without password -> password stage -> connected', async () => {
    const c = new FakeTgClient();
    c.needsPassword = true;
    const { svc, store } = build(c);
    await svc.start('u1', input);
    expect(await svc.confirm('u1', { code: '12345' })).toEqual({ stage: 'password' });
    expect(store.save).not.toHaveBeenCalled();
    await expect(svc.confirm('u1', { password: 'nope' })).rejects.toThrow(/two-step verification password is wrong/);
    expect(svc.pendingStage('u1')).toBe('password');
    expect(await svc.confirm('u1', { password: 'pw' })).toEqual({ stage: 'connected' });
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('2FA: code + password in one call', async () => {
    const c = new FakeTgClient();
    c.needsPassword = true;
    const { svc } = build(c);
    await svc.start('u1', input);
    expect(await svc.confirm('u1', { code: '12345', password: 'pw' })).toEqual({ stage: 'connected' });
  });

  it('a wrong code keeps the login open for a retry', async () => {
    const { svc } = build();
    await svc.start('u1', input);
    await expect(svc.confirm('u1', { code: '00000' })).rejects.toThrow(/login code is wrong/);
    expect(svc.pendingStage('u1')).toBe('code');
    expect(await svc.confirm('u1', { code: '12345' })).toEqual({ stage: 'connected' });
  });

  it('expired or missing login -> 409', async () => {
    const { svc } = build();
    await expect(svc.confirm('u1', { code: '12345' })).rejects.toThrow(/No login in progress/);
    let now = 1_000;
    svc.now = () => now;
    await svc.start('u1', input);
    now += PENDING_TTL_MS + 1;
    await expect(svc.confirm('u1', { code: '12345' })).rejects.toThrow(/No login in progress/);
  });

  it('FLOOD_WAIT on sendCode -> 429 and the client is closed', async () => {
    const c = new FakeTgClient();
    c.sendCode = async () => {
      throw Object.assign(new Error('flood'), { errorMessage: 'FLOOD_WAIT_X', seconds: 120 });
    };
    const { svc } = build(c);
    const err = await svc.start('u1', input).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(c.calls).toContain('disconnect');
    expect(svc.pendingStage('u1')).toBeNull();
  });

  it('error messages never echo the phone or code', async () => {
    const { svc } = build();
    await svc.start('u1', input);
    const err = await svc.confirm('u1', { code: '99999' }).catch((e) => e);
    expect(String(err.message)).not.toMatch(/9876543210|99999/);
  });
});
