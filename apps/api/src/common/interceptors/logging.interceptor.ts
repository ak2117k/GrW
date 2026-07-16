import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import { redactSecretPath } from '../utils/redact-secret-path';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    // Webhook secrets used to ride in the path, so this line logged them on every
    // successful call. Redacted here rather than at the call sites because this
    // interceptor is global — it cannot know which route it is logging.
    const safeUrl = redactSecretPath(url);
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        this.logger.log(`${method} ${safeUrl} - ${duration}ms`);
      }),
    );
  }
}
