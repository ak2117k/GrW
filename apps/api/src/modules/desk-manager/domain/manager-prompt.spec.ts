import { parseDeskManagerConfig } from '../desk-manager.config';
import { MANAGER_PROMPT_VERSION, managerSystemPrompt } from './manager-prompt';

const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'shadow', HUB_OWNER_USER_ID: 'owner' });

describe('manager system prompt (audit 2026-11-27 packet blocks)', () => {
  const p = managerSystemPrompt(cfg);

  it('funds: never OPEN when the 1-lot cost is above the available funds; prefer the mini', () => {
    expect(p).toMatch(/packet\.funds/);
    expect(p).toMatch(/never OPEN when .*1-lot cost.*available/i);
    expect(p).toMatch(/mini/i);
    expect(p).toMatch(/available null.*lot cost null = do not assume it fits: NO_ACTION or FLAG_DATA_HOLE for a full-size lot/);
  });

  it('channelViews fields named as in the packet (at, not time)', () => {
    expect(p).toMatch(/\(channel, at, summary, subject, bias\)/);
  });

  it('channel views, per-source quotas and the owner P&L are explained', () => {
    expect(p).toMatch(/packet\.channelViews/);
    expect(p).toMatch(/readings 16, signal decisions 8, AI setups 6, entry engine 10/);
    expect(p).toMatch(/count/);
    expect(p).toMatch(/pnl\.ownerPnl/);
    expect(p).toMatch(/never blocks the guard/);
  });

  it('version bumped for the new wording', () => {
    expect(MANAGER_PROMPT_VERSION).toBe('desk-manager-v2');
  });
});
