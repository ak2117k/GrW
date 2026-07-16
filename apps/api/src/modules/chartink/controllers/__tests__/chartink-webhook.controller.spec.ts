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
   * The secret is in the PATH, deliberately — for now.
   *
   * The header is the right end state (see MlTriggerController), and this was
   * briefly migrated there. It got reverted: the URL lives in Chartink's alert
   * config, a third party that must be reconfigured BY HAND, so deploying the
   * code first 404'd every live alert and silently dropped real trading signals
   * mid-session. The lesson is ordering, not direction — cut the SENDER over
   * first, confirm it arrives, then drop the path param.
   *
   * This test pins the URL shape so the route can't be changed out from under
   * Chartink again without someone deleting this comment and thinking about it.
   * Our own logs are protected meanwhile by redactSecretPath/redactSecretsInText.
   */
  it('keeps the :secret path param — Chartink is configured with the URL', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ChartinkWebhookController.prototype.receive)).toBe(
      ':secret',
    );
    expect(Reflect.getMetadata(PATH_METADATA, ChartinkWebhookController)).toBe(
      'webhooks/chartink',
    );
  });

  it.each([
    ['a missing secret', undefined],
    ['a null secret', null],
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
