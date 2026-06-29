/**
 * TDA-003 Task 1 — request-scoped tenant context (nestjs-cls).
 *
 * Two layers of proof, no DB needed:
 *  1. HTTP integration: a minimal Nest app wires ClsModule (mounted middleware)
 *     + TenantContextInterceptor (global) + a fake-auth guard that sets
 *     `req.user`. A route reads `TenantContextService.get()` and must see the
 *     `{ userId, role }` derived from `req.user`; a route with no user sees
 *     `undefined`.
 *  2. Unit: `runWithoutTenant` clears the value for the duration of `fn` and
 *     restores it afterwards, all inside a single `cls.run`.
 */

import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
  Module,
  UseGuards,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AsyncLocalStorage } from 'async_hooks';
import { AddressInfo } from 'net';
import { ClsModule, ClsService } from 'nestjs-cls';
import { TenantContextInterceptor } from '../../src/common/tenant/tenant-context.interceptor';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';

/** Test seam: fakes JwtAuthGuard by stamping a known principal on req.user. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = { userId: 'u1', role: 'USER', email: 'a@b.c' };
    return true;
  }
}

@Controller()
class ProbeController {
  constructor(private readonly tenant: TenantContextService) {}

  // Authenticated: FakeAuthGuard sets req.user, interceptor copies it into CLS.
  @Get('with-user')
  @UseGuards(FakeAuthGuard)
  withUser() {
    return { tenant: this.tenant.get() ?? null };
  }

  // No guard → no req.user → context stays unset.
  @Get('no-user')
  noUser() {
    return { tenant: this.tenant.get() ?? null };
  }
}

@Module({
  imports: [ClsModule.forRoot({ middleware: { mount: true } })],
  controllers: [ProbeController],
  providers: [
    TenantContextService,
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
class ProbeModule {}

describe('TDA-003 Task 1 — tenant context (HTTP integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = async (path: string) => {
    const res = await fetch(`${baseUrl}${path}`);
    return res.json();
  };

  it('exposes { userId, role } from req.user inside the handler', async () => {
    const body = await get('/with-user');
    expect(body.tenant).toEqual({ userId: 'u1', role: 'USER' });
  });

  it('leaves the context unset on routes with no req.user', async () => {
    const body = await get('/no-user');
    expect(body.tenant).toBeNull();
  });
});

describe('TDA-003 Task 1 — TenantContextService.runWithoutTenant (unit)', () => {
  it('clears the tenant for the duration of fn, then restores it', async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    const service = new TenantContextService(cls);
    const ctx = { userId: 'u1', role: 'USER' };

    await cls.run(async () => {
      service.set(ctx);
      expect(service.get()).toEqual(ctx);

      const inside = service.runWithoutTenant(() => service.get());
      expect(inside).toBeUndefined();

      // restored after the bypass
      expect(service.get()).toEqual(ctx);
    });
  });

  it('returns the value produced by fn', async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    const service = new TenantContextService(cls);
    await cls.run(async () => {
      service.set({ userId: 'u1', role: 'ADMIN' });
      const result = service.runWithoutTenant(() => 42);
      expect(result).toBe(42);
    });
  });
});
