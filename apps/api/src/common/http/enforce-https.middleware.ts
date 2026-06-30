import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/** Prod-only: behind an ALB/proxy, reject plaintext requests (x-forwarded-proto !== https). */
@Injectable()
export class EnforceHttpsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
      res.status(426).json({ statusCode: 426, message: 'HTTPS required' });
      return;
    }
    next();
  }
}
