import { SentinelAgentService, type OvernightVerdict } from './sentinel-agent.service';
import { absent, present, type ContextPacket } from './context-packet.service';
import { SENTINEL_SYSTEM_PROMPT, SENTINEL_SYSTEM_PROMPT_NO_CUES } from '../prompts/sentinel-system-prompt';
import {
  SENTINEL_OVERNIGHT_PROMPT_VERSION,
  SENTINEL_OVERNIGHT_SYSTEM_PROMPT,
} from '../prompts/sentinel-overnight-prompt';
import { THESIS_PROMPT_VERSION } from '../prompts/thesis-prompt';
import type { OvernightPacket, OvernightSection } from '../overnight/overnight-packet.types';

const AT = '2026-10-12T10:15:00.000Z';

const live: ContextPacket = {
  position: {
    symbol: 'NIFTY13OCT2625000CE',
    kind: 'POSITION',
    ownership: 'SENTINEL',
    segment: 'OPT',
    side: 'LONG',
    qty: 75,
    entryPrice: 140,
    ltp: 120,
    underlyingLtp: present(25050, 'market-data (underlying spot — broker FULL-mode quote)', AT),
    entryTime: '2026-10-12T04:00:00.000Z',
    expiry: '2026-10-13',
  },
  money: { grossPnl: -1500, charges: 90, netPnl: -1590, greenFloorPrice: 142.4, greenFloorArmed: false, mfe: 150, mae: 112 },
  thesis: present(
    { direction: 'LONG', reason: 'bought the 25000 retest', levelPrice: 25000, targetPrice: 25300, invalidation: 24900, source: 'INFERRED' },
    'agent inference',
    AT,
  ),
  structure: {
    levelBook: present([{ price: 25000, kind: 'SUPPORT' }], 'chart-context.service (15m)', AT),
    nearestSupport: present(25000, 'level book', AT),
    nearestResistance: present(25200, 'level book', AT),
  },
  flow: { volumeRatio: absent('n/a'), oiWalls: absent('no options chain for this symbol, so no OI walls') },
  macro: { fiiDii: absent('stub'), sector: absent('stub'), globalCues: absent('stub'), realFactors: absent('none') },
  news: { headlines: absent('none'), freshCount: absent('none') },
  session: {
    nowIst: '2026-10-12 15:45:00 IST',
    nowUtc: AT,
    minutesToClose: absent('the NFO session has already closed (15:30 IST) — nothing left to run there today'),
    expiry: '2026-10-13',
  },
  trigger: present([{ name: 'OVERNIGHT_REVIEW', detail: 'scheduled after-close review' }], 'sentinel-overnight.service', AT),
  memory: absent('no prior verdicts for this position — this is the first look'),
};

const overnight: OvernightSection = {
  review: {
    kind: 'OVERNIGHT_REVIEW',
    window: 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12',
    lastCloseAt: '2026-10-12T10:00:00.000Z',
    nextOpenAt: '2026-10-13T03:45:00.000Z',
    hoursUntilOpen: 17.5,
    lastPriceAt: '2026-10-12T09:59:30.000Z',
    lastPriceAtBasis: 'as of tracker update',
  },
  expiry: present({ expiry: '2026-10-13', calendarDays: 1, tradingSessionsLeft: 1 }, 'derived', AT),
  decay: present(
    { thetaPerUnitPerDay: -24, nightDays: 0.7292, perUnitOvernight: -17.5, rupeesForPosition: -1312.5, method: 'options-chain greeks' },
    'options-chain.service greeks',
    AT,
  ),
  greeks: present({ delta: 0.52, gamma: 0.001, theta: -24, vega: 9.1, iv: 13.2 }, 'options-chain.service greeks', AT),
  preOpenPrice: absent('after-close review — the next pre-open has not happened'),
  preOpenGap: absent('only the 09:10 pre-open check reads an NSE pre-open IEP'),
  news: present({ items: [], stale: false }, 'news-aggregator.service', AT),
  oi: present({ pcr: present(0.82, 'options-chain.service getPCR', AT) }, 'options-chain.service', AT),
  marketCues: {
    nasdaq: present({ value: 27366.17, change: 172.83, changePercent: 0.64, direction: 'UP', ageMinutes: 1100, basis: 'previous session close', status: 'ok' }, 'Yahoo', AT),
    sp500: absent('not fetched yet'),
    dow: absent('not fetched yet'),
    nasdaqFutures: present({ value: 31108.75, change: -60, changePercent: -0.19, direction: 'DOWN', ageMinutes: 5, basis: 'quote time', status: 'ok' }, 'Yahoo', AT),
    sp500Futures: absent('not fetched yet'),
    giftNifty: absent('GIFT Nifty is read in the 23:45 and 08:30 reviews'),
    fiiDerivatives: present({ session: '2026-10-09', indexFutures: { long: 1, short: 2, net: -1 } }, 'NSE participant OI', '2026-10-09'),
    crudeOil: present({ value: 5600, change: -84, changePercent: -1.5, direction: 'DOWN', ageMinutes: 5, basis: 'quote time' }, 'commodities', AT),
    gold: absent('no quote'),
    fiiFlows: present({ session: '2026-10-09', fii: { buy: 1, sell: 2, net: -1 }, todaysFigure: 'not yet published (NSE publishes ~18:00–20:00 IST)' }, 'NSE fiidiiTradeReact', '2026-10-09'),
    indiaVix: present({ value: 13.4, change: 0.6, changePercent: 4.7, direction: 'UP', ageMinutes: 0, basis: 'previous session close' }, 'market-context.service', AT),
    sectorStrength: absent('underlying is an index'),
    underlyingChange: absent('no previous close'),
  },
};

const packet: OvernightPacket = { ...live, overnight };

const valid: OvernightVerdict = {
  verdict: 'TIGHTEN_AT_OPEN',
  confidence: 'medium',
  thesisStatus: 'WEAKENING',
  overnightRisk: 'one session to expiry and ₹1,312 of theta overnight against a long call',
  changeMindLevel: 'an open above 25150 on the spot',
  openPlan: 'if it gaps below 24950, exit; if it opens above 25150, hold with a stop at 25020',
  evidence: ['overnight.decay', 'overnight.expiry', 'structure.nearestSupport'],
};

const reply = (obj: unknown) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

describe('SentinelAgentService.judgeOvernight — the overnight verdict set', () => {
  const create = jest.fn();
  const svc = new SentinelAgentService({ messages: { create } } as never);
  beforeEach(() => jest.clearAllMocks());

  it('stamps its own prompt version, distinct from the live one', () => {
    expect(svc.overnightPromptVersion).toBe('o4/t1');
    expect(svc.overnightPromptVersion).toBe(`${SENTINEL_OVERNIGHT_PROMPT_VERSION}/${THESIS_PROMPT_VERSION}`);
    expect(svc.overnightPromptVersion).not.toBe(svc.promptVersion);
  });

  it('parses each of the three overnight verdicts', async () => {
    for (const verdict of ['HOLD_OVERNIGHT', 'EXIT_AT_OPEN', 'TIGHTEN_AT_OPEN'] as const) {
      create.mockResolvedValueOnce(reply({ ...valid, verdict }));
      await expect(svc.judgeOvernight(packet)).resolves.toMatchObject({ verdict, openPlan: valid.openPlan });
    }
  });

  it('sends the overnight prompt and schema — never the live ones', async () => {
    create.mockResolvedValue(reply(valid));
    await svc.judgeOvernight(packet);
    const args = create.mock.calls[0][0];
    expect(args.system[0].text).toBe(SENTINEL_OVERNIGHT_SYSTEM_PROMPT);
    expect(args.system[0].text).not.toBe(SENTINEL_SYSTEM_PROMPT);
    expect(args.system[0].text).not.toBe(SENTINEL_SYSTEM_PROMPT_NO_CUES);
    expect(args.output_config.format.schema.properties.verdict.enum).toEqual([
      'HOLD_OVERNIGHT',
      'EXIT_AT_OPEN',
      'TIGHTEN_AT_OPEN',
    ]);
    expect(args.output_config.format.schema.required).toEqual(
      expect.arrayContaining(['overnightRisk', 'changeMindLevel', 'openPlan', 'evidence']),
    );
    expect(args.messages[0].content).toContain('overnight');
  });

  it('rejects a live-session verdict word in overnight mode', async () => {
    create.mockResolvedValue(reply({ ...valid, verdict: 'HOLD' }));
    await expect(svc.judgeOvernight(packet)).rejects.toThrow(/not an overnight verdict/);
  });

  it('rejects a verdict with no open plan, no overnight risk, or no change-of-mind level', async () => {
    for (const field of ['openPlan', 'overnightRisk', 'changeMindLevel'] as const) {
      create.mockResolvedValueOnce(reply({ ...valid, [field]: '  ' }));
      await expect(svc.judgeOvernight(packet)).rejects.toThrow(new RegExp(field));
    }
  });

  it('rejects a citation that is not in the packet', async () => {
    create.mockResolvedValue(reply({ ...valid, evidence: ['overnight.rsi'] }));
    await expect(svc.judgeOvernight(packet)).rejects.toThrow(/not in the packet/);
  });

  it('requires at least one overnight input among the citations', async () => {
    create.mockResolvedValue(reply({ ...valid, evidence: ['structure.nearestSupport', 'money.netPnl'] }));
    await expect(svc.judgeOvernight(packet)).rejects.toThrow(/overnight input/);
  });

  it('accepts a citation that reaches inside a nested overnight block', async () => {
    create.mockResolvedValue(reply({ ...valid, evidence: ['overnight.oi.pcr', 'overnight.marketCues.crudeOil'] }));
    await expect(svc.judgeOvernight(packet)).resolves.toMatchObject({ verdict: 'TIGHTEN_AT_OPEN' });
  });

  it('rejects EXIT_AT_OPEN at low confidence', async () => {
    create.mockResolvedValue(reply({ ...valid, verdict: 'EXIT_AT_OPEN', confidence: 'low' }));
    await expect(svc.judgeOvernight(packet)).rejects.toThrow(/EXIT_AT_OPEN/);
  });

  it('leaves live judge() untouched: a live verdict still parses with the live schema', async () => {
    create.mockResolvedValue(
      reply({
        verdict: 'HOLD',
        confidence: 'high',
        thesisStatus: 'INTACT',
        recoveryAvailable: true,
        reason: 'ok',
        evidence: ['money.netPnl'],
        invalidationPoint: 'x',
        reviewIn: 300,
      }),
    );
    await expect(svc.judge(live)).resolves.toMatchObject({ verdict: 'HOLD' });
    expect(create.mock.calls[0][0].system[0].text).toBe(SENTINEL_SYSTEM_PROMPT_NO_CUES);
  });

  describe('the overnight prompt names the overnight fields as they are', () => {
    it('names every overnight field and every market cue', () => {
      for (const key of Object.keys(overnight)) {
        expect({ key, named: SENTINEL_OVERNIGHT_SYSTEM_PROMPT.includes(`overnight.${key}`) }).toEqual({ key, named: true });
      }
      for (const key of Object.keys(overnight.marketCues)) {
        expect({ key, named: SENTINEL_OVERNIGHT_SYSTEM_PROMPT.includes(key) }).toEqual({ key, named: true });
      }
    });

    it('names every live packet field too, since the overnight packet carries them', () => {
      const groups = ['position', 'money', 'structure', 'flow', 'macro', 'news', 'session'] as const;
      const built = live as unknown as Record<string, Record<string, unknown>>;
      const missing = groups.flatMap((g) =>
        Object.keys(built[g])
          .filter((f) => {
            const line = SENTINEL_OVERNIGHT_SYSTEM_PROMPT.split('\n').find((l) => l.startsWith(`- ${g}: `));
            return !line || !line.includes(f);
          })
          .map((f) => `${g}.${f}`),
      );
      expect(missing).toEqual([]);
    });

    it('does not present underlyingChange as an overnight move, and explains cue bases', () => {
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/underlyingChange is the underlying's last session close vs the session before[^.]*NOT an overnight move/);
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/previous session close/);
    });

    it('describes the 09:10 check, the IEP label, the futures-vs-futures GIFT gap and unpublished FII', () => {
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/PRE_OPEN_CHECK runs at 09:10/);
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/never the option's price/);
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/futures-vs-futures gap/);
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/not yet published/);
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).not.toMatch(/stub/);
    });

    it('tells the judge to weigh gap risk, OI build-up and theta against the open plan', () => {
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/gap/i);
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/build-up/i);
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/theta/i);
      expect(SENTINEL_OVERNIGHT_SYSTEM_PROMPT).toMatch(/cite/i);
    });
  });
});
