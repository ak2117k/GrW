// MUST be the first import: loads the repo-root .env (JWT_SECRET, DATABASE_URL)
// into process.env before any other module is evaluated. See load-env.ts.
import './load-env';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters';
import { LoggingInterceptor } from './common/interceptors';
import { isBenignWsHeartbeatError } from './common/utils/ws-heartbeat-error';

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
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3001);

  // CORS
  // Web app runs on :4000 (not :3000 — that's the stale port from CLAUDE.md).
  // Accept both 127.0.0.1 and localhost forms since browsers treat them as
  // distinct origins. Honor WEB_ORIGIN env override for non-dev environments.
  app.enableCors({
    origin: process.env.WEB_ORIGIN
      ? process.env.WEB_ORIGIN.split(',').map((s) => s.trim())
      : ['http://localhost:4000', 'http://127.0.0.1:4000'],
    credentials: true,
  });

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
    .setTitle('TD Automation API')
    .setDescription('Trading automation platform API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(port);
  logger.log(`TD Automation API running on http://localhost:${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/api/docs`);
}

bootstrap();
