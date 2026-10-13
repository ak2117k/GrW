import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ClientReportController } from './health.controller';
import { HealthDetailService } from './health-detail.service';

/**
 * The web client posts its stall report through the shared axios instance,
 * whose baseURL is '/api' — i.e. `POST /api/healthz/client-report`. The route
 * lived on `@Controller('healthz')`, OUTSIDE the /api prefix every other
 * controller spells out, so production answered 404 and no stall report was
 * ever recorded. (The Cloudflare worker only proxies /api/*, /auth/* and
 * /socket.io/*, so moving the web call to a bare /healthz path would not reach
 * the API either — the route itself must live under /api.)
 */
describe('POST /api/healthz/client-report', () => {
  let app: INestApplication;
  const record = jest.fn().mockResolvedValue({ accepted: true });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ClientReportController],
      providers: [{ provide: HealthDetailService, useValue: { recordClientReport: record } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  const post = async (path: string) => {
    const base = await app.getUrl();
    return fetch(`${base.replace('[::1]', '127.0.0.1')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ health: 'stale', tickSocketUp: true, subscribedTokens: 3, namespaces: { '/ws': true } }),
    });
  };

  it('is served at the path the web client calls (axios baseURL /api + /healthz/client-report)', async () => {
    const res = await post('/api/healthz/client-report');
    expect(res.status).toBe(202);
    expect(record).toHaveBeenCalledWith(null, expect.objectContaining({ health: 'stale', subscribedTokens: 3 }));
  });
});
