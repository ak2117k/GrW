import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ChartinkWebhookController } from '../chartink-webhook.controller';
import { ChartinkIngestService } from '../../services/chartink-ingest.service';

describe('ChartinkWebhookController', () => {
  let controller: ChartinkWebhookController;
  let ingest: { ingest: jest.Mock };
  const SECRET = 'k7Hn3Fp9q2X-correct-horse-battery-staple-32chars';

  beforeEach(async () => {
    ingest = { ingest: jest.fn().mockResolvedValue({ alertId: 'a1', hitCount: 3 }) };

    const moduleRef = await Test.createTestingModule({
      controllers: [ChartinkWebhookController],
      providers: [
        { provide: ChartinkIngestService, useValue: ingest },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'CHARTINK_WEBHOOK_SECRET' ? SECRET : null) },
        },
      ],
    }).compile();

    controller = moduleRef.get(ChartinkWebhookController);
  });

  const validBody = {
    stocks: 'RELIANCE',
    trigger_prices: '1467.4',
    triggered_at: '2:34 pm',
    scan_name: 'Test',
    scan_url: 'test-scan',
    alert_name: 'Alert',
    webhook_url: 'http://x',
  };

  it('returns 200 + ack when secret matches', async () => {
    const result = await controller.receive(SECRET, validBody);
    expect(result).toEqual({ received: true, alertId: 'a1', hitCount: 3 });
    expect(ingest.ingest).toHaveBeenCalledWith(validBody);
  });

  it('throws UnauthorizedException when secret is wrong', async () => {
    await expect(controller.receive('wrong-secret', validBody)).rejects.toThrow(UnauthorizedException);
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when secret is empty', async () => {
    await expect(controller.receive('', validBody)).rejects.toThrow(UnauthorizedException);
  });

  /**
   * The secret travels in a HEADER, never the URL. A path secret is logged
   * verbatim by everything that records request paths — the global
   * LoggingInterceptor on success, the HttpExceptionFilter on every 401, and the
   * hosting platform's access logs, which are outside this process entirely.
   * Since those logs ship to a third party and this secret IS the auth boundary
   * for a @Public() route, the URL is the one place it must not go.
   *
   * Asserted on route metadata because no functional test can defend a route's
   * shape: re-add `:secret` and every other test here still passes.
   */
  it('exposes a static route with no path param — the secret must not be in the URL', () => {
    const path = Reflect.getMetadata(PATH_METADATA, ChartinkWebhookController.prototype.receive);
    expect(path).not.toContain(':');
    expect(Reflect.getMetadata(PATH_METADATA, ChartinkWebhookController)).toBe(
      'webhooks/chartink',
    );
  });

  // A header, unlike the path param this replaced, can be absent entirely.
  // Must 401 rather than blow up reading `.length` off undefined (a 500 + stack).
  it.each([
    ['a missing header', undefined],
    ['a null header', null],
  ])('throws UnauthorizedException for %s rather than a 500', async (_label, provided) => {
    await expect(controller.receive(provided as never, validBody)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when env secret is missing', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChartinkWebhookController],
      providers: [
        { provide: ChartinkIngestService, useValue: ingest },
        { provide: ConfigService, useValue: { get: () => null } },
      ],
    }).compile();
    const c2 = moduleRef.get(ChartinkWebhookController);
    await expect(c2.receive('anything', validBody)).rejects.toThrow(UnauthorizedException);
  });
});
