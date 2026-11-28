import { parseDeskManagerConfig } from '../desk-manager.config';
import { MANAGER_PROMPT_VERSION, managerSystemPrompt } from './manager-prompt';

const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'shadow', HUB_OWNER_USER_ID: 'owner' });

describe('manager system prompt (audit 2026-11-27 packet blocks)', () => {
  const p = managerSystemPrompt(cfg);

  it('funds: never OPEN when the 1-lot cost is above the available funds; prefer the mini', () => {
    expect(p).toMatch(/packet\.funds/);
    expect(p).toMatch(/never OPEN when .*1-lot cost.*available/i);
    expect(p).toMatch(/mini/i);
  });

  it('final review item 7: funds unknown forbids ANY OPEN size, minis included', () => {
    expect(p).toMatch(/funds\.available null.*no OPEN of any size, minis included/);
    expect(p).toMatch(/lot cost null.*no OPEN on that contract/);
    expect(p).not.toMatch(/for a full-size lot/);
  });

  it('final review item 2: EXIT_ADVISORY is advice on a held position, never a reason to EXIT a non-held one', () => {
    expect(p).toContain("EXIT_ADVISORY = the agent's advice on a held position; it is not an exit and never a reason to EXIT a non-held position");
  });

  it('final review item 4: which trades pnl counts, carried positions, positions[].pnl since entry', () => {
    expect(p).toMatch(/packet\.pnl counts manager, trade-agent, signal and reentry trades/);
    expect(p).toMatch(/owner manual and held trades are excluded and shown as pnl\.ownerPnl/);
    expect(p).toMatch(/carried in from an earlier day counts only today's move/);
    expect(p).toMatch(/positions\[\]\.pnl is since entry/);
    expect(p).not.toMatch(/manager \/ trade-agent opens\): the guard decides on it/);
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
    expect(MANAGER_PROMPT_VERSION).toBe('desk-manager-v4');
  });

  it('fix 8: a position-screenshot view is context only (maybe a client or closed; never a lead, level, proposalRef or OPEN evidence)', () => {
    expect(p).toMatch(/position-screenshot/);
    expect(p).toMatch(/may be a client's or already closed/);
    expect(p).toMatch(/never a lead, a level or a reason to OPEN/);
    expect(p).toMatch(/never cite it as a proposalRef or as evidence for an OPEN/);
  });
});
