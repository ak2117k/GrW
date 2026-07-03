// MUST be the first import: loads the repo-root .env (JWT_SECRET, DATABASE_URL)
// into process.env before any other module is evaluated. See load-env.ts.
import './load-env';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters';
import { LoggingInterceptor } from './common/interceptors';
import { isBenignWsHeartbeatError } from './common/utils/ws-heartbeat-error';
import { EnforceHttpsMiddleware } from './common/http/enforce-https.middleware';
import { validateBootConfig } from './common/config/validate-boot-config';

/**
 * Transport-layer hardening (TDA-004), exported so tests exercise the real code.
 *
 * - helmet: HSTS, X-Content-Type-Options nosniff, frameguard (X-Frame-Options),
 *   and hides X-Powered-By. CSP is disabled because the only HTML this API
 *   serves is Swagger UI at /api/docs, whose inline scripts/styles helmet's
 *   default CSP blocks; every other route is JSON, for which CSP adds nothing.
 * - trust proxy: behind the ALB so req.protocol / x-forwarded-proto are honored.
 * - CORS: FAIL-CLOSED in production — only the configured WEB_ORIGIN allowlist
 *   (and no-origin requests: curl / same-origin / mobile) pass; unknown origins
 *   get no Access-Control-Allow-Origin. In dev, fall back to localhost origins.
 * - EnforceHttpsMiddleware: prod-only 426 for plaintext requests.
 */
export function applyHttpHardening(app: INestApplication, env: NodeJS.ProcessEnv = process.env): void {
  app.use(helmet({ contentSecurityPolicy: false })); // HSTS, nosniff, frameguard, hide x-powered-by
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  const isProd = env.NODE_ENV === 'production';
  const allowlist = (env.WEB_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean))
    ?? (isProd ? [] : ['http://localhost:4000', 'http://127.0.0.1:4000']);
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl / mobile
      if (allowlist.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed: ${origin}`), false);
    },
    credentials: true,
  });
  app.use(new EnforceHttpsMiddleware().use);
}

/**
 * Safety net for the smartapi-javascript WebSocket heartbeat bug: its internal
 * timer calls `ws.send()` without checking readyState, so during the daily
 * reconnect (socket CONNECTING/CLOSING/CLOSED) the throw escapes and kills the
 * whole process — taking the API and every chart/feed down until a manual
 * restart. Swallow ONLY that "WebSocket is not open" class, via BOTH
 * uncaughtException and unhandledRejection; everything else crashes loudly so
 * real bugs stay visible. (The previous guard matched only readyState 0 + a
 * stack string, so the reconnect-time readyState 2/3 throws slipped through.)
 */
process.on('uncaughtException', (err: Error) => {
  if (isBenignWsHeartbeatError(err)) {
    // eslint-disable-next-line no-console
    console.warn('[uncaughtException] smartapi WS heartbeat on non-open socket — swallowed:', err?.message);
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', err);
  throw err;
});

process.on('unhandledRejection', (reason: unknown) => {
  if (isBenignWsHeartbeatError(reason)) {
    // eslint-disable-next-line no-console
    console.warn('[unhandledRejection] smartapi WS heartbeat on non-open socket — swallowed:', (reason as Error)?.message ?? reason);
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
});

async function bootstrap(): Promise<void> {
  // Fail closed BEFORE creating the app: refuse to start on invalid config.
  validateBootConfig();

  const logger = new Logger('Bootstrap');
  // rawBody:true (Nest built-in) buffers the exact request bytes onto
  // req.rawBody so the Razorpay webhook (TDA-015) can HMAC-verify the raw
  // payload. Additive: normal parsed-body routes are unaffected.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3001);

  // Transport hardening: helmet + fail-closed CORS + trust proxy + HTTPS enforcement.
  applyHttpHardening(app);

  // WebSocket adapter (Socket.IO)
  app.useWebSocketAdapter(new IoAdapter(app));

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global logging interceptor
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Swagger API docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('GrW API')
    .setDescription('Trading automation platform API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(port);
  logger.log(`GrW API running on http://localhost:${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/api/docs`);
}

// Only boot when run as the entry point. Importing this module (e.g. tests
// exercising the exported applyHttpHardening) must NOT spin up the real server.
if (require.main === module) {
  bootstrap();
}
