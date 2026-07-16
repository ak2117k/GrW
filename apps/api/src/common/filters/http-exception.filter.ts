import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { redactSecretPath, redactSecretsInText } from '../utils/redact-secret-path';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Redacted because an exception's own message can embed the request URL, and
    // for an unmatched route Nest writes that message itself: `Cannot POST
    // /webhooks/ml/backfill/<secret>`. Redacting request.url below does nothing
    // for this copy — it is not request.url, it just contains the same string.
    const message = redactSecretsInText(
      exception instanceof HttpException ? exception.message : 'Internal server error',
    );

    // Deliberately no `path`. Reflecting request.url echoed whatever the caller
    // sent straight back at them — for a failed webhook that meant returning the
    // attempted secret in the error body. The caller already knows their own URL.
    const errorResponse = {
      statusCode,
      message,
      timestamp: new Date().toISOString(),
    };

    this.logger.error(
      `${request.method} ${redactSecretPath(request.url)} ${statusCode} - ${message}`,
      // The stack carries the message inside it, so it needs the same treatment —
      // a redacted log line above a leaking stack trace would be theatre.
      exception instanceof Error ? redactSecretsInText(exception.stack ?? '') : undefined,
    );

    response.status(statusCode).json(errorResponse);
  }
}
