import { createHash } from 'crypto';
import {
  SENTINEL_OVERNIGHT_COMPOSITE_PROMPT_VERSION,
  SENTINEL_OVERNIGHT_PROMPT_VERSION,
  SENTINEL_OVERNIGHT_SCORECARD_COMPOSITE_PROMPT_VERSION,
  SENTINEL_OVERNIGHT_SCORECARD_PROMPT_VERSION,
  SENTINEL_OVERNIGHT_SCORECARD_SYSTEM_PROMPT,
  SENTINEL_OVERNIGHT_SYSTEM_PROMPT,
  isOvernightPromptVersion,
  overnightPromptFor,
} from './sentinel-overnight-prompt';
import { SENTINEL_SYSTEM_PROMPT } from './sentinel-system-prompt';
import { SentinelAgentService } from '../services/sentinel-agent.service';
import { scorecardBlock } from '../overnight/scorecard-block';
import type { OvernightPacket } from '../overnight/overnight-packet.types';
import type { Scorecard } from '../../overnight-scorecard/scorecard.types';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** sha256 of the o4 prompt text as it was on main before the scorecard existed (c8e3bc3). */
const O4_SHA256 = '23d6e79ef6c78f91c149cbddf73ef66196f42506e7aae14e386ba7f1c94d30ef';

const SCORECARD: Scorecard = {
  userId: 'u1',
  symbol: 'NIFTY13OCT2625000CE',
  exchange: 'NFO',
  underlying: 'NIFTY',
  side: 'BULLISH',
  window: 'OVERNIGHT',
  computedAt: '2026-10-12T10:10:00.000Z',
  factors: [{ name: 'oi', points: 2, value: 'PCR 2.1', reason: 'put writing', available: true }],
  total: 2,
  band: 'SUPPORTS',
};

describe('the overnight prompt variants (SENTINEL_SCORECARD)', () => {
  it('o4 is byte-identical to before the scorecard', () => {
    expect(SENTINEL_OVERNIGHT_PROMPT_VERSION).toBe('o4');
    expect(sha(SENTINEL_OVERNIGHT_SYSTEM_PROMPT)).toBe(O4_SHA256);
  });

  it('o5 is a new version id, still recognised as an overnight stamp', () => {
    expect(SENTINEL_OVERNIGHT_SCORECARD_PROMPT_VERSION).toBe('o5');
    expect(SENTINEL_OVERNIGHT_SCORECARD_COMPOSITE_PROMPT_VERSION).toBe('o5/t1');
    expect(isOvernightPromptVersion(SENTINEL_OVERNIGHT_SCORECARD_COMPOSITE_PROMPT_VERSION)).toBe(true);
  });

  it('o5 = o4 + the field-list entry, one reading line and one weighing rule, nothing else', () => {
    const o5 = SENTINEL_OVERNIGHT_SCORECARD_SYSTEM_PROMPT;
    const added = o5.split('\n').filter((l) => !SENTINEL_OVERNIGHT_SYSTEM_PROMPT.split('\n').includes(l));
    expect(added).toHaveLength(3);
    expect(added[0]).toMatch(/^- overnight: .*marketCues, scorecard\.$/);
    expect(added[1]).toMatch(/^- overnight\.scorecard: /);
    expect(added[2]).toMatch(/^- SCORECARD: base the verdict on overnight\.scorecard\./);
    // Undo the three edits: back to o4 exactly.
    const undone = o5
      .replace(`\n${added[1]}`, '')
      .replace(`\n${added[2]}`, '')
      .replace('marketCues, scorecard.', 'marketCues.');
    expect(undone).toBe(SENTINEL_OVERNIGHT_SYSTEM_PROMPT);
  });

  it('o5 says to name the overriding factor when the verdict goes against the total', () => {
    expect(SENTINEL_OVERNIGHT_SCORECARD_SYSTEM_PROMPT).toMatch(/goes against the scorecard total, name the factor/);
    expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).not.toMatch(/scorecard/i);
  });

  it('selects o5 exactly when the packet carries overnight.scorecard', () => {
    expect(overnightPromptFor({ overnight: {} })).toEqual({
      text: SENTINEL_OVERNIGHT_SYSTEM_PROMPT,
      version: SENTINEL_OVERNIGHT_COMPOSITE_PROMPT_VERSION,
    });
    expect(overnightPromptFor({ overnight: { scorecard: scorecardBlock(SCORECARD) } })).toEqual({
      text: SENTINEL_OVERNIGHT_SCORECARD_SYSTEM_PROMPT,
      version: SENTINEL_OVERNIGHT_SCORECARD_COMPOSITE_PROMPT_VERSION,
    });
  });
});

describe('SentinelAgentService.judgeOvernight with a scorecard', () => {
  const reply = (obj: unknown) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });
  const verdict = {
    verdict: 'HOLD_OVERNIGHT',
    confidence: 'medium',
    thesisStatus: 'INTACT',
    overnightRisk: 'theta against a long call, but the scorecard supports it (oi +2)',
    changeMindLevel: 'an open below 24950',
    openPlan: 'if it gaps below 24950, exit; if it opens above 25150, hold with a stop at 25020',
    evidence: ['overnight.scorecard.total', 'overnight.scorecard'],
  };
  const base = { overnight: { review: { kind: 'OVERNIGHT_REVIEW' } } } as unknown as OvernightPacket;
  const withCard = { overnight: { ...base.overnight, scorecard: scorecardBlock(SCORECARD) } } as unknown as OvernightPacket;

  it('sends o5 for a packet with a scorecard, accepts a citation into it, and stamps o5', async () => {
    const create = jest.fn().mockResolvedValue(reply(verdict));
    const svc = new SentinelAgentService({ messages: { create } } as never);
    await expect(svc.judgeOvernight(withCard)).resolves.toMatchObject({ verdict: 'HOLD_OVERNIGHT' });
    expect(create.mock.calls[0][0].system[0].text).toBe(SENTINEL_OVERNIGHT_SCORECARD_SYSTEM_PROMPT);
    expect(svc.overnightPromptVersionFor(withCard)).toBe('o5/t1');
  });

  it('sends o4 for a packet without one; the live prompt is untouched', async () => {
    const create = jest.fn().mockResolvedValue(reply({ ...verdict, evidence: ['overnight.review'] }));
    const svc = new SentinelAgentService({ messages: { create } } as never);
    await svc.judgeOvernight(base);
    expect(create.mock.calls[0][0].system[0].text).toBe(SENTINEL_OVERNIGHT_SYSTEM_PROMPT);
    expect(svc.overnightPromptVersionFor(base)).toBe(svc.overnightPromptVersion);
    expect(SENTINEL_SYSTEM_PROMPT).not.toMatch(/scorecard/i);
  });
});
