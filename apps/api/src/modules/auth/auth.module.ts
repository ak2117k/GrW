import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
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
    // Brute-force defence for the sensitive auth routes (spec §7). The default
    // (named) throttler: 10 requests / 60s window, applied per-handler via
    // `@UseGuards(ThrottlerGuard)` + `@Throttle` on the controller — NOT as a
    // global guard — so the global `JwtAuthGuard` keeps governing every other
    // route untouched.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
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
