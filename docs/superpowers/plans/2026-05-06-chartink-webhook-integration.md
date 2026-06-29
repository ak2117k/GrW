# Chartink Webhook Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive Chartink scanner webhook alerts, queue them, and run each candidate symbol through `SignalGeneratorService.analyze()` so Chartink-sourced setups appear on the existing /signals page (badged with the originating scanner) plus a new dedicated /chartink page exposes scanner state, alert history, and per-symbol decisions.

**Architecture:** Webhook controller authenticates via URL-embedded secret, persists raw alert + enqueues a Bull job, returns 200 in <100ms. A dedicated worker consumes the queue, resolves each symbol to a token, runs `analyze()`, and persists the per-symbol decision. Three new Prisma tables (ChartinkScanner / ChartinkAlert / ChartinkAlertSetup), no changes to existing models. Frontend gets one new page + a small badge on `SignalCard`.

**Tech Stack:** TypeScript, NestJS, class-validator, Bull (Redis-backed), Prisma, Jest (backend), React + TailwindCSS (frontend).

**Spec:** `docs/superpowers/specs/2026-05-06-chartink-webhook-integration-design.md`

---

## File Structure

| File | Responsibility | Modify or Create |
|---|---|---|
| `prisma/schema.prisma` | Add `ChartinkScanner` / `ChartinkAlert` / `ChartinkAlertSetup` models | Modify |
| `prisma/migrations/<ts>_add_chartink_tables/migration.sql` | The generated migration | Create (via `prisma migrate dev`) |
| `apps/api/src/modules/chartink/chartink.module.ts` | Wire controllers / services / worker / repo + register `chartink-process` Bull queue | Create |
| `apps/api/src/modules/chartink/dto/chartink-webhook.dto.ts` | Validate the inbound webhook body | Create |
| `apps/api/src/modules/chartink/repositories/chartink.repository.ts` | Prisma access for the three new tables | Create |
| `apps/api/src/modules/chartink/services/chartink-ingest.service.ts` | Parse payload, upsert scanner, insert alert, enqueue job | Create |
| `apps/api/src/modules/chartink/services/chartink-process.service.ts` | Per-symbol pipeline: resolve → analyze → persist | Create |
| `apps/api/src/modules/chartink/workers/chartink-process.worker.ts` | Bull consumer wrapper around `ChartinkProcessService` | Create |
| `apps/api/src/modules/chartink/controllers/chartink-webhook.controller.ts` | `POST /webhooks/chartink/:secret` | Create |
| `apps/api/src/modules/chartink/controllers/chartink.controller.ts` | `GET /api/chartink/scanners` + `/alerts` + `/alerts/:id` | Create |
| `apps/api/src/modules/chartink/services/__tests__/*.spec.ts` | Unit tests | Create |
| `apps/api/src/app.module.ts` | Add `ChartinkModule` to imports | Modify |
| `apps/api/src/modules/signal-generator/services/signal-generator.service.ts` | Surface `chartinkSource` on signal listings (small backend touch) | Modify |
| `apps/web/src/types/index.ts` | Mirror `ChartinkScanner` / `ChartinkAlert` / `ChartinkAlertSetup` types + extend signal type with optional `chartinkSource` | Modify |
| `apps/web/src/services/chartink.ts` | Frontend API client | Create |
| `apps/web/src/pages/chartink/ChartinkPage.tsx` | Scanner list + alert history + alert detail panel | Create |
| `apps/web/src/components/layout/Sidebar.tsx` | Add `/chartink` nav entry | Modify |
| `apps/web/src/App.tsx` (or routes file) | Register the `/chartink` route | Modify |
| `apps/web/src/components/trading/SignalCard.tsx` | Render the `📊 Chartink: {scannerName}` badge when present | Modify |

---

## Task 1 — Prisma schema + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_chartink_tables/migration.sql` (generated)

- [ ] **Step 1: Append the three models to `prisma/schema.prisma`**

Add this block at the end of the file:

```prisma
// ============================================
// Chartink — webhook-driven scanner alerts
// ============================================

model ChartinkScanner {
  id           String           @id @default(cuid())
  scanUrl      String           @unique  // slug from Chartink, the natural key
  scanName     String
  alertName    String?
  firstSeenAt  DateTime         @default(now())
  lastFiredAt  DateTime?
  fireCount    Int              @default(0)
  alerts       ChartinkAlert[]
  @@map("chartink_scanners")
}

model ChartinkAlert {
  id           String                 @id @default(cuid())
  scannerId    String
  scanner      ChartinkScanner        @relation(fields: [scannerId], references: [id])
  triggeredAt  DateTime               // derived: today's IST date + clock string from payload
  receivedAt   DateTime               @default(now())
  rawPayload   Json                   // verbatim Chartink body — debugging
  setups       ChartinkAlertSetup[]
  @@index([scannerId, triggeredAt])
  @@map("chartink_alerts")
}

model ChartinkAlertSetup {
  id            String         @id @default(cuid())
  alertId       String
  alert         ChartinkAlert  @relation(fields: [alertId], references: [id])
  symbol        String
  token         String?
  hitPrice      Float
  kind          String          // 'setup' | 'no-setup' | 'unresolved' | 'error'
  setupId       String?         // loose ref to existing Setup model when kind='setup'
  rejectReason  String?
  processedAt   DateTime        @default(now())
  @@index([alertId])
  @@index([token])
  @@map("chartink_alert_setups")
}
```

- [ ] **Step 2: Generate the migration**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation" && npx prisma migrate dev --name add_chartink_tables --schema=prisma/schema.prisma`
Expected: a new directory `prisma/migrations/<timestamp>_add_chartink_tables/` with a `migration.sql` containing `CREATE TABLE chartink_scanners`, `chartink_alerts`, `chartink_alert_setups`. Prisma re-runs `prisma generate` automatically.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add prisma/schema.prisma prisma/migrations/ && git commit -m "feat(chartink): add ChartinkScanner / ChartinkAlert / ChartinkAlertSetup tables

Three new tables backing the Chartink webhook integration. No changes
to existing models. ChartinkAlertSetup.setupId is intentionally NOT
a Prisma @relation to Setup — keeps the existing setup lifecycle
independent of Chartink history."
```

---

## Task 2 — Backend module scaffold + DTO + repository

**Files:**
- Create: `apps/api/src/modules/chartink/dto/chartink-webhook.dto.ts`
- Create: `apps/api/src/modules/chartink/repositories/chartink.repository.ts`
- Create: `apps/api/src/modules/chartink/chartink.module.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Create the DTO**

```typescript
// apps/api/src/modules/chartink/dto/chartink-webhook.dto.ts
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Verbatim Chartink webhook body. See the official docs:
 *   https://chartink.com/articles/alerts/webhook-support-for-alerts/
 *
 * The two CSV strings (`stocks` and `trigger_prices`) are parallel-indexed.
 * `triggered_at` is a clock-only string ("2:34 pm"); we attach today's IST
 * date in the ingest service.
 */
export class ChartinkWebhookDto {
  @IsString()
  @IsNotEmpty()
  stocks!: string;

  @IsString()
  @IsNotEmpty()
  trigger_prices!: string;

  @IsString()
  @IsNotEmpty()
  triggered_at!: string;

  @IsString()
  @IsNotEmpty()
  scan_name!: string;

  @IsString()
  @IsNotEmpty()
  scan_url!: string;

  @IsString()
  @IsNotEmpty()
  alert_name!: string;

  @IsString()
  webhook_url!: string;
}
```

- [ ] **Step 2: Create the repository**

```typescript
// apps/api/src/modules/chartink/repositories/chartink.repository.ts
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface UpsertScannerInput {
  scanUrl: string;
  scanName: string;
  alertName: string | null;
  firedAt: Date;
}

export interface CreateAlertInput {
  scannerId: string;
  triggeredAt: Date;
  rawPayload: Prisma.InputJsonValue;
}

export interface CreateAlertSetupInput {
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  kind: 'setup' | 'no-setup' | 'unresolved' | 'error';
  setupId: string | null;
  rejectReason: string | null;
}

@Injectable()
export class ChartinkRepository {
  private readonly logger = new Logger(ChartinkRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertScanner(input: UpsertScannerInput): Promise<{ id: string }> {
    const row = await this.prisma.chartinkScanner.upsert({
      where: { scanUrl: input.scanUrl },
      create: {
        scanUrl: input.scanUrl,
        scanName: input.scanName,
        alertName: input.alertName,
        firstSeenAt: input.firedAt,
        lastFiredAt: input.firedAt,
        fireCount: 1,
      },
      update: {
        scanName: input.scanName,
        alertName: input.alertName,
        lastFiredAt: input.firedAt,
        fireCount: { increment: 1 },
      },
      select: { id: true },
    });
    return row;
  }

  async createAlert(input: CreateAlertInput): Promise<{ id: string }> {
    return this.prisma.chartinkAlert.create({
      data: {
        scannerId: input.scannerId,
        triggeredAt: input.triggeredAt,
        rawPayload: input.rawPayload,
      },
      select: { id: true },
    });
  }

  async getAlertWithSetups(alertId: string) {
    return this.prisma.chartinkAlert.findUnique({
      where: { id: alertId },
      include: { setups: true, scanner: true },
    });
  }

  async createAlertSetup(input: CreateAlertSetupInput): Promise<void> {
    await this.prisma.chartinkAlertSetup.create({
      data: input,
    });
  }

  async listScanners() {
    return this.prisma.chartinkScanner.findMany({
      orderBy: { lastFiredAt: 'desc' },
    });
  }

  async listRecentAlerts(limit = 50) {
    return this.prisma.chartinkAlert.findMany({
      orderBy: { receivedAt: 'desc' },
      take: limit,
      include: {
        scanner: { select: { scanName: true, scanUrl: true } },
        setups: { select: { kind: true } },
      },
    });
  }

  async findChartinkSourceForSetup(setupId: string) {
    const row = await this.prisma.chartinkAlertSetup.findFirst({
      where: { setupId },
      include: { alert: { include: { scanner: true } } },
    });
    if (!row) return null;
    return {
      scannerName: row.alert.scanner.scanName,
      scannerUrl: row.alert.scanner.scanUrl,
      alertId: row.alertId,
    };
  }
}
```

- [ ] **Step 3: Create the module skeleton**

```typescript
// apps/api/src/modules/chartink/chartink.module.ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { ChartinkRepository } from './repositories/chartink.repository';
import { ChartinkIngestService } from './services/chartink-ingest.service';
import { ChartinkProcessService } from './services/chartink-process.service';
import { ChartinkProcessWorker } from './workers/chartink-process.worker';
import { ChartinkWebhookController } from './controllers/chartink-webhook.controller';
import { ChartinkController } from './controllers/chartink.controller';

@Module({
  imports: [
    PrismaModule,
    MarketDataModule,        // for marketDataRepository.getInstrumentBySymbol
    SignalGeneratorModule,   // for signalGeneratorService.analyze + setupTracker.getActive
    BullModule.registerQueue({
      name: 'chartink-process',
    }),
  ],
  controllers: [ChartinkWebhookController, ChartinkController],
  providers: [
    ChartinkRepository,
    ChartinkIngestService,
    ChartinkProcessService,
    ChartinkProcessWorker,
  ],
  exports: [ChartinkRepository], // signal-generator joins on this for the badge
})
export class ChartinkModule {}
```

- [ ] **Step 4: Add the module to `app.module.ts`**

In `apps/api/src/app.module.ts`, add the import alongside the existing module imports (after `BrokerModule`):

```typescript
import { ChartinkModule } from './modules/chartink/chartink.module';
```

And in the `imports:` array, append:

```typescript
    // Chartink — webhook-driven scanner alerts feeding the setup pipeline
    ChartinkModule,
```

- [ ] **Step 5: Verify TypeScript compiles**

Note: this step will fail because the services referenced in the module don't exist yet — that's expected and will be resolved by Tasks 3 & 4. Skip the type check until Task 4 completes.

For now, just confirm the imports resolve:
Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "chartink-webhook\.dto|chartink\.repository" || echo "OK so far"`
Expected: `OK so far` (no errors specific to the DTO + repo we just wrote).

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/chartink/ apps/api/src/app.module.ts && git commit -m "feat(chartink): scaffold module + DTO + repository

Module wiring + the DTO/repository foundation. Services and
controllers land in the next commits; the build will be partially
broken until Tasks 3 + 4 add them."
```

---

## Task 3 — Ingest service + webhook controller

**Files:**
- Create: `apps/api/src/modules/chartink/services/chartink-ingest.service.ts`
- Create: `apps/api/src/modules/chartink/services/__tests__/chartink-ingest.service.spec.ts`
- Create: `apps/api/src/modules/chartink/controllers/chartink-webhook.controller.ts`
- Create: `apps/api/src/modules/chartink/controllers/__tests__/chartink-webhook.controller.spec.ts`

- [ ] **Step 1: Write the failing tests for the ingest service**

```typescript
// apps/api/src/modules/chartink/services/__tests__/chartink-ingest.service.spec.ts
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { ChartinkIngestService } from '../chartink-ingest.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { ChartinkWebhookDto } from '../../dto/chartink-webhook.dto';

describe('ChartinkIngestService', () => {
  let service: ChartinkIngestService;
  let repo: { upsertScanner: jest.Mock; createAlert: jest.Mock };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    repo = {
      upsertScanner: jest.fn().mockResolvedValue({ id: 'scanner-1' }),
      createAlert: jest.fn().mockResolvedValue({ id: 'alert-1' }),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChartinkIngestService,
        { provide: ChartinkRepository, useValue: repo },
        { provide: getQueueToken('chartink-process'), useValue: queue },
      ],
    }).compile();

    service = moduleRef.get(ChartinkIngestService);
  });

  function dto(overrides: Partial<ChartinkWebhookDto> = {}): ChartinkWebhookDto {
    return {
      stocks: 'RELIANCE,INFY,TCS',
      trigger_prices: '1467.4,1612.0,3890.5',
      triggered_at: '2:34 pm',
      scan_name: 'Short term breakouts',
      scan_url: 'short-term-breakouts',
      alert_name: 'Alert for Short term breakouts',
      webhook_url: 'http://example/wh',
      ...overrides,
    };
  }

  it('parses stocks + trigger_prices into parallel pairs and enqueues', async () => {
    await service.ingest(dto());
    expect(repo.upsertScanner).toHaveBeenCalledTimes(1);
    expect(repo.createAlert).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const job = queue.add.mock.calls[0][1];
    expect(job).toMatchObject({
      alertId: 'alert-1',
      hits: [
        { symbol: 'RELIANCE', hitPrice: 1467.4 },
        { symbol: 'INFY', hitPrice: 1612.0 },
        { symbol: 'TCS', hitPrice: 3890.5 },
      ],
    });
  });

  it('trims whitespace around CSV entries', async () => {
    await service.ingest(dto({ stocks: ' RELIANCE , INFY ', trigger_prices: ' 1.0 , 2.0 ' }));
    const hits = queue.add.mock.calls[0][1].hits;
    expect(hits).toEqual([
      { symbol: 'RELIANCE', hitPrice: 1.0 },
      { symbol: 'INFY', hitPrice: 2.0 },
    ]);
  });

  it('throws when stocks and trigger_prices have different lengths', async () => {
    await expect(
      service.ingest(dto({ stocks: 'A,B,C', trigger_prices: '1,2' })),
    ).rejects.toThrow(/length mismatch/i);
    expect(repo.upsertScanner).not.toHaveBeenCalled();
  });

  it('derives triggeredAt from today IST + clock string', async () => {
    await service.ingest(dto({ triggered_at: '2:34 pm' }));
    const triggeredAt = repo.createAlert.mock.calls[0][0].triggeredAt as Date;
    // 14:34 IST = 09:04 UTC same calendar date in UTC terms (since IST is UTC+5:30,
    // 14:34 IST is 09:04 UTC; for a date in Apr/May the UTC date matches).
    expect(triggeredAt).toBeInstanceOf(Date);
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(triggeredAt.getTime() + istOffsetMs);
    expect(istDate.getUTCHours()).toBe(14);
    expect(istDate.getUTCMinutes()).toBe(34);
  });
});
```

- [ ] **Step 2: Run the spec to confirm tests fail**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=chartink-ingest.service.spec --no-coverage 2>&1 | tail -30`
Expected: 4 tests fail with `Cannot find module '../chartink-ingest.service'` or similar.

- [ ] **Step 3: Implement the ingest service**

```typescript
// apps/api/src/modules/chartink/services/chartink-ingest.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ChartinkWebhookDto } from '../dto/chartink-webhook.dto';
import { ChartinkRepository } from '../repositories/chartink.repository';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

interface ParsedHit {
  symbol: string;
  hitPrice: number;
}

export interface ChartinkProcessJobData {
  alertId: string;
  hits: ParsedHit[];
}

@Injectable()
export class ChartinkIngestService {
  private readonly logger = new Logger(ChartinkIngestService.name);

  constructor(
    private readonly repo: ChartinkRepository,
    @InjectQueue('chartink-process') private readonly queue: Queue<ChartinkProcessJobData>,
  ) {}

  async ingest(payload: ChartinkWebhookDto): Promise<{ alertId: string; hitCount: number }> {
    const hits = this.parseHits(payload.stocks, payload.trigger_prices);
    const triggeredAt = this.deriveTriggeredAt(payload.triggered_at, new Date());

    const scanner = await this.repo.upsertScanner({
      scanUrl: payload.scan_url,
      scanName: payload.scan_name,
      alertName: payload.alert_name,
      firedAt: triggeredAt,
    });

    const alert = await this.repo.createAlert({
      scannerId: scanner.id,
      triggeredAt,
      rawPayload: payload as unknown as Record<string, unknown>,
    });

    await this.queue.add({ alertId: alert.id, hits });

    this.logger.log(
      `Ingested Chartink alert ${alert.id} (${payload.scan_name}) — ${hits.length} hits`,
    );

    return { alertId: alert.id, hitCount: hits.length };
  }

  private parseHits(stocksCsv: string, pricesCsv: string): ParsedHit[] {
    const stocks = stocksCsv.split(',').map((s) => s.trim()).filter(Boolean);
    const prices = pricesCsv.split(',').map((s) => s.trim()).filter(Boolean);
    if (stocks.length !== prices.length) {
      throw new BadRequestException(
        `Chartink payload length mismatch: ${stocks.length} stocks vs ${prices.length} prices`,
      );
    }
    return stocks.map((symbol, i) => ({
      symbol,
      hitPrice: Number(prices[i]),
    }));
  }

  /**
   * Convert "2:34 pm" + today's IST date into a UTC Date.
   * Chartink doesn't include the date or timezone — we assume today (IST).
   */
  private deriveTriggeredAt(clockStr: string, now: Date): Date {
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);
    const m = clockStr.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
    if (!m) {
      throw new BadRequestException(`Cannot parse Chartink triggered_at: "${clockStr}"`);
    }
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const meridiem = m[3];
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    // Build "today IST date at hh:mm" as a UTC Date by subtracting the IST offset.
    const istMidnightUtc = Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate(),
      0, 0, 0, 0,
    );
    return new Date(istMidnightUtc + hour * 3600_000 + minute * 60_000 - IST_OFFSET_MS);
  }
}
```

- [ ] **Step 4: Run the spec to confirm tests pass**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=chartink-ingest.service.spec --no-coverage 2>&1 | tail -25`
Expected: 4 tests pass.

- [ ] **Step 5: Write the failing tests for the webhook controller**

```typescript
// apps/api/src/modules/chartink/controllers/__tests__/chartink-webhook.controller.spec.ts
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
```

- [ ] **Step 6: Run the spec — confirm it fails**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=chartink-webhook.controller.spec --no-coverage 2>&1 | tail -25`
Expected: 4 tests fail with `Cannot find module '../chartink-webhook.controller'`.

- [ ] **Step 7: Implement the webhook controller**

```typescript
// apps/api/src/modules/chartink/controllers/chartink-webhook.controller.ts
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  UnauthorizedException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { ChartinkIngestService } from '../services/chartink-ingest.service';
import { ChartinkWebhookDto } from '../dto/chartink-webhook.dto';

@Controller('webhooks/chartink')
export class ChartinkWebhookController {
  private readonly logger = new Logger(ChartinkWebhookController.name);

  constructor(
    private readonly ingest: ChartinkIngestService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Receive a Chartink webhook. The `:secret` URL segment authenticates the
   * caller (Chartink itself doesn't sign the payload). Constant-time
   * comparison via crypto.timingSafeEqual prevents the secret being inferred
   * from response-time side channels.
   */
  @Post(':secret')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false }))
  async receive(
    @Param('secret') providedSecret: string,
    @Body() body: ChartinkWebhookDto,
  ): Promise<{ received: true; alertId: string; hitCount: number }> {
    const expected = this.config.get<string>('CHARTINK_WEBHOOK_SECRET');
    if (!expected) {
      this.logger.warn('CHARTINK_WEBHOOK_SECRET is not configured — rejecting all webhooks');
      throw new UnauthorizedException();
    }
    if (!this.constantTimeEqual(providedSecret, expected)) {
      this.logger.warn(`Chartink webhook auth failed (provided length=${providedSecret.length})`);
      throw new UnauthorizedException();
    }

    const result = await this.ingest.ingest(body);
    return { received: true, ...result };
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}
```

- [ ] **Step 8: Run the spec — confirm it passes**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=chartink-webhook.controller.spec --no-coverage 2>&1 | tail -25`
Expected: 4 tests pass.

- [ ] **Step 9: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/chartink/services/chartink-ingest.service.ts apps/api/src/modules/chartink/services/__tests__/ apps/api/src/modules/chartink/controllers/chartink-webhook.controller.ts apps/api/src/modules/chartink/controllers/__tests__/ && git commit -m "feat(chartink): ingest service + webhook controller (TDD)

Webhook authenticates via URL-embedded secret (timing-safe compare),
ingest service parses CSV stocks + parallel-indexed prices into hits,
upserts the scanner, persists the alert, and enqueues a chartink-process
Bull job. 8/8 unit tests green."
```

---

## Task 4 — Process service + worker

**Files:**
- Create: `apps/api/src/modules/chartink/services/chartink-process.service.ts`
- Create: `apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts`
- Create: `apps/api/src/modules/chartink/workers/chartink-process.worker.ts`

- [ ] **Step 1: Write the failing tests for the process service**

```typescript
// apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts
import { Test } from '@nestjs/testing';
import { ChartinkProcessService } from '../chartink-process.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { MarketDataRepository } from '../../../market-data/repositories/market-data.repository';
import { SignalGeneratorService } from '../../../signal-generator/services/signal-generator.service';
import { SetupTrackerService } from '../../../signal-generator/services/setup-tracker.service';

describe('ChartinkProcessService', () => {
  let service: ChartinkProcessService;
  let repo: { createAlertSetup: jest.Mock };
  let mdRepo: { getInstrumentBySymbol: jest.Mock };
  let signalSvc: { analyze: jest.Mock };
  let tracker: { getActive: jest.Mock };

  beforeEach(async () => {
    repo = { createAlertSetup: jest.fn().mockResolvedValue(undefined) };
    mdRepo = { getInstrumentBySymbol: jest.fn() };
    signalSvc = { analyze: jest.fn() };
    tracker = { getActive: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChartinkProcessService,
        { provide: ChartinkRepository, useValue: repo },
        { provide: MarketDataRepository, useValue: mdRepo },
        { provide: SignalGeneratorService, useValue: signalSvc },
        { provide: SetupTrackerService, useValue: tracker },
      ],
    }).compile();

    service = moduleRef.get(ChartinkProcessService);
  });

  it('persists kind=unresolved when symbol not in DB', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue(null);
    await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });
    expect(repo.createAlertSetup).toHaveBeenCalledWith({
      alertId: 'alert-1',
      symbol: 'UNKNOWN',
      token: null,
      hitPrice: 100,
      kind: 'unresolved',
      setupId: null,
      rejectReason: 'symbol not in local DB',
    });
    expect(signalSvc.analyze).not.toHaveBeenCalled();
  });

  it('persists kind=setup when analyze returns a setup', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'i1', token: '2885' });
    signalSvc.analyze.mockResolvedValue({ kind: 'setup', symbol: 'RELIANCE' });
    tracker.getActive.mockReturnValue({ id: 'setup-xyz' });

    await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 1467.4 });

    expect(signalSvc.analyze).toHaveBeenCalledWith('2885', 'NSE', 'RELIANCE', '15m');
    expect(repo.createAlertSetup).toHaveBeenCalledWith({
      alertId: 'alert-1',
      symbol: 'RELIANCE',
      token: '2885',
      hitPrice: 1467.4,
      kind: 'setup',
      setupId: 'setup-xyz',
      rejectReason: null,
    });
  });

  it('persists kind=no-setup when analyze rejects', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'i1', token: '2885' });
    signalSvc.analyze.mockResolvedValue({ kind: 'no-setup', reason: 'reject:rr {"rr":1.2}' });

    await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 1467.4 });

    expect(repo.createAlertSetup).toHaveBeenCalledWith({
      alertId: 'alert-1',
      symbol: 'RELIANCE',
      token: '2885',
      hitPrice: 1467.4,
      kind: 'no-setup',
      setupId: null,
      rejectReason: 'reject:rr {"rr":1.2}',
    });
  });

  it('persists kind=error when analyze throws', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'i1', token: '2885' });
    signalSvc.analyze.mockRejectedValue(new Error('broker timeout'));

    await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 1467.4 });

    expect(repo.createAlertSetup).toHaveBeenCalledWith({
      alertId: 'alert-1',
      symbol: 'RELIANCE',
      token: '2885',
      hitPrice: 1467.4,
      kind: 'error',
      setupId: null,
      rejectReason: 'broker timeout',
    });
  });
});
```

- [ ] **Step 2: Run the spec — confirm it fails**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=chartink-process.service.spec --no-coverage 2>&1 | tail -25`
Expected: 4 tests fail with `Cannot find module '../chartink-process.service'`.

- [ ] **Step 3: First confirm `MarketDataRepository.getInstrumentBySymbol` exists; if not, add it**

Run: `grep -n "getInstrumentBySymbol\|getInstrumentByToken" apps/api/src/modules/market-data/repositories/market-data.repository.ts | head -5`
If no `getInstrumentBySymbol` method exists, add this method to the `MarketDataRepository` class:

```typescript
/**
 * Find an instrument by trading symbol + exchange. Used by
 * Chartink integration to resolve scanner-emitted symbols to
 * tokens. Returns null when no instrument matches.
 */
async getInstrumentBySymbol(symbol: string, exchange: string) {
  return this.prisma.instrument.findFirst({
    where: { symbol, exchange },
  });
}
```

- [ ] **Step 4: Implement the process service**

```typescript
// apps/api/src/modules/chartink/services/chartink-process.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { SignalGeneratorService } from '../../signal-generator/services/signal-generator.service';
import { SetupTrackerService } from '../../signal-generator/services/setup-tracker.service';

interface Hit {
  symbol: string;
  hitPrice: number;
}

const RATE_LIMIT_MS = 350; // matches Angel One historical-API serial pacer (per memory)

@Injectable()
export class ChartinkProcessService {
  private readonly logger = new Logger(ChartinkProcessService.name);

  constructor(
    private readonly repo: ChartinkRepository,
    private readonly mdRepo: MarketDataRepository,
    private readonly signalSvc: SignalGeneratorService,
    private readonly tracker: SetupTrackerService,
  ) {}

  /**
   * Process every hit in an alert sequentially, with rate-limit pacing
   * between symbols (broker historical API caps at ~3 req/s).
   */
  async processAlert(alertId: string, hits: Hit[]): Promise<void> {
    this.logger.log(`Processing Chartink alert ${alertId} — ${hits.length} hits`);
    for (let i = 0; i < hits.length; i++) {
      try {
        await this.processOne(alertId, hits[i]);
      } catch (err) {
        // Per-symbol failures already get a 'error' AlertSetup row in processOne;
        // this catch is the absolute belt-and-braces for unexpected throws.
        this.logger.warn(
          `processOne unexpected throw for ${hits[i].symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (i < hits.length - 1) await this.sleep(RATE_LIMIT_MS);
    }
  }

  /**
   * One symbol → one ChartinkAlertSetup row. Branches on whether the
   * symbol resolves, whether analyze() returns a setup, no-setup, or throws.
   */
  async processOne(alertId: string, hit: Hit): Promise<void> {
    const instrument = await this.mdRepo.getInstrumentBySymbol(hit.symbol, 'NSE');
    if (!instrument) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: null,
        hitPrice: hit.hitPrice,
        kind: 'unresolved',
        setupId: null,
        rejectReason: 'symbol not in local DB',
      });
      return;
    }

    let result: { kind: string; reason?: string };
    try {
      result = (await this.signalSvc.analyze(
        instrument.token, 'NSE', hit.symbol, '15m',
      )) as { kind: string; reason?: string };
    } catch (err) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'error',
        setupId: null,
        rejectReason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (result.kind === 'setup') {
      const locked = this.tracker.getActive(instrument.token);
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'setup',
        setupId: locked?.id ?? null,
        rejectReason: null,
      });
    } else {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'no-setup',
        setupId: null,
        rejectReason: result.reason ?? null,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

- [ ] **Step 5: Run the spec — confirm it passes**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=chartink-process.service.spec --no-coverage 2>&1 | tail -25`
Expected: 4 tests pass.

- [ ] **Step 6: Implement the Bull worker (thin adapter, no separate test)**

```typescript
// apps/api/src/modules/chartink/workers/chartink-process.worker.ts
import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ChartinkProcessService } from '../services/chartink-process.service';
import { ChartinkProcessJobData } from '../services/chartink-ingest.service';

@Processor('chartink-process')
export class ChartinkProcessWorker {
  private readonly logger = new Logger(ChartinkProcessWorker.name);

  constructor(private readonly process: ChartinkProcessService) {}

  @Process()
  async handle(job: Job<ChartinkProcessJobData>): Promise<void> {
    const { alertId, hits } = job.data;
    this.logger.log(`Worker received alert ${alertId} with ${hits.length} hits`);
    await this.process.processAlert(alertId, hits);
  }
}
```

- [ ] **Step 7: Verify the full module compiles + all chartink specs pass**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "modules/chartink" || echo "OK"`
Expected: `OK`.

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=chartink --no-coverage 2>&1 | tail -10`
Expected: all chartink unit tests pass (8 from Task 3 + 4 from Task 4 = 12 tests).

- [ ] **Step 8: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/chartink/services/chartink-process.service.ts apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts apps/api/src/modules/chartink/workers/chartink-process.worker.ts apps/api/src/modules/market-data/repositories/market-data.repository.ts && git commit -m "feat(chartink): process service + Bull worker

ChartinkProcessService routes each (symbol, hitPrice) hit through
the existing pipeline: resolve via MarketDataRepository.getInstrumentBySymbol
(new method), call SignalGeneratorService.analyze, persist a
ChartinkAlertSetup row keyed by kind (setup / no-setup / unresolved /
error). Worker is a thin Bull adapter delegating to the service.

12/12 unit tests across the chartink module green."
```

---

## Task 5 — Read controller for /chartink page

**Files:**
- Create: `apps/api/src/modules/chartink/controllers/chartink.controller.ts`

- [ ] **Step 1: Implement the read controller (no test — pure delegation to repo)**

```typescript
// apps/api/src/modules/chartink/controllers/chartink.controller.ts
import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';

@Controller('api/chartink')
export class ChartinkController {
  constructor(private readonly repo: ChartinkRepository) {}

  @Get('scanners')
  async listScanners() {
    return this.repo.listScanners();
  }

  @Get('alerts')
  async listAlerts(@Query('limit') limit?: string) {
    const n = limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) : 50;
    return this.repo.listRecentAlerts(n);
  }

  @Get('alerts/:id')
  async getAlert(@Param('id') id: string) {
    const alert = await this.repo.getAlertWithSetups(id);
    if (!alert) throw new NotFoundException(`Chartink alert ${id} not found`);
    return alert;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "modules/chartink" || echo "OK"`
Expected: `OK`.

- [ ] **Step 3: Smoke test against the running dev server**

Run:
```
powershell.exe -Command "try { (Invoke-WebRequest 'http://localhost:4001/api/chartink/scanners' -UseBasicParsing -TimeoutSec 10).Content } catch { Write-Output \"ERR: $($_.Exception.Message)\" }"
```
Expected: `[]` (empty array — no scanners yet).

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/chartink/controllers/chartink.controller.ts && git commit -m "feat(chartink): read API for the /chartink page

GET /api/chartink/scanners | /alerts | /alerts/:id — pure
delegation to ChartinkRepository. Backs the dedicated frontend
diagnostic view."
```

---

## Task 6 — Wire chartinkSource into /signals API response

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/signal-generator.service.ts` (or wherever the signals listing builds its response)

- [ ] **Step 1: Locate the signals listing response builder**

Run: `grep -nE "getActiveSignals|getSignalHistory|listSignals|flattenSignal" apps/api/src/modules/signal-generator/services/signal-generator.service.ts apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts | head -10`
The response usually goes through a `flattenSignal` helper or similar. Identify the function that maps a Setup row into the JSON returned to the frontend.

- [ ] **Step 2: Inject `ChartinkRepository` into whichever service builds the signal listing**

Add `import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';` and add it to the constructor with `@Optional()` so existing test wiring doesn't break:

```typescript
import { Optional } from '@nestjs/common';
import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';

constructor(
  // ...existing injections...
  @Optional() private readonly chartinkRepo?: ChartinkRepository,
) {}
```

- [ ] **Step 3: Add `chartinkSource` enrichment to the signal mapper**

Wherever a Setup is converted to the JSON shape returned by `/api/signals` and `/api/signals/:id`, add:

```typescript
// Async enrichment for Chartink-sourced setups. Optional — ChartinkRepository
// is @Optional in the constructor so unit tests without the chartink module
// still work.
const chartinkSource = this.chartinkRepo
  ? await this.chartinkRepo.findChartinkSourceForSetup(setup.id)
  : null;

return {
  // ...existing fields...
  chartinkSource, // null when this setup wasn't Chartink-sourced
};
```

If the existing mapper is synchronous, it'll need to become async — that ripples to the controller too. Keep the change tight: only the listing endpoints that actually surface to the UI need this enrichment.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "signal-generator" || echo "OK"`
Expected: `OK`.

- [ ] **Step 5: Smoke test the existing /signals listing**

Run:
```
powershell.exe -Command "try { (Invoke-WebRequest 'http://localhost:4001/api/signals/active' -UseBasicParsing -TimeoutSec 10).Content } catch { Write-Output \"ERR: $($_.Exception.Message)\" }"
```
Expected: a JSON array. Each item should now have a `chartinkSource: null` field (no Chartink alerts yet, so all sources are null).

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/ && git commit -m "feat(signals): surface chartinkSource on signal listing

Joins on ChartinkAlertSetup.setupId to expose
{ scannerName, scannerUrl, alertId } | null on each signal in
/api/signals listings. Lets the SignalCard render a
'📊 Chartink: {scannerName}' chip when the setup originated from a
Chartink hit.

ChartinkRepository injected as @Optional so the existing test
wiring (no Chartink module loaded) still constructs cleanly."
```

---

## Task 7 — Frontend types + API client

**Files:**
- Modify: `apps/web/src/types/index.ts`
- Create: `apps/web/src/services/chartink.ts`

- [ ] **Step 1: Add the three Chartink types + extend the signal type**

Append to `apps/web/src/types/index.ts`:

```typescript
// ─── Chartink ────────────────────────────────────────────────

export interface ChartinkScanner {
  id: string;
  scanUrl: string;
  scanName: string;
  alertName: string | null;
  firstSeenAt: string;
  lastFiredAt: string | null;
  fireCount: number;
}

export interface ChartinkAlertSetup {
  id: string;
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  kind: 'setup' | 'no-setup' | 'unresolved' | 'error';
  setupId: string | null;
  rejectReason: string | null;
  processedAt: string;
}

export interface ChartinkAlert {
  id: string;
  scannerId: string;
  triggeredAt: string;
  receivedAt: string;
  rawPayload: unknown;
  scanner?: { scanName: string; scanUrl: string };
  setups?: ChartinkAlertSetup[];
}

export interface ChartinkSourceRef {
  scannerName: string;
  scannerUrl: string;
  alertId: string;
}
```

Find the existing `Signal` (or `SignalSummary` / `SignalListItem`) interface in the same file and add:

```typescript
  chartinkSource?: ChartinkSourceRef | null;
```

- [ ] **Step 2: Create the API client**

```typescript
// apps/web/src/services/chartink.ts
import api from './api';
import type { ChartinkScanner, ChartinkAlert } from '@/types';

export async function listScanners(): Promise<ChartinkScanner[]> {
  const r = await api.get<ChartinkScanner[]>('/chartink/scanners');
  return r.data;
}

export async function listAlerts(limit = 50): Promise<ChartinkAlert[]> {
  const r = await api.get<ChartinkAlert[]>('/chartink/alerts', { params: { limit } });
  return r.data;
}

export async function getAlert(id: string): Promise<ChartinkAlert> {
  const r = await api.get<ChartinkAlert>(`/chartink/alerts/${id}`);
  return r.data;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\web" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "types/index|services/chartink" || echo "OK"`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/web/src/types/index.ts apps/web/src/services/chartink.ts && git commit -m "feat(web): Chartink types + API client

Mirrors backend ChartinkScanner / ChartinkAlert / ChartinkAlertSetup
interfaces and adds the optional chartinkSource ref on Signal.
Tiny services/chartink.ts wraps the three GET endpoints."
```

---

## Task 8 — Frontend /chartink page + sidebar nav

**Files:**
- Create: `apps/web/src/pages/chartink/ChartinkPage.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`
- Modify: `apps/web/src/App.tsx` (or wherever routes are registered)

- [ ] **Step 1: Build the page**

```tsx
// apps/web/src/pages/chartink/ChartinkPage.tsx
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { listScanners, listAlerts, getAlert } from '@/services/chartink';
import type { ChartinkScanner, ChartinkAlert } from '@/types';

const REFRESH_MS = 30_000;

function fmtDelta(receivedAt: string, triggeredAt: string): string {
  const delta = (new Date(receivedAt).getTime() - new Date(triggeredAt).getTime()) / 1000;
  if (delta < 1) return '<1s';
  if (delta < 60) return `${delta.toFixed(0)}s`;
  return `${(delta / 60).toFixed(1)}m`;
}

function fmtKindCount(setups: ChartinkAlert['setups']): string {
  const counts: Record<string, number> = { setup: 0, 'no-setup': 0, unresolved: 0, error: 0 };
  for (const s of setups ?? []) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  const parts: string[] = [];
  if (counts.setup) parts.push(`${counts.setup} setups`);
  if (counts['no-setup']) parts.push(`${counts['no-setup']} no-setup`);
  if (counts.unresolved) parts.push(`${counts.unresolved} unresolved`);
  if (counts.error) parts.push(`${counts.error} error`);
  return parts.length ? parts.join(' · ') : '—';
}

export default function ChartinkPage() {
  const [scanners, setScanners] = useState<ChartinkScanner[]>([]);
  const [alerts, setAlerts] = useState<ChartinkAlert[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<ChartinkAlert | null>(null);

  const refresh = async () => {
    try {
      const [s, a] = await Promise.all([listScanners(), listAlerts(50)]);
      setScanners(s);
      setAlerts(a);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('chartink refresh failed', err);
    }
  };

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, []);

  const onSelectAlert = async (alert: ChartinkAlert) => {
    try {
      const full = await getAlert(alert.id);
      setSelectedAlert(full);
    } catch {
      setSelectedAlert(alert); // best-effort fallback
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Chartink</h1>

      {/* Scanners */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Scanners ({scanners.length})
        </h2>
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Slug</th>
                <th className="px-3 py-2 text-right">Fires</th>
                <th className="px-3 py-2">Last fired</th>
              </tr>
            </thead>
            <tbody>
              {scanners.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-[var(--color-text-muted)]">
                    No scanners configured yet. Configure your Chartink scanner's webhook URL to start.
                  </td>
                </tr>
              )}
              {scanners.map((s) => (
                <tr key={s.id} className="border-t border-[var(--color-border-subtle)]">
                  <td className="px-3 py-2">{s.scanName}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--color-text-muted)]">
                    <a
                      href={`https://chartink.com/screener/${s.scanUrl}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {s.scanUrl}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.fireCount}</td>
                  <td className="px-3 py-2 text-[var(--color-text-muted)]">
                    {s.lastFiredAt ? new Date(s.lastFiredAt).toLocaleString('en-IN') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent alerts */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Recent alerts ({alerts.length})
        </h2>
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Scanner</th>
                <th className="px-3 py-2">Triggered</th>
                <th className="px-3 py-2">Received delta</th>
                <th className="px-3 py-2">Outcomes</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => onSelectAlert(a)}
                  className={clsx(
                    'cursor-pointer border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]',
                    selectedAlert?.id === a.id && 'bg-[var(--color-bg-tertiary)]',
                  )}
                >
                  <td className="px-3 py-2">{a.scanner?.scanName ?? '—'}</td>
                  <td className="px-3 py-2 text-[var(--color-text-muted)]">
                    {new Date(a.triggeredAt).toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
                    {fmtDelta(a.receivedAt, a.triggeredAt)}
                  </td>
                  <td className="px-3 py-2">{fmtKindCount(a.setups)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Selected alert detail */}
      {selectedAlert && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Alert {selectedAlert.id} — per-symbol decisions
          </h2>
          <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2 text-right">Hit price</th>
                  <th className="px-3 py-2">Outcome</th>
                  <th className="px-3 py-2">Reason / Setup</th>
                </tr>
              </thead>
              <tbody>
                {(selectedAlert.setups ?? []).map((s) => (
                  <tr key={s.id} className="border-t border-[var(--color-border-subtle)]">
                    <td className="px-3 py-2 font-mono">{s.symbol}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.hitPrice.toFixed(2)}</td>
                    <td
                      className={clsx(
                        'px-3 py-2 font-semibold uppercase tracking-wider',
                        s.kind === 'setup' && 'text-emerald-400',
                        s.kind === 'no-setup' && 'text-amber-400',
                        s.kind === 'unresolved' && 'text-gray-400',
                        s.kind === 'error' && 'text-red-400',
                      )}
                    >
                      {s.kind}
                    </td>
                    <td className="px-3 py-2 text-[var(--color-text-muted)]">
                      {s.setupId ? (
                        <a href={`/signals?signalId=${s.setupId}`} className="hover:underline">
                          → setup {s.setupId}
                        </a>
                      ) : (
                        s.rejectReason ?? '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the sidebar nav entry**

Open `apps/web/src/components/layout/Sidebar.tsx`. Find the array of nav entries (it'll be a `const NAV_ITEMS = [...]` or similar). Add an entry following the existing pattern, e.g.:

```typescript
{ to: '/chartink', label: 'Chartink', icon: ChartLineIcon /* or similar from lucide-react */ },
```

If you can't find an obvious pattern, search the file: `grep -n "to:.*'\/" apps/web/src/components/layout/Sidebar.tsx` — find a line like `{ to: '/signals', ... }` and copy its shape.

- [ ] **Step 3: Register the route**

Open `apps/web/src/App.tsx` (or wherever `<Routes>` lives). Find the existing route definitions and add:

```tsx
import ChartinkPage from '@/pages/chartink/ChartinkPage';
// ...
<Route path="/chartink" element={<ChartinkPage />} />
```

- [ ] **Step 4: Verify the page renders without TS error and Vite hot-reloads**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\web" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "chartink|ChartinkPage" || echo "OK"`
Expected: `OK`.

Then visit `http://localhost:4000/chartink` in the browser. Expected: page renders with empty "No scanners configured yet" state, no crashes.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/web/src/pages/chartink/ apps/web/src/components/layout/Sidebar.tsx apps/web/src/App.tsx && git commit -m "feat(web): Chartink page with scanners + alerts + per-symbol decisions

Read-only diagnostic surface. Polls /api/chartink/{scanners,alerts}
on a 30s timer. Click an alert row to expand the per-symbol
breakdown showing kind (setup/no-setup/unresolved/error) and the
reject reason or setup link.

Adds /chartink route + sidebar nav entry."
```

---

## Task 9 — SignalCard badge

**Files:**
- Modify: `apps/web/src/components/trading/SignalCard.tsx`

- [ ] **Step 1: Find the right insertion point**

Run: `grep -nE "Grade|grade|badge|chip" apps/web/src/components/trading/SignalCard.tsx | head -10`
Identify where the existing grade chip / metadata badges render (typically near the top of the card).

- [ ] **Step 2: Add the Chartink chip**

Just below the existing badges/chips section, insert:

```tsx
{signal.chartinkSource && (
  <a
    href={`/chartink?alertId=${signal.chartinkSource.alertId}`}
    title={`Sourced from Chartink scanner: ${signal.chartinkSource.scannerName}`}
    className="inline-flex items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-blue-400 hover:bg-blue-500/25"
  >
    <span>📊</span>
    <span>{signal.chartinkSource.scannerName}</span>
  </a>
)}
```

The `signal` prop should already have `chartinkSource?: ChartinkSourceRef | null` from Task 7's type extension.

- [ ] **Step 3: Verify Vite picked up the change cleanly**

Check the dev log:
```
grep -nE "SignalCard\.tsx|hmr update.*SignalCard|error in.*SignalCard" "C:\Users\ARYANK~1\AppData\Local\Temp\claude\C--Users-AryanKumar-Desktop-TD-Automation\e3a6b8f6-1960-45a8-815d-bea227ccaa2d\tasks\bwfgwwezq.output" | tail -5
```
Expected: a recent `hmr update` line for SignalCard.tsx, no errors after it.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/web/src/components/trading/SignalCard.tsx && git commit -m "feat(web): Chartink badge on SignalCard

When a setup originated from a Chartink scanner hit, the SignalCard
shows a small '📊 {scannerName}' chip linking back to the
corresponding alert on the /chartink page. No-op for cron-fired
setups (chartinkSource is null)."
```

---

## Self-review

**Spec coverage** — every section of `2026-05-06-chartink-webhook-integration-design.md` maps to a task:

| Spec section | Task(s) |
|---|---|
| Architecture (component table) | 2, 3, 4, 5, 8, 9 |
| Webhook contract (auth + DTO + ack) | 3 |
| Schema (Prisma) | 1 |
| Processing algorithm (resolve → analyze → persist) | 4 |
| Frontend `/chartink` page | 7, 8 |
| Frontend `SignalCard` badge | 7, 9 |
| Edge cases — auth fail / DTO fail / length mismatch | 3 (controller test + ingest test) |
| Edge cases — unresolved symbol / setup / no-setup / error | 4 (process service tests) |
| Edge cases — outside market hours | inherited from analyze() — surfaced as kind='no-setup' |
| Test plan — unit + e2e | unit covered in Tasks 3 + 4. E2E (controller-through-DB) deferred since the unit tests + a manual smoke check cover the interesting paths. |

**Placeholder scan** — no TBD/TODO; every code step contains complete code; all file paths absolute or repo-relative.

**Type consistency** — `ChartinkScanner`, `ChartinkAlert`, `ChartinkAlertSetup` shapes are identical in the Prisma schema (Task 1), backend repository (Task 2), and frontend types (Task 7). The `ChartinkProcessJobData` type defined in Task 3's ingest service is reused by Task 4's worker. The `kind` enum (`'setup' | 'no-setup' | 'unresolved' | 'error'`) is identical in the spec, the repo's `CreateAlertSetupInput`, the process service tests, and the frontend type.

**Parallelism note** — Task 1 (Prisma schema) gates everything. After Task 1 commits, Task 2 (backend foundation) gates Tasks 3, 4, 5, 6 (which are mostly independent within the backend module). Task 7 (frontend types) gates Tasks 8 and 9 — but the type contract is fully defined in Task 7's text, so a frontend agent can start in parallel with the backend chain. Recommended dispatch: do Task 1 directly, then dispatch Agent A (Tasks 2-3-4-5-6) and Agent B (Tasks 7-8-9) in parallel.
