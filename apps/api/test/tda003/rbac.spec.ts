/**
 * TDA-003 Task 3 — RBAC via @Roles / @AdminOnly + RolesGuard.
 *
 * Bootstraps focused Nest apps that wire the global guards and asserts the
 * authentication-then-authorisation pipeline over real HTTP. No external DB is
 * needed for the guard mechanics — JwtStrategy verifies the Bearer token purely
 * from JWT_SECRET + audience, so we mint tokens with the same claims
 * TokenService.signAccess produces.
 *
 * A test controller exposes three routes:
 *   - GET /rbac-test/admin   — @AdminOnly()  (requires role ADMIN)
 *   - GET /rbac-test/plain   — authenticated, no @Roles (any role)
 *   - GET /rbac-test/public  — @Public()      (no auth at all)
 *
 * Three layers of coverage:
 *   1. Co-located guards (deterministic baseline) — both APP_GUARDs in one
 *      module's providers array, order governed by array position.
 *   2. Guard-ordering MECHANICS (deterministic) — proves the CROSS-MODULE bug:
 *      when RolesGuard is registered in the SCANNED-FIRST root module and
 *      JwtAuthGuard in an IMPORTED module, RolesGuard runs BEFORE auth and an
 *      @AdminOnly route 403s even a valid ADMIN (req.user is still undefined).
 *      The mirrored "fixed" wiring (both co-located in the imported module,
 *      Jwt before Roles) restores ADMIN→200.
 *   3. REAL cross-module wiring — imports the production AuthModule (which, after
 *      the fix, owns BOTH APP_GUARDs) into a root module that plays AppModule's
 *      role. This is the regression gate: it FAILS before the fix (RolesGuard
 *      absent from AuthModule → USER not denied on the admin route) and PASSES
 *      after. Asserts ADMIN→200 under realistic wiring — exactly what the
 *      cross-module ordering bug broke in production (403 for everyone).
 *
 * Run from apps/api:
 *   npx jest --config test/tda003/jest.config.js -v
 */

// JwtStrategy + token signing both read JWT_SECRET from the environment; set it
// before any strategy/module is imported/instantiated.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda003';

// The REAL AuthModule (imported below for the cross-module regression test)
// boots PrismaService, which resolves its connection from DATABASE_URL via
// super(). The guard tests never touch the DB, but onModuleInit still connects,
// so point it at the td_saas_test database (mirrors isolation.spec).
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

import {
  Controller,
  Get,
  INestApplication,
  Module,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { ClsModule } from 'nestjs-cls';
import { Public } from '../../src/common/decorators';
import { AdminOnly } from '../../src/common/decorators/roles.decorator';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/modules/auth/guards/roles.guard';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';

@Controller('rbac-test')
class RbacTestController {
  @Get('admin')
  @AdminOnly()
  admin() {
    return { ok: 'admin' };
  }

  @Get('plain')
  plain() {
    return { ok: 'plain' };
  }

  @Get('public')
  @Public()
  pub() {
    return { ok: 'public' };
  }
}

// Mint an access token with exactly the claims JwtStrategy requires:
// audience 'td-access' + { sub, role, email }.
const jwt = new JwtService();
const tokenFor = (role: 'USER' | 'ADMIN') =>
  jwt.sign(
    { sub: `user-${role}`, role, email: `${role.toLowerCase()}@test.local` },
    {
      secret: process.env.JWT_SECRET,
      algorithm: 'HS256',
      audience: 'td-access',
      expiresIn: '15m',
    },
  );

/** Boot a focused Nest HTTP app from a module and return it + its base URL. */
async function boot(moduleClass: unknown): Promise<{
  app: INestApplication;
  baseUrl: string;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [moduleClass as never],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

/** GET helper bound to a base URL; returns the HTTP status. */
const getter =
  (baseUrl: string) =>
  async (path: string, token?: string): Promise<number> => {
    const headers: Record<string, string> = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return res.status;
  };

// ---------------------------------------------------------------------------
// 1. Co-located guards (deterministic baseline). Both APP_GUARDs live in ONE
//    module's providers array, so execution order is the array order.
// ---------------------------------------------------------------------------
@Module({
  imports: [PassportModule],
  controllers: [RbacTestController],
  providers: [
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class CoLocatedModule {}

describe('TDA-003 Task 3 — RolesGuard + @Roles/@AdminOnly (co-located guards)', () => {
  let app: INestApplication;
  let get: ReturnType<typeof getter>;

  beforeAll(async () => {
    const booted = await boot(CoLocatedModule);
    app = booted.app;
    get = getter(booted.baseUrl);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('USER token', () => {
    it('is forbidden (403) on the @AdminOnly route', async () => {
      expect(await get('/rbac-test/admin', tokenFor('USER'))).toBe(403);
    });
    it('is allowed (200) on a plain authenticated route', async () => {
      expect(await get('/rbac-test/plain', tokenFor('USER'))).toBe(200);
    });
  });

  describe('ADMIN token', () => {
    it('is allowed (200) on the @AdminOnly route', async () => {
      expect(await get('/rbac-test/admin', tokenFor('ADMIN'))).toBe(200);
    });
    it('is allowed (200) on a plain authenticated route', async () => {
      expect(await get('/rbac-test/plain', tokenFor('ADMIN'))).toBe(200);
    });
  });

  describe('no token', () => {
    it('is unauthorized (401) on the @AdminOnly route (JwtAuthGuard runs first)', async () => {
      expect(await get('/rbac-test/admin')).toBe(401);
    });
    it('is unauthorized (401) on a plain authenticated route', async () => {
      expect(await get('/rbac-test/plain')).toBe(401);
    });
    it('is allowed (200) on the @Public route', async () => {
      expect(await get('/rbac-test/public')).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Guard-ordering MECHANICS (deterministic). Reproduces the exact production
//    bug shape: APP_GUARDs split across modules. NestJS runs global enhancers
//    in MODULE-SCAN order (root scanned before its imports), so a guard in the
//    root runs BEFORE a guard in an imported module — regardless of intent.
// ---------------------------------------------------------------------------

// The "auth" leaf: provides ONLY JwtAuthGuard, like the real AuthModule did
// before the fix.
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
class JwtOnlyChildModule {}

// BUGGY wiring: RolesGuard registered in the SCANNED-FIRST root, JwtAuthGuard in
// the imported child → RolesGuard executes FIRST, before req.user exists. This
// is precisely the broken pre-fix layout (RolesGuard in AppModule root,
// JwtAuthGuard in imported AuthModule).
@Module({
  imports: [JwtOnlyChildModule],
  controllers: [RbacTestController],
  providers: [{ provide: APP_GUARD, useClass: RolesGuard }],
})
class BuggyCrossModuleModule {}

// FIXED wiring: both guards co-located in the IMPORTED module (Jwt before
// Roles), mirroring the fix that moves RolesGuard into AuthModule. The root
// owns no guard. Scan order within the single array governs → Jwt then Roles.
@Module({
  imports: [PassportModule],
  providers: [
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class FixedAuthLikeModule {}

@Module({
  imports: [FixedAuthLikeModule],
  controllers: [RbacTestController],
})
class FixedCrossModuleModule {}

describe('TDA-003 Task 3 — cross-module guard ordering (mechanics)', () => {
  describe('BUGGY wiring (RolesGuard in scanned-first root, JwtAuthGuard imported)', () => {
    let app: INestApplication;
    let get: ReturnType<typeof getter>;

    beforeAll(async () => {
      const booted = await boot(BuggyCrossModuleModule);
      app = booted.app;
      get = getter(booted.baseUrl);
    });
    afterAll(async () => {
      await app?.close();
    });

    it('403s a VALID ADMIN on @AdminOnly (RolesGuard runs before auth, req.user undefined)', async () => {
      // This is the production bug: RBAC denies everyone, including ADMIN.
      expect(await get('/rbac-test/admin', tokenFor('ADMIN'))).toBe(403);
    });
  });

  describe('FIXED wiring (both guards co-located in the imported module)', () => {
    let app: INestApplication;
    let get: ReturnType<typeof getter>;

    beforeAll(async () => {
      const booted = await boot(FixedCrossModuleModule);
      app = booted.app;
      get = getter(booted.baseUrl);
    });
    afterAll(async () => {
      await app?.close();
    });

    it('allows (200) a VALID ADMIN on @AdminOnly (Jwt runs first → req.user set)', async () => {
      expect(await get('/rbac-test/admin', tokenFor('ADMIN'))).toBe(200);
    });
    it('forbids (403) a USER on @AdminOnly', async () => {
      expect(await get('/rbac-test/admin', tokenFor('USER'))).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. REAL cross-module wiring — REGRESSION GATE.
//    Imports the production AuthModule (which, after the fix, registers BOTH
//    APP_GUARDs: JwtAuthGuard then RolesGuard) into a root module that plays
//    AppModule's role. Mirrors production exactly.
//
//    PRE-FIX behaviour: AuthModule provides only JwtAuthGuard → no RolesGuard
//    anywhere → @AdminOnly is UNENFORCED → a USER reaches the admin route (200)
//    and the USER→403 assertion FAILS. (And in real production, RolesGuard
//    living in the scanned-first root meant ADMIN→403 — see mechanics above.)
//    POST-FIX: AuthModule owns both guards in the right order → ADMIN→200,
//    USER→403, no-token→401, public→200. All pass.
// ---------------------------------------------------------------------------
@Module({
  imports: [
    // Mirror AppModule's globally-scoped infrastructure so the REAL AuthModule
    // (and the PrismaService it transitively pulls in) resolves: CLS store,
    // TenantContextService, then the production AuthModule that owns the global
    // guards.
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    // TDA-004 Task 6 centralised the throttler into AppModule (global). The
    // real AuthModule's @UseGuards(ThrottlerGuard) now resolves its options from
    // that global module instead of a local one, so mirror it here (high limit
    // so it never interferes with the RBAC assertions below).
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 100_000 }],
    }),
    TenantModule,
    AuthModule,
  ],
  controllers: [RbacTestController],
})
class ProductionLikeRootModule {}

describe('TDA-003 Task 3 — RolesGuard via REAL AuthModule (cross-module regression)', () => {
  let app: INestApplication;
  let get: ReturnType<typeof getter>;

  beforeAll(async () => {
    const booted = await boot(ProductionLikeRootModule);
    app = booted.app;
    get = getter(booted.baseUrl);
  });

  afterAll(async () => {
    await app?.close();
  });

  // The critical regression assertion: under realistic cross-module wiring a
  // valid ADMIN must reach the @AdminOnly route. The guard-ordering bug made
  // this 403 for EVERYONE in production.
  it('allows (200) a valid ADMIN on the @AdminOnly route', async () => {
    expect(await get('/rbac-test/admin', tokenFor('ADMIN'))).toBe(200);
  });

  it('forbids (403) a USER on the @AdminOnly route', async () => {
    expect(await get('/rbac-test/admin', tokenFor('USER'))).toBe(403);
  });

  it('allows (200) a USER on a plain authenticated route', async () => {
    expect(await get('/rbac-test/plain', tokenFor('USER'))).toBe(200);
  });

  it('is unauthorized (401) with no token on the @AdminOnly route', async () => {
    expect(await get('/rbac-test/admin')).toBe(401);
  });

  it('allows (200) the @Public route with no token', async () => {
    expect(await get('/rbac-test/public')).toBe(200);
  });
});
