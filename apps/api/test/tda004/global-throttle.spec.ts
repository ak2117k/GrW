/**
 * TDA-004 Task 6 — central global throttler (integration test).
 *
 * Boots a FOCUSED Nest HTTP app (Style-A) that wires the SAME central
 * ThrottlerModule config used by app.module.ts plus the global ThrottlerGuard
 * via APP_GUARD, and hammers a tiny test route to prove the guard rejects the
 * (limit+1)th request with HTTP 429.
 *
 * The limit is overridden to 3/60s via the GLOBAL_RATE_LIMIT env var (read by
 * configuration.ts -> rateLimit.limit). REDIS_THROTTLER is forced unset so the
 * default in-memory storage is used — no Redis needed in CI.
 *
 * Run from apps/api:
 *   npx jest --config test/tda004/jest.config.js --verbose
 */

// Set the override env BEFORE configuration.ts is imported/evaluated.
process.env.GLOBAL_RATE_LIMIT = '3';
process.env.GLOBAL_RATE_TTL = '60000';
delete process.env.REDIS_THROTTLER; // force in-memory storage

import {
  Controller,
  Get,
  INestApplication,
  Module,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import configuration from '../../src/config/configuration';

@Controller('throttle-test')
class ThrottleTestController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

// Mirror of the app.module.ts central registration: name 'default', ttl/limit
// sourced from rateLimit.* config, storage left default (in-memory).
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('rateLimit.ttl', 60_000),
            limit: config.get<number>('rateLimit.limit', 120),
          },
        ],
      }),
    }),
  ],
  controllers: [ThrottleTestController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class ThrottleTestModule {}

async function boot(): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottleTestModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe('TDA-004 Task 6 — central global ThrottlerGuard', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const booted = await boot();
    app = booted.app;
    baseUrl = booted.baseUrl;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('allows up to the limit (3) then 429s the 4th request', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${baseUrl}/throttle-test/ping`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });
});
