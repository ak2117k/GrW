import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiGatewayModule, SENTINEL_MIN_CLI_CONCURRENCY, cliConcurrency, istMidnight } from './ai-gateway.module';
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

describe('cliConcurrency', () => {
  it('defaults to 2 with the sentinel flag off', () => {
    expect(cliConcurrency(undefined, undefined)).toBe(2);
    expect(cliConcurrency('', 'false')).toBe(2);
  });

  it('honours a configured value with the flag off', () => {
    expect(cliConcurrency('4', 'false')).toBe(4);
    expect(cliConcurrency('1', undefined)).toBe(1);
  });

  it('never yields 0 or garbage (a zero limit would queue every CLI call forever)', () => {
    expect(cliConcurrency('0', undefined)).toBe(2);
    expect(cliConcurrency('-3', undefined)).toBe(2);
    expect(cliConcurrency('abc', undefined)).toBe(2);
    expect(cliConcurrency('2.7', undefined)).toBe(2);
  });

  it('floors at 3 when AI_GATEWAY_SENTINEL=true (2 judges + a thesis call)', () => {
    expect(cliConcurrency(undefined, 'true')).toBe(SENTINEL_MIN_CLI_CONCURRENCY);
    expect(cliConcurrency('2', 'true')).toBe(3);
    expect(cliConcurrency('5', 'true')).toBe(5);
  });
});
