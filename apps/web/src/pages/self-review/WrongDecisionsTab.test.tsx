import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { gradedLine, WrongDecisionsPanel, type DecisionsBlock, type FixTicket } from './WrongDecisionsTab';

const decisions: DecisionsBlock = {
  session: '2026-11-04',
  graded: 31,
  wrong: 2,
  unscorable: 3,
  items: [
    {
      refId: 'dg:1',
      decided: 'EXIT exit at 566.5 (GOLD25NOV26CE, live)',
      better: 'hold would have made ₹29,850 more per lot, net (60m)',
      causeType: 'SETTING',
      cause: 'the floor trail is too tight on GOLD',
      action: 'proposal exit.floorTrailN',
    },
    {
      refId: 'dg:2',
      decided: 'LIVE_NOT_PLACED (NIFTY, live): 12 risk_manager blocks',
      better: 'take',
      causeType: 'CODE_BUG',
      cause: 'paper trades counted against the live position limit',
      action: 'ticket Paper trades counted against the live limit',
    },
  ],
};
const tickets: FixTicket[] = [
  {
    id: 't1', key: 'code-bug:risk', cause: 'CODE_BUG', title: 'Paper trades counted against the live limit', proposedChange: 'Count only live trades.',
    files: ['apps/api/src/modules/risk-manager/risk.service.ts'], testDescription: 'paper does not block live', status: 'OPEN', occurrences: 4,
    costRupees: 34_600, firstSeen: '2026-11-02T13:15:00Z', lastSeen: '2026-11-04T13:15:00Z',
  },
];

describe('WrongDecisionsPanel', () => {
  it('renders the graded line, each wrong decision in plain words, and the fix queue', () => {
    const html = renderToStaticMarkup(<WrongDecisionsPanel decisions={decisions} tickets={tickets} />);
    expect(html).toContain('Wrong decisions · 2026-11-04');
    expect(html).toContain('Graded 31, wrong 2, unscorable 3');
    expect(html).toContain('hold would have made ₹29,850 more per lot, net (60m)');
    expect(html).toContain('the floor trail is too tight on GOLD');
    expect(html).toContain('ticket Paper trades counted against the live limit');
    expect(html).toContain('Fix queue');
    expect(html).toContain('seen 4× · cost ₹34,600 · last 2026-11-04');
    expect(html).toContain('apps/api/src/modules/risk-manager/risk.service.ts');
  });

  it('says "0 wrong decisions found" or the reason, and handles no data', () => {
    expect(gradedLine({ ...decisions, wrong: 0, items: [] })).toBe('Graded 31, wrong 0, unscorable 3 — 0 wrong decisions found');
    expect(gradedLine({ ...decisions, graded: 0, wrong: 0, reason: 'no NSE session today (weekend / holiday)', items: [] })).toContain('weekend');
    const html = renderToStaticMarkup(<WrongDecisionsPanel decisions={null} tickets={[]} />);
    expect(html).toContain('no decision grading');
    expect(html).toContain('No fix tickets.');
  });
});
