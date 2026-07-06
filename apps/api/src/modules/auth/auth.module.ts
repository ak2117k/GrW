import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountRateLimitGuard } from '../../common/ratelimit/account-rate-limit.guard';
import { MemoryRateLimitStore } from '../../common/ratelimit/memory-rate-limit.store';
import {
  RATE_LIMIT_STORE,
  RateLimitStore,
} from '../../common/ratelimit/rate-limit-store.interface';
import { RedisRateLimitStore } from '../../common/ratelimit/redis-rate-limit.store';
import { redisThrottlerEnabled } from '../../common/ratelimit/redis.provider';
import { AuthController } from './controllers/auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuthService } from './services/auth.service';
import { EmailService } from './services/email/email.service';
import { MfaService } from './services/mfa.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Authentication module (TDA-002).
 *
 * Wires the auth core endpoints, the Passport JWT strategy, and registers the
 * GLOBAL `APP_GUARD`s — {@link JwtAuthGuard} then {@link RolesGuard}, in that
 * order — so every route is authenticated (opt out via `@Public()`) and then
 * role-authorised (`@Roles`/`@AdminOnly`). Both guards live HERE (not split
 * across modules) so APP_GUARD array order, not module-scan order, governs.
 *
 * `TokenService` is built via a factory because its constructor takes a raw
 * `PrismaClient` + `JwtService` (so it stays directly instantiable in tests);
 * `PrismaService` extends `PrismaClient` and satisfies that dependency.
 */
@Module({
  imports: [
    PrismaModule,
    // AuditModule is @Global, but a @Global module's exports only propagate once
    // it has been imported into the graph. AppModule imports it for the running
    // app; importing it here too lets AuthService/MfaService inject AuditService
    // when AuthModule is booted in isolation (tests). Idempotent (@Global).
    AuditModule,
    PassportModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
    // Brute-force defence for the sensitive auth routes (spec §7) is now served
    // by the CENTRAL global ThrottlerModule registered in app.module.ts
    // (TDA-004 Task 6). The auth controller's `@Throttle({ default: ... })`
    // decorators bind to that central 'default' throttler; the local
    // `ThrottlerModule.forRoot([...])` that used to live here was removed to
    // avoid a second, conflicting throttler registration.
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    MfaService,
    JwtStrategy,
    // EmailService's constructor takes an OPTIONAL transport (an interface with
    // no DI token), so build it via a factory to let it self-select by env.
    { provide: EmailService, useFactory: () => new EmailService() },
    {
      provide: TokenService,
      useFactory: (prisma: PrismaService, jwt: JwtService) =>
        new TokenService(prisma, jwt),
      inject: [PrismaService, JwtService],
    },
    // TDA-004 Task 7 — per-account rate limiting on login / password-forgot.
    // This is the seam Task 6 left open (its store providers were "registered
    // nowhere"): bind RATE_LIMIT_STORE HERE so the AccountRateLimitGuard
    // (referenced per-handler via @UseGuards) can inject it. The factory selects
    // Task 6's stores — RedisRateLimitStore (cross-replica counters) when
    // REDIS_THROTTLER==='true', else the in-process MemoryRateLimitStore for
    // dev/test/CI. It reads the redis.* connection straight from process.env
    // (same vars/defaults as configuration.ts) so AuthModule needs no extra
    // ConfigService/global-infra dependency in focused test harnesses.
    {
      provide: RATE_LIMIT_STORE,
      useFactory: (): RateLimitStore => {
        if (!redisThrottlerEnabled()) return new MemoryRateLimitStore();
        // Lazy require keeps ioredis out of the dev/test path entirely.
        const Redis = require('ioredis');
        return new RedisRateLimitStore(
          new Redis({
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined,
            // TLS-only managed Redis (Upstash/ElastiCache). undefined => plain TCP.
            tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
          }),
        );
      },
    },
    AccountRateLimitGuard,
    // Global guards, co-located here so APP_GUARD array order is authoritative:
    // JwtAuthGuard authenticates FIRST (→ req.user / 401), then RolesGuard
    // authorises by role (@Roles/@AdminOnly → 403). They MUST live in the same
    // module — NestJS runs global enhancers in module-scan order, and the root
    // AppModule is scanned before this imported module, so splitting them across
    // modules inverts the order and breaks RBAC (see app.module.ts note).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, TokenService, PasswordService, MfaService],
})
export class AuthModule {}
