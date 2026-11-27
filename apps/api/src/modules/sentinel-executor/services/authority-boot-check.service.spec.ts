import { Logger } from '@nestjs/common';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { parseFloorBrokerSlConfig } from '../domain/floor-broker-sl';
import { ExecutorAuthorityBootCheck } from './authority-boot-check.service';

const PORT = {};
const all = (env: Record<string, string | undefined>, over: Partial<Record<'state' | 'alarms' | 'supreme' | 'briefs' | 'escalation', unknown>> = {}) => {
  const p = { state: PORT, alarms: PORT, supreme: PORT, briefs: PORT, escalation: PORT, ...over };
  return new ExecutorAuthorityBootCheck(p.state, p.alarms, p.supreme, p.briefs, p.escalation, env);
};

describe('ExecutorAuthorityBootCheck', () => {
  afterEach(() => jest.restoreAllMocks());

  it('off: nothing to report even with every port absent and FLOOR_BROKER_SL=live', () => {
    const c = new ExecutorAuthorityBootCheck(undefined, undefined, undefined, undefined, undefined, { FLOOR_BROKER_SL: 'live' });
    expect(c.problems()).toEqual([]);
  });

  it('live with every port bound: nothing to report', () => {
    expect(all({ TRADE_AGENT_AUTHORITY: 'live' }).problems()).toEqual([]);
  });

  it('live with OWNER_ESCALATION unbound: a boot ERROR naming the blocked-exit consequence', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const c = all({ TRADE_AGENT_AUTHORITY: 'live' }, { escalation: undefined });
    expect(c.problems()).toEqual([expect.stringMatching(/OWNER_ESCALATION is unbound .* a blocked exit \(OPEN_ORDER_EXISTS\) would reach no owner alert/)]);
    c.onApplicationBootstrap();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('live + FLOOR_BROKER_SL=live: a boot ERROR, and the floor stop config is forced to shadow', () => {
    const env = { TRADE_AGENT_AUTHORITY: 'live', FLOOR_BROKER_SL: 'live', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true' };
    expect(all(env).problems()).toEqual([expect.stringMatching(/FLOOR_BROKER_SL=live is not allowed while TRADE_AGENT_AUTHORITY=live — running shadow/)]);
    const cfg = parseFloorBrokerSlConfig(env, parseAutoExitConfig(env));
    expect(cfg.mode).toBe('shadow');
    expect(cfg.problems).toContain('FLOOR_BROKER_SL=live is not allowed while TRADE_AGENT_AUTHORITY=live — running shadow');
  });

  it('authority off: FLOOR_BROKER_SL=live (with its prerequisites) stays live, as today', () => {
    const env = { FLOOR_BROKER_SL: 'live', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true' };
    expect(parseFloorBrokerSlConfig(env, parseAutoExitConfig(env)).mode).toBe('live');
  });
});
