import { Logger } from '@nestjs/common';
import { RecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { parseDeskManagerConfig } from '../desk-manager.config';
import type { DeskPacket } from '../domain/desk.types';
import { ManagerLlmService } from './manager-llm.service';

/**
 * Trade agent exit authority Task 7: the desk manager (decide) and the supreme confirm (send) ride Task 2's
 * directOrFailoverTransport. AI_FAILOVER on (default when TRADE_AGENT_AUTHORITY=live) ⇒ the chain's routes, first
 * answer wins; off ⇒ exactly the recorded direct transport as before.
 */
const packet = { at: '2026-11-27T04:30:00.000Z', mode: 'shadow', positions: { status: 'unavailable', reason: 'x', source: 'x' } } as unknown as DeskPacket;
const REPLY = JSON.stringify({ summary: 'quiet', decisions: [] });

function make(env: Record<string, string | undefined>) {
  const cli = {
    createWithMeta: jest.fn(async () => ({
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: REPLY }] },
      meta: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, billed: false },
    })),
  };
  const audit = { insert: jest.fn(async () => undefined) };
  const cycle = { runShared: jest.fn((_id: string, work: () => Promise<unknown>) => work()) };
  const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'shadow', DESK_MANAGER_MODEL: 'claude-opus-test' });
  const svc = new ManagerLlmService({ get: (k: string) => env[k] } as never, cli as never, audit as never, cycle as never, cfg);
  const transport = () => (svc as unknown as { recorded(job?: string): unknown }).recorded();
  return { svc, cli, transport };
}

describe('ManagerLlmService transport failover', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('off (authority unset, AI_FAILOVER unset): exactly the recorded direct transport, as before', () => {
    const t = make({ SENTINEL_JUDGE: 'cli' }).transport();
    expect(t).toBeInstanceOf(RecordedTransport);
    expect(typeof (t as { allDownSince?: unknown }).allDownSince).toBe('undefined');
  });

  it('AI_FAILOVER=off under authority live: still the direct transport', () => {
    const t = make({ SENTINEL_JUDGE: 'cli', TRADE_AGENT_AUTHORITY: 'live', AI_FAILOVER: 'off' }).transport();
    expect(t).toBeInstanceOf(RecordedTransport);
  });

  it('authority live (failover default on): a failover transport over the chain; a reply on the cli route answers decide()', async () => {
    const m = make({ SENTINEL_JUDGE: 'cli', TRADE_AGENT_AUTHORITY: 'live', AI_FAILOVER_CHAIN: 'cli' });
    expect(typeof (m.transport() as { allDownSince?: unknown }).allDownSince).toBe('function');
    const out = await m.svc.decide('owner-1', packet);
    expect(out.text).toBe(REPLY);
    expect(m.cli.createWithMeta).toHaveBeenCalledTimes(1);
  });
});
