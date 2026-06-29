import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
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
