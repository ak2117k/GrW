import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiGatewayModule, istMidnight } from './ai-gateway.module';
import { AI_GATEWAY, AiGatewayService } from './ai-gateway.service';
import { ClaudeCliTransport } from './providers/claude-cli.provider';
import { ScorerClient } from './scorer/scorer.client';

async function compile() {
  return Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), AiGatewayModule],
  })
    .overrideProvider(PrismaService)
    .useValue({ aiCall: { create: jest.fn(), aggregate: jest.fn() } })
    .compile();
}

describe('AiGatewayModule', () => {
  const saved = process.env.AI_CONFIG_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_CONFIG_DIR;
    else process.env.AI_CONFIG_DIR = saved;
  });

  it('boots with the shipped config and binds AI_GATEWAY to the one AiGatewayService', async () => {
    delete process.env.AI_CONFIG_DIR;
    const mod = await compile();
    const gw = mod.get(AI_GATEWAY);
    expect(gw).toBeInstanceOf(AiGatewayService);
    expect(gw).toBe(mod.get(AiGatewayService));
    expect(mod.get(ClaudeCliTransport)).toBeInstanceOf(ClaudeCliTransport);
    expect(mod.get(ScorerClient)).toBeInstanceOf(ScorerClient);
  });

  it('fails boot loudly when the config files cannot be found', async () => {
    process.env.AI_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cfg-empty-'));
    await expect(compile()).rejects.toThrow(/ai-routes\.json/);
  });

  it('istMidnight is 00:00 IST (18:30 UTC the previous day)', () => {
    expect(istMidnight(new Date('2026-10-12T06:00:00Z')).toISOString()).toBe('2026-10-11T18:30:00.000Z');
    expect(istMidnight(new Date('2026-10-12T18:30:00Z')).toISOString()).toBe('2026-10-12T18:30:00.000Z');
  });
});
