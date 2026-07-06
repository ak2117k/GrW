import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import configuration from './config/configuration';
import { PrismaModule } from './common/prisma/prisma.module';
import { SecretsModule } from './common/secrets/secrets.module';
import { KmsModule } from './common/crypto/kms/kms.module';
import { TenantModule } from './common/tenant/tenant.module';
import { TenantContextInterceptor } from './common/tenant/tenant-context.interceptor';
import { AuditModule } from './common/audit/audit.module';
import { ConsentModule } from './modules/consent/consent.module';
import { AuthModule } from './modules/auth/auth.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { SignalGeneratorModule } from './modules/signal-generator/signal-generator.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { TradeEngineModule } from './modules/trade-engine/trade-engine.module';
import { NewsModule } from './modules/news/news.module';
import { BacktestModule } from './modules/backtest/backtest.module';
import { OptionsChainModule } from './modules/options-chain/options-chain.module';
import { AIAdvisorModule } from './modules/ai-advisor/ai-advisor.module';
import { AutoTradeModule } from './modules/auto-trade/auto-trade.module';
import { InsightsModule } from './modules/insights/insights.module';
import { CredentialVaultModule } from './modules/credential-vault/credential-vault.module';
import { ChartinkModule } from './modules/chartink/chartink.module';
import { FundamentalsModule } from './modules/fundamentals/fundamentals.module';
import { WatchMonitorModule } from './modules/watch-monitor/watch-monitor.module';
import { StrategyReviewModule } from './modules/strategy-review/strategy-review.module';
import { UngatedTrackModule } from './modules/ungated-track/ungated-track.module';
import { AdaptiveStopTrackModule } from './modules/adaptive-stop-track/adaptive-stop-track.module';
import { AnandDualTrackModule } from './modules/anand-dual-track/anand-dual-track.module';
import { BreakoutSwingTrackModule } from './modules/breakout-swing-track/breakout-swing-track.module';
import { SellFuturesModule } from './modules/sell-futures-track/sell-futures.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { BillingModule } from './modules/billing/billing.module';
import { SignalFanoutModule } from './modules/signal-fanout/signal-fanout.module';
import { AutoExecutionModule } from './modules/auto-execution/auto-execution.module';

@Module({
  imports: [
    // Global configuration from .env
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Bull queue with Redis backend
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
          password: config.get<string>('redis.password') || undefined,
          // TLS-only managed Redis (Upstash/ElastiCache). undefined => plain TCP.
          tls: config.get<Record<string, never> | undefined>('redis.tls'),
          // Force IPv4 to avoid AAAA-lookup ENOTFOUND on container networks.
          family: config.get<number>('redis.family'),
        },
      }),
    }),

    // Cron / interval scheduling
    ScheduleModule.forRoot(),

    // Central global rate limiter (TDA-004 Task 6). ONE app-wide throttler
    // ('default'), config-driven from rateLimit.* (GLOBAL_RATE_TTL/LIMIT). The
    // local ThrottlerModule that AuthModule used to register was removed; the
    // auth controller's @Throttle({ default: ... }) decorators now bind to this
    // central throttler. Storage is left DEFAULT (in-memory): the gated
    // Redis-backed ThrottlerStorage is deferred to prod wiring (see
    // common/ratelimit/redis.provider.ts).
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

    // Request-scoped CLS store (TDA-003). Mounted as middleware so the store
    // exists BEFORE guards run, letting the TenantContextInterceptor populate it
    // from req.user after JwtAuthGuard authenticates the request.
    // `global: true` so ClsService is injectable outside AppModule — notably in
    // the @Global TenantModule's TenantContextService (without it the app fails to
    // boot with "ClsService not available in TenantModule").
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),

    // Shared tenant context (TDA-003) — provides/exports TenantContextService
    // for PrismaService and others to inject.
    TenantModule,

    // Database
    PrismaModule,

    // Secrets + KMS provider abstractions (TDA-004 Tasks 1 & 3). Both @Global,
    // selected by config (SECRETS_PROVIDER / KMS_PROVIDER, 'local' default).
    // The 'aws' adapters are dynamic-import skeletons, never constructed unless
    // explicitly selected, so the dev/test build never needs @aws-sdk/*.
    SecretsModule,
    KmsModule,
    // Tamper-evident audit log (TDA-008) — @Global; exposes the ADMIN-only
    // read/verify/export surface at /api/admin/audit.
    AuditModule,

    // Versioned consent & disclaimer gate (TDA-009) — @Global; exposes
    // /api/consent/* + /api/admin/consent/publish and the ConsentGuard /
    // hasAcceptedCurrent seam that TDA-011 consumes.
    ConsentModule,

    // Authentication — signup/verify/login/refresh/logout + global JwtAuthGuard
    AuthModule,

    // Market data — live feeds, candles, OI, instruments
    MarketDataModule,

    // Settings & Alerts
    SettingsModule,
    AlertsModule,

    // Signal generation — strategy scanning, scoring, WebSocket broadcast
    SignalGeneratorModule,

    // Portfolio tracking & performance analytics
    PortfolioModule,

    // Trade engine — order execution, position tracking, risk management
    TradeEngineModule,

    // News aggregation with AI sentiment analysis
    NewsModule,

    // Backtesting — strategy backtest engine
    BacktestModule,

    // Options chain — live Greeks, IV, OI analysis
    OptionsChainModule,

    // AI-powered trading advisor — insights, chat, weekly reports
    AIAdvisorModule,

    // AI Insights — section-level Claude analysis via MCP
    InsightsModule,

    // Auto-trade — signal-to-trade automation with approval workflow
    AutoTradeModule,

    // Per-tenant credential vault (TDA-005) — envelope-encrypted broker creds,
    // validated Connect Angel One flow, isolated decrypt-for-execution seam.
    CredentialVaultModule,

    // Chartink — webhook-driven scanner alerts feeding the setup pipeline
    ChartinkModule,

    // Fundamentals — Yahoo Finance-sourced stock fundamentals (24h cache)
    FundamentalsModule,

    // Watch Monitor — Stage 2 trade watch lifecycle, scoring, options selection
    WatchMonitorModule,

    // Strategy Review — read-only analytics over stored trading history
    StrategyReviewModule,

    // Ungated Track — shadow paper-trade pipeline for unfiltered signals
    UngatedTrackModule,

    // Adaptive-Stop Track — shadow track with vol-stop / risk-first sizing
    AdaptiveStopTrackModule,

    // Anand Dual-Track — intraday (5%) and swing (10%) analysis logs
    AnandDualTrackModule,

    // Breakout-Swing Track — breakout variant of the Anand swing track
    BreakoutSwingTrackModule,

    // SELL-Futures Track — shorts the stock future on bearish signals (paper)
    SellFuturesModule,

    // Subscription — TDA-007 plan-gating (Intraday/Swing) + me/admin endpoints
    SubscriptionModule,

    // Billing / payments — TDA-015 Razorpay checkout + idempotent webhook that
    // drives SubscriptionService grant/revoke (payment state = access).
    BillingModule,

    // Signal fan-out engine (TDA-010) — one central signal → one sanitized
    // fan-out job → one independent execute-user job per eligible user, with
    // per-user rate isolation, retry/backoff, and a DLQ. TDA-011 fills the
    // per-user execution pipeline behind the AUTO_EXECUTION_PORT seam.
    SignalFanoutModule,
    AutoExecutionModule,
  ],
  providers: [
    // Global tenant-context interceptor (TDA-003 §3). Runs after JwtAuthGuard,
    // so req.user is available; copies { userId, role } into the CLS store.
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },

    // Central global rate limiter (TDA-004 Task 6). Declared in the root module
    // so — by NestJS module-scan order — it runs BEFORE JwtAuthGuard (declared
    // in the imported AuthModule): unauthenticated floods are rejected (429)
    // before hitting auth. Replaces AuthModule's old per-handler throttler.
    { provide: APP_GUARD, useClass: ThrottlerGuard },

    // NOTE: the global RBAC guard (RolesGuard) is intentionally NOT registered
    // here. NestJS executes global enhancers in MODULE-SCAN order, and the root
    // AppModule is scanned BEFORE its imported AuthModule — so a RolesGuard
    // APP_GUARD declared here would run BEFORE JwtAuthGuard (declared in
    // AuthModule) and read req.user before authentication populates it,
    // 403-ing every @Roles/@AdminOnly route (including valid ADMINs). RolesGuard
    // is therefore co-located with JwtAuthGuard in AuthModule, immediately after
    // it, so array order guarantees Jwt-then-Roles. See auth.module.ts.
  ],
})
export class AppModule {}
