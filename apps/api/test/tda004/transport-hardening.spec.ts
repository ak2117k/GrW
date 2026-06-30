import { INestApplication, Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { applyHttpHardening } from '../../src/main';

@Controller() class PingController { @Get('ping') ping() { return { ok: true }; } }
@Module({ controllers: [PingController] }) class PingModule {}

let app: INestApplication; let url: string;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [PingModule] }).compile();
  app = mod.createNestApplication();
  applyHttpHardening(app, { NODE_ENV: 'production', WEB_ORIGIN: 'https://app.example.com' } as any);
  await app.init(); await app.listen(0);
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => { await app?.close(); });

it('sets helmet security headers and hides X-Powered-By', async () => {
  const res = await fetch(`${url}/ping`);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toMatch(/DENY|SAMEORIGIN/);
  expect(res.headers.get('x-powered-by')).toBeNull();
});
it('rejects a foreign CORS origin in production', async () => {
  const res = await fetch(`${url}/ping`, { headers: { Origin: 'https://evil.example.com' } });
  // CORS rejection → no ACAO echoing the foreign origin
  expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
});
it('allows the configured WEB_ORIGIN', async () => {
  const res = await fetch(`${url}/ping`, { headers: { Origin: 'https://app.example.com' } });
  expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
});
