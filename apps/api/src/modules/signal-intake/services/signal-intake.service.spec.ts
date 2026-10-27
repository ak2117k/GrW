import { AssistBusyError } from '../../ai-assist/assist-slot';
import type { ClusterRow } from '../domain/cluster';
import type { LlmParseReply, VisionReply } from '../domain/llm-schema';
import { buildVocabulary } from '../domain/vocabulary';
import type { ClassRow, InfoRow, NewSignal } from '../repositories/signal-intake.repository';
import { parseSignalIntakeConfig } from '../signal-intake.config';
import { SignalIntakeService, textHash, type IntakeStore } from './signal-intake.service';
import type { SignalInfoLlm } from './signal-parse-llm.service';
import type { SignalVision } from './signal-vision.service';

/** In-memory stand-in for SignalIntakeRepository. */
function memStore() {
  const classes = new Map<string, ClassRow & { updatedAt: number; classVersion?: number | null }>();
  const infos = new Map<string, InfoRow>();
  const refs = new Map<string, number>([['NIFTY', 22400]]);
  const signals: Array<NewSignal & { id: string; clusterId: string | null }> = [];
  const clusters: ClusterRow[] = [];
  const texts = new Map<string, string>();
  let seq = 0;
  const store: IntakeStore = {
    classOf: async (id) => (classes.get(id) ?? null) as never,
    saveClass: async (row) => void classes.set(row.messageId, { ...row, updatedAt: seq++, classVersion: 2 }),
    saveInfo: async (row) => void infos.set(row.messageId, { ...(infos.get(row.messageId) ?? {}), ...row }),
    cachedInfoLlm: async (hash) => [...infos.values()].find((i) => i.textHash === hash && i.llmReply)?.llmReply ?? null,
    refCloses: async () => new Map(refs),
    reclassCandidates: async (take = 200) =>
      [...classes.values()]
        .filter((c) => !c.classVersion && (c.status === 'NOISE' || c.status === 'VIEW' || (c.status === 'LLM_SKIPPED' && c.parser === 'vision')))
        .slice(0, take)
        .map((c) => ({ ...c, reason: c.reason ?? null, parser: c.parser ?? null, llmResult: c.llmResult ?? null, signalId: c.signalId ?? null, updateKind: c.updateKind ?? null, attempts: c.attempts ?? 0 })),
    cachedLlm: async (hash) => [...classes.values()].reverse().find((c) => c.textHash === hash && c.llmResult)?.llmResult ?? null,
    cachedVision: async (sha) => [...classes.values()].reverse().find((c) => (c.llmResult as { imageSha256?: string } | undefined)?.imageSha256 === sha)?.llmResult ?? null,
    llmPending: async (since) => [...classes.values()].filter((c) => c.status === 'LLM_PENDING' && c.postedAt >= since).map((c) => ({ ...c, attempts: c.attempts ?? 0 })) as never,
    messageText: async (id) => texts.get(id) ?? null,
    duplicateOf: async (key, since) => signals.filter((s) => s.dedupKey === key && s.receivedAt >= since).at(-1)?.id ?? null,
    signalByMessage: async (id) => (signals.find((s) => s.messageId === id) ?? null) as never,
    createSignal: async (s) => {
      const id = `sig${signals.length + 1}`;
      signals.push({ ...s, id, clusterId: null });
      return id;
    },
    updateSignal: async (id, s) => void Object.assign(signals.find((x) => x.id === id)!, s),
    setSignalCluster: async (id, clusterId) => void (signals.find((x) => x.id === id)!.clusterId = clusterId),
    clusters: async (u, d, since) => clusters.filter((c) => c.underlying === u && c.direction === d && c.windowStart >= since),
    recentSignals: async (u, since) =>
      signals.filter((s) => s.underlying === u && s.receivedAt >= since).map((s) => ({ id: s.id, channelId: s.channelId, direction: s.direction, receivedAt: s.receivedAt, clusterId: s.clusterId })),
    createCluster: async (c) => {
      const id = `cl${clusters.length + 1}`;
      clusters.push({ ...c, id });
      return id;
    },
    updateCluster: async (c) => void Object.assign(clusters.find((x) => x.id === c.id)!, c),
    flagConflict: async (ids) => clusters.filter((c) => ids.includes(c.id)).forEach((c) => (c.conflict = true)),
    signalsByIds: async (ids) => signals.filter((s) => ids.includes(s.id)).reverse() as never,
    latestInChannel: async (ch, since) => signals.filter((s) => s.channelId === ch && s.receivedAt >= since).reverse() as never,
  };
  return { store, classes, signals, clusters, texts, infos, refs };
}

const vocab = buildVocabulary(['RELIANCE-EQ', 'TATAMOTORS-EQ', 'SBIN-EQ']);
const T0 = new Date('2026-10-23T04:30:00Z'); // Fri 10:00 IST

function make(o: { llm?: jest.Mock; master?: unknown[] | null; now?: Date; env?: Record<string, string>; vision?: SignalVision; infoLlm?: SignalInfoLlm } = {}) {
  const mem = memStore();
  const emitted: Array<[string, Record<string, unknown>]> = [];
  const llm = o.llm ?? jest.fn(async (): Promise<LlmParseReply> => ({ isSignal: false, signals: [] }));
  let now = o.now ?? new Date(T0.getTime() + 60_000);
  const svc = new SignalIntakeService(
    mem.store,
    { get: async () => vocab },
    { rows: async () => (o.master === undefined ? null : o.master) },
    { parse: llm },
    parseSignalIntakeConfig(o.env ?? {}),
    { emit: (e: string, p: unknown) => emitted.push([e, p as Record<string, unknown>]) },
    () => now,
    o.vision,
    o.infoLlm,
  );
  const msg = (id: string, channelId: string, text: string, atMin = 0) => ({
    messageId: id, channelId, text, postedAt: new Date(T0.getTime() + atMin * 60_000), hasMedia: false,
  });
  return { svc, mem, emitted, llm, msg, setNow: (d: Date) => (now = d) };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('SignalIntakeService', () => {
  it('chatter is stored as NOISE with the pre-filter reason; no LLM, no event', async () => {
    const { svc, mem, emitted, llm, msg } = make();
    await svc.handle(msg('m1', 'A', 'Good morning traders 🙏'));
    await svc.handle(msg('m2', 'A', 'Join our VIP group, fees 4999, whatsapp 9876543210'));
    expect(mem.classes.get('m1')).toMatchObject({ status: 'NOISE', reason: 'no-instrument' });
    expect(mem.classes.get('m2')).toMatchObject({ status: 'NOISE' });
    expect(llm).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('a rule-parsed call → TradeSignal + cluster of one + signal.ready; expiry by the calendar rule without the master', async () => {
    const { svc, mem, emitted, llm, msg } = make();
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160/200'));
    expect(llm).not.toHaveBeenCalled();
    expect(mem.signals).toHaveLength(1);
    expect(mem.signals[0]).toMatchObject({
      parser: 'rule', underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, side: 'BUY', direction: 'BULL', entryType: 'ABOVE',
      entryLow: 120, sl: 100, targets: [140, 160, 200], expiry: '2026-10-27', expirySource: 'rule', sessionDate: '2026-10-23', token: null,
    });
    expect(mem.classes.get('m1')).toMatchObject({ status: 'SIGNAL', parser: 'rule', signalId: 'sig1' });
    expect(emitted).toEqual([['signal.ready', { signalId: 'sig1', clusterId: 'cl1', agreeCount: 1, conflict: false }]]);
  });

  it('master expiries + token are used when the master is available', async () => {
    const master = [
      { exch_seg: 'NFO', name: 'NIFTY', instrumenttype: 'OPTIDX', symbol: 'NIFTY27OCT2624000CE', expiry: '27OCT2026', strike: '2400000.000000', token: '111' },
      { exch_seg: 'NFO', name: 'NIFTY', instrumenttype: 'OPTIDX', symbol: 'NIFTY03NOV2624000CE', expiry: '03NOV2026', strike: '2400000.000000', token: '222' },
    ];
    const { svc, mem, msg } = make({ master });
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    expect(mem.signals[0]).toMatchObject({ expiry: '2026-10-27', expirySource: 'master', exchange: 'NFO', token: '111', tradingsymbol: 'NIFTY27OCT2624000CE' });
  });

  it('a second channel agreeing inside 30 min corroborates: agreeCount 2, the earlier signal is re-emitted', async () => {
    const { svc, mem, emitted, msg } = make();
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    await svc.handle(msg('m2', 'B', 'Nifty 24100 CE buy 150-155 sl 130 target 180', 10));
    expect(mem.clusters).toHaveLength(1);
    expect(mem.clusters[0]).toMatchObject({ agreeCount: 2, channelIds: ['A', 'B'], conflict: false });
    expect(emitted.slice(1)).toEqual([
      ['signal.ready', { signalId: 'sig2', clusterId: 'cl1', agreeCount: 2, conflict: false }],
      ['signal.ready', { signalId: 'sig1', clusterId: 'cl1', agreeCount: 2, conflict: false }],
    ]);
  });

  it('an opposite call in the window flags conflict on both clusters', async () => {
    const { svc, mem, emitted, msg } = make();
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    await svc.handle(msg('m2', 'B', 'BUY NIFTY 24000 PE ABOVE 90 SL 75 TGT 110', 5));
    expect(mem.clusters.map((c) => [c.direction, c.conflict])).toEqual([['BULL', true], ['BEAR', true]]);
    expect(emitted.at(-1)).toEqual(['signal.ready', { signalId: 'sig2', clusterId: 'cl2', agreeCount: 1, conflict: true }]);
  });

  it('dedup: a repost in the same channel and a repeated event never count twice', async () => {
    const { svc, mem, emitted, msg } = make();
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140')); // same event twice
    await svc.handle(msg('m2', 'A', '🔥 Repeat: NIFTY 24000 CE buy above 120, SL 100, target 140', 3)); // repost
    expect(mem.signals).toHaveLength(1);
    expect(mem.classes.get('m2')).toMatchObject({ status: 'DUPLICATE', signalId: 'sig1' });
    expect(mem.clusters[0].agreeCount).toBe(1);
    expect(emitted).toHaveLength(1);
  });

  it('an edit corrects the stored signal in place, no new signal, no re-emit', async () => {
    const { svc, mem, emitted, msg } = make();
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    await svc.handle({ ...msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 125 SL 105 TGT 150'), edited: true } as never);
    expect(mem.signals).toHaveLength(1);
    expect(mem.signals[0]).toMatchObject({ entryLow: 125, sl: 105, targets: [150] });
    expect(mem.classes.get('m1')).toMatchObject({ status: 'SIGNAL', reason: 'edited', textHash: textHash('BUY NIFTY 24000 CE ABOVE 125 SL 105 TGT 150') });
    expect(emitted).toHaveLength(1);
  });

  it('updates link to the channel’s earlier signal and emit signal.update (not a new signal)', async () => {
    const { svc, mem, emitted, msg } = make();
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160'));
    await svc.handle(msg('m2', 'B', 'BUY BANKNIFTY 52000 PE ABOVE 300 SL 270 TGT 350', 1));
    await svc.handle(msg('m3', 'A', 'Target 1 done ✅✅', 20));
    await svc.handle(msg('m4', 'A', 'trail SL to cost', 21));
    await svc.handle(msg('m5', 'C', 'SL hit', 22)); // channel C never posted a call
    expect(mem.signals).toHaveLength(2);
    expect(mem.classes.get('m3')).toMatchObject({ status: 'UPDATE', updateKind: 'TARGET_HIT', signalId: 'sig1' });
    expect(mem.classes.get('m5')).toMatchObject({ status: 'UPDATE_ORPHAN' });
    const updates = emitted.filter(([e]) => e === 'signal.update').map(([, p]) => [p.signalId, p.kind, p.targetIndex]);
    expect(updates).toEqual([['sig1', 'TARGET_HIT', 1], ['sig1', 'TRAIL_SL', null]]);
  });

  it('an update naming a contract picks that signal, not just the latest', async () => {
    const { svc, mem, msg } = make();
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    await svc.handle(msg('m2', 'A', 'BUY BANKNIFTY 52000 PE ABOVE 300 SL 270 TGT 350', 2));
    await svc.handle(msg('m3', 'A', 'NIFTY 24000 CE SL hit', 30));
    expect(mem.classes.get('m3')).toMatchObject({ status: 'UPDATE', updateKind: 'SL_HIT', signalId: 'sig1' });
  });

  it('LLM fallback only for a pre-filter positive the rules cannot parse; result validated, cached by text hash', async () => {
    const reply: LlmParseReply = {
      isSignal: true,
      signals: [{ underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, expiry: null, side: 'BUY', entryType: 'AT', entryLow: 120, entryHigh: 120, sl: 100, targets: [150], qty: null, horizon: 'INTRADAY', confidence: 0.8 }],
    };
    const llm = jest.fn(async () => reply);
    const { svc, mem, emitted, msg } = make({ llm });
    const text = 'NIFTY 24000 CE 120 wala lelo, 100 ka stop, 150 tak jayega';
    await svc.handle(msg('m1', 'A', text));
    await flush();
    await svc.handle(msg('x', 'A', 'BUY NIFTY 24100 CE ABOVE 120 SL 100 TGT 140', 1)); // drain the chain
    expect(llm).toHaveBeenCalledTimes(1);
    expect(mem.signals[0]).toMatchObject({ parser: 'llm', entryType: 'AT', entryLow: 120, sl: 100, targets: [150], tags: ['LLM'] });
    expect(mem.classes.get('m1')).toMatchObject({ status: 'SIGNAL', parser: 'llm' });
    expect(emitted[0]).toEqual(['signal.ready', expect.objectContaining({ signalId: 'sig1' })]);

    // Same text in another channel: served from the cache, no second call.
    await svc.handle(msg('m2', 'B', text, 2));
    expect(llm).toHaveBeenCalledTimes(1);
    expect(mem.classes.get('m2')).toMatchObject({ status: 'SIGNAL', parser: 'llm' });
  });

  it('LLM says not a signal → LLM_NOT_SIGNAL; an invalid extraction is refused', async () => {
    const llm = jest
      .fn()
      .mockResolvedValueOnce({ isSignal: false, signals: [] })
      .mockResolvedValueOnce({ isSignal: true, signals: [{ underlying: 'NIFTY', instrumentKind: 'CE', strike: 24000, side: 'BUY', entryType: 'AT', entryLow: 120, entryHigh: 120, sl: 130, targets: [], horizon: 'INTRADAY', confidence: 0.9 }] });
    const { svc, mem, msg } = make({ llm });
    await svc.handle(msg('m1', 'A', 'Nifty may bounce, buy only above 24050 and 24100 confirmation'));
    await flush();
    await svc.handle(msg('m2', 'A', 'NIFTY 24000 CE 120 wala lelo, 130 ka stop', 1));
    await flush();
    await svc.handle(msg('z', 'A', 'Good night', 2));
    expect(mem.classes.get('m1')).toMatchObject({ status: 'LLM_NOT_SIGNAL' });
    expect(mem.classes.get('m2')).toMatchObject({ status: 'LLM_NOT_SIGNAL', reason: expect.stringContaining('sl on the wrong side') });
    expect(mem.signals).toHaveLength(0);
  });

  it('no LLM when disabled, for history, or over the daily cap', async () => {
    const llm = jest.fn(async () => ({ isSignal: false, signals: [] }));
    const off = make({ llm, env: { SIGNAL_PARSE_LLM: 'off' } });
    await off.svc.handle(off.msg('m1', 'A', 'NIFTY 24000 CE 120 wala lelo, 100 ka stop'));
    expect(off.mem.classes.get('m1')).toMatchObject({ status: 'LLM_SKIPPED' });

    const old = make({ llm, now: new Date(T0.getTime() + 3 * 3_600_000) });
    await old.svc.handle(old.msg('m1', 'A', 'NIFTY 24000 CE 120 wala lelo, 100 ka stop'));
    expect(old.mem.classes.get('m1')).toMatchObject({ status: 'LLM_SKIPPED', reason: expect.stringContaining('too old') });

    const cap = make({ llm, env: { SIGNAL_PARSE_LLM_DAILY_CAP: '1' } });
    await cap.svc.handle(cap.msg('m1', 'A', 'NIFTY 24000 CE 120 wala lelo, 100 ka stop'));
    await flush();
    await cap.svc.handle(cap.msg('m2', 'A', 'BANKNIFTY 52000 PE 300 wala lelo, 270 ka stop', 1));
    expect(cap.mem.classes.get('m2')).toMatchObject({ status: 'LLM_SKIPPED', reason: expect.stringContaining('daily LLM cap') });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('a busy shared slot leaves the message LLM_PENDING for the retry sweep', async () => {
    const llm = jest.fn().mockRejectedValueOnce(new AssistBusyError(45_000)).mockResolvedValueOnce({ isSignal: false, signals: [] });
    const { svc, mem, msg } = make({ llm });
    const text = 'NIFTY 24000 CE 120 wala lelo, 100 ka stop';
    mem.texts.set('m1', text);
    await svc.handle(msg('m1', 'A', text));
    await flush();
    await svc.handle(msg('z', 'A', 'Good night', 1));
    expect(mem.classes.get('m1')).toMatchObject({ status: 'LLM_PENDING', attempts: 1 });
    expect(await svc.retryPending()).toBe(1);
    await flush();
    await svc.handle(msg('z2', 'A', 'Good night', 2));
    expect(mem.classes.get('m1')).toMatchObject({ status: 'LLM_NOT_SIGNAL' });
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('history (older than SIGNAL_READY_MAX_AGE_MIN) is stored and clustered but not emitted to X', async () => {
    const { svc, mem, emitted, msg } = make({ now: new Date(T0.getTime() + 2 * 3_600_000) });
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    expect(mem.signals).toHaveLength(1);
    expect(emitted).toEqual([]);
  });

  it('SIGNAL_INTAKE=off does nothing', async () => {
    const { svc, mem, msg } = make({ env: { SIGNAL_INTAKE: 'off' } });
    await svc.handle(msg('m1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    expect(mem.classes.size).toBe(0);
  });

  it('commentary is INFO (was VIEW): stored, no LLM, no event (prod 2026-10-23 Nifty IT post)', async () => {
    const { svc, mem, emitted, llm, msg } = make();
    await svc.handle(msg('m1', 'A', 'Nifty IT near resistance area. A monthly close above 33000- 33400 levels needed! Volatile time ahead!'));
    await svc.handle(msg('m2', 'A', 'NIFTY near resistance 26200, weekly close above 26200-26300 needed', 1));
    expect(mem.classes.get('m1')).toMatchObject({ status: 'INFO', reason: 'sector index (no derivatives)' });
    expect(mem.classes.get('m2')).toMatchObject({ status: 'INFO', reason: expect.stringContaining('info') });
    expect(mem.infos.get('m1')).toBeUndefined(); // a sector index has no tradeable item
    expect(mem.infos.get('m2')).toMatchObject({ items: [expect.objectContaining({ underlying: 'NIFTY', bias: 'NEUTRAL', levels: [26200, 26300] })] });
    expect(mem.signals).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
});

describe('SignalIntakeService — image posts (vision)', () => {
  const IMG = { kind: 'photo' as const, path: '/data/x.jpg', sha256: 'a'.repeat(64), mimeType: 'image/jpeg', bytes: 90_000 };
  const call = { underlying: 'CRUDEOIL', instrumentKind: 'CE', strike: 5600, expiry: null, side: 'BUY', entryType: 'ABOVE', entryLow: 142, entryHigh: 142, sl: 120, targets: [160, 180], qty: null, horizon: 'INTRADAY', confidence: 0.8 };

  function fakeVision(reply: VisionReply | (() => Promise<VisionReply>), o: { used?: number; unavailable?: string | null } = {}) {
    const classify = jest.fn(typeof reply === 'function' ? reply : async () => reply);
    const v = { unavailable: () => o.unavailable ?? null, usedSince: jest.fn(async () => o.used ?? 0), classify };
    return { v: v as SignalVision & typeof v, classify };
  }
  const img = (m: ReturnType<typeof make>, id: string, ch: string, text = '', atMin = 0, media = IMG) => ({ ...m.msg(id, ch, text, atMin), hasMedia: true, media });

  it('an image-only call → vision SIGNAL → TradeSignal (tag VISION) + signal.ready', async () => {
    const { v, classify } = fakeVision({ kind: 'SIGNAL', isSignal: true, signals: [call] });
    const m = make({ vision: v });
    await m.svc.handle(img(m, 'm1', 'A'));
    await flush();
    await m.svc.handle(m.msg('z', 'A', 'Good night', 1)); // drain the chain
    expect(classify).toHaveBeenCalledWith('', IMG);
    expect(m.mem.signals[0]).toMatchObject({ parser: 'llm', underlying: 'CRUDEOIL', strike: 5600, sl: 120, tags: ['LLM', 'VISION'] });
    expect(m.mem.classes.get('m1')).toMatchObject({ status: 'SIGNAL', llmResult: expect.objectContaining({ kind: 'SIGNAL', imageSha256: IMG.sha256 }) });
    expect(m.emitted[0]).toEqual(['signal.ready', expect.objectContaining({ signalId: 'sig1' })]);
  });

  it.each([
    ['VIEW', 'INFO'],
    ['INFO', 'INFO'],
    ['NOISE', 'NOISE'],
    ['UPDATE', 'UPDATE_ORPHAN'],
  ] as const)('kind %s is stored as %s and never emitted', async (kind, status) => {
    const { v } = fakeVision({ kind, isSignal: false, signals: [] });
    const m = make({ vision: v });
    await m.svc.handle(img(m, 'm1', 'A', 'Crude chart for today'));
    await flush();
    await m.svc.handle(m.msg('z', 'A', 'Good night', 1));
    expect(m.mem.classes.get('m1')).toMatchObject({ status, parser: 'vision' });
    expect(m.mem.signals).toHaveLength(0);
    expect(m.emitted).toEqual([]);
  });

  it('a caption that is itself a call is parsed by the rules; the image is not sent', async () => {
    const { v, classify } = fakeVision({ kind: 'NOISE', isSignal: false, signals: [] });
    const m = make({ vision: v });
    await m.svc.handle(img(m, 'm1', 'A', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140'));
    expect(classify).not.toHaveBeenCalled();
    expect(m.mem.classes.get('m1')).toMatchObject({ status: 'SIGNAL', parser: 'rule' });
  });

  it('cached by image sha256: the same image in another channel costs no second call', async () => {
    const { v, classify } = fakeVision({ kind: 'SIGNAL', isSignal: true, signals: [call] });
    const m = make({ vision: v });
    await m.svc.handle(img(m, 'm1', 'A'));
    await flush();
    await m.svc.handle(img(m, 'm2', 'B', '', 2));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(m.mem.classes.get('m2')).toMatchObject({ status: 'SIGNAL' });
    expect(m.mem.clusters[0]).toMatchObject({ agreeCount: 2 });
  });

  it('daily cap counts ai_calls signal.vision rows since IST midnight; at the cap the image is skipped', async () => {
    const { v, classify } = fakeVision({ kind: 'NOISE', isSignal: false, signals: [] }, { used: 40 });
    const m = make({ vision: v });
    await m.svc.handle(img(m, 'm1', 'A'));
    expect(v.usedSince).toHaveBeenCalledWith(new Date('2026-10-22T18:30:00Z'));
    expect(classify).not.toHaveBeenCalled();
    expect(m.mem.classes.get('m1')).toMatchObject({ status: 'LLM_SKIPPED', reason: 'daily vision cap 40 reached' });
  });

  it('the in-process count caps too when ai_calls lags (SIGNAL_VISION_DAILY_CAP=1)', async () => {
    const { v, classify } = fakeVision({ kind: 'NOISE', isSignal: false, signals: [] });
    const m = make({ vision: v, env: { SIGNAL_VISION_DAILY_CAP: '1' } });
    await m.svc.handle(img(m, 'm1', 'A'));
    await flush();
    await m.svc.handle(img(m, 'm2', 'A', '', 1, { ...IMG, sha256: 'b'.repeat(64) }));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(m.mem.classes.get('m2')).toMatchObject({ status: 'LLM_SKIPPED', reason: expect.stringContaining('daily vision cap') });
  });

  it('images older than 60 min are never sent', async () => {
    const { v, classify } = fakeVision({ kind: 'NOISE', isSignal: false, signals: [] });
    const m = make({ vision: v, now: new Date(T0.getTime() + 61 * 60_000) });
    await m.svc.handle(img(m, 'm1', 'A'));
    expect(classify).not.toHaveBeenCalled();
    expect(m.mem.classes.get('m1')).toMatchObject({ status: 'LLM_SKIPPED', reason: expect.stringContaining('too old') });
  });

  it('transport unavailable: the image is skipped with the reason; the caption is still classified', async () => {
    const { v, classify } = fakeVision({ kind: 'NOISE', isSignal: false, signals: [] }, { unavailable: 'SENTINEL_JUDGE=api but no ANTHROPIC_API_KEY' });
    const m = make({ vision: v });
    await m.svc.handle(img(m, 'm1', 'A'));
    await m.svc.handle(img(m, 'm2', 'A', 'Nifty IT near resistance, monthly close above 33000 needed', 1));
    expect(classify).not.toHaveBeenCalled();
    expect(m.mem.classes.get('m1')).toMatchObject({ status: 'LLM_SKIPPED', reason: expect.stringContaining('no ANTHROPIC_API_KEY') });
    expect(m.mem.classes.get('m2')).toMatchObject({ status: 'INFO' });
  });

  it('SIGNAL_VISION=off and no vision port behave like unavailable', async () => {
    const a = make({ env: { SIGNAL_VISION: 'off' }, vision: fakeVision({ kind: 'NOISE', isSignal: false, signals: [] }).v });
    await a.svc.handle(img(a, 'm1', 'A'));
    expect(a.mem.classes.get('m1')).toMatchObject({ status: 'LLM_SKIPPED', reason: 'image not read: SIGNAL_VISION=off' });
    const b = make();
    await b.svc.handle(img(b, 'm1', 'A'));
    expect(b.mem.classes.get('m1')).toMatchObject({ status: 'LLM_SKIPPED', reason: 'image not read: no vision transport' });
  });

  it('a failed read is LLM_FAILED (parser vision) and is never retried as a text parse', async () => {
    const { v } = fakeVision(async () => {
      throw new Error('claude CLI: timed out');
    });
    const m = make({ vision: v });
    await m.svc.handle(img(m, 'm1', 'A'));
    await flush();
    await m.svc.handle(m.msg('z', 'A', 'Good night', 1));
    expect(m.mem.classes.get('m1')).toMatchObject({ status: 'LLM_FAILED', parser: 'vision', reason: expect.stringContaining('timed out') });
    expect(await m.svc.retryPending()).toBe(0);
    expect(m.llm).not.toHaveBeenCalled();
  });

  it('an invalid extraction from the image is refused', async () => {
    const { v } = fakeVision({ kind: 'SIGNAL', isSignal: true, signals: [{ ...call, sl: 150 }] });
    const m = make({ vision: v });
    await m.svc.handle(img(m, 'm1', 'A'));
    await flush();
    await m.svc.handle(m.msg('z', 'A', 'Good night', 1));
    expect(m.mem.classes.get('m1')).toMatchObject({ status: 'LLM_NOT_SIGNAL', reason: expect.stringContaining('sl on the wrong side') });
    expect(m.emitted).toEqual([]);
  });
});

describe('SignalIntakeService — INFO / RECAP (owner 2026-10-24)', () => {
  const EX = {
    crude: 'AGAR CRUDE OIL AISE HE CHALTA RAHA TOH 110-120$ DUR NAHI   NIFTY 21000 SE DUR NAHI   CRUDE OIL KO RUKNA PADEGA',
    oi: 'Mai khud put lene wala tha   But mai kabhi OI k against nahi jata  22400 pe itna heavy tha k put me ghuse he nahi aur ye natak hua up me toh bach gya',
    caption: '22400 ki put oi dekho 3x hai . matlab ye sab upar fakne k liye aye hai',
    usoil: "I don't want to put you in tension but if US oil keep on rising thn 22000 ke niche you'll see a panic selling and it will be brutal 😞. Next few months are real test...",
    recap: 'Live Analysis of 23th OCT\nBANKNIFTY 52000CE 180 TO 260\nMIDCP 13100CE 109 TO 70',
  };
  const fakeInfoLlm = (reply: unknown = { isInfo: true, items: [] }, used = 0) => {
    const info = jest.fn(async () => reply as never);
    return { port: { info, usedSince: jest.fn(async () => used) } as SignalInfoLlm, info };
  };

  it('the four owner examples are INFO with items (crude + NIFTY = 2 items), the recap is RECAP; no LLM, no event', async () => {
    const { port, info } = fakeInfoLlm();
    const { svc, mem, emitted, llm, msg } = make({ infoLlm: port });
    await svc.handle(msg('m1', 'A', EX.crude));
    await svc.handle(msg('m2', 'A', EX.oi, 1));
    await svc.handle(msg('m3', 'A', EX.usoil, 2));
    await svc.handle(msg('m4', 'A', EX.recap, 3));
    for (const id of ['m1', 'm2', 'm3']) expect(mem.classes.get(id)).toMatchObject({ status: 'INFO', parser: 'rule' });
    expect(mem.classes.get('m4')).toMatchObject({ status: 'RECAP' });
    expect(mem.infos.get('m1')?.items).toEqual([
      { underlying: 'CRUDEOIL', bias: 'BULL', levels: [110, 120], targetLevel: 110, oi: null, condition: null, horizon: null, kind: 'VIEW' },
      { underlying: 'NIFTY', bias: 'BEAR', levels: [21000], targetLevel: 21000, oi: null, condition: { driver: 'CRUDE', direction: 'UP' }, horizon: null, kind: 'VIEW' },
    ]);
    expect(mem.infos.get('m2')?.items).toEqual([expect.objectContaining({ underlying: 'NIFTY', bias: 'BULL', oi: { strike: 22400, side: 'PE', note: 'put OI heavy → support' } })]);
    expect(mem.infos.get('m3')?.items).toEqual([expect.objectContaining({ underlying: 'NIFTY', bias: 'BEAR', levels: [22000], condition: { driver: 'CRUDE', direction: 'UP' }, horizon: 'MONTHS' })]);
    expect(mem.infos.get('m1')).toMatchObject({ extractor: 'rule', sessionDate: '2026-10-23', channelId: 'A' });
    expect(info).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(mem.signals).toHaveLength(0);
  });

  it('an image whose caption carries the view is INFO from the caption; the image is not read', async () => {
    const classify = jest.fn();
    const vision = { unavailable: () => null, usedSince: jest.fn(async () => 0), classify } as unknown as SignalVision;
    const m = make({ vision });
    const media = { kind: 'photo' as const, path: '/x.jpg', sha256: 'c'.repeat(64), mimeType: 'image/jpeg', bytes: 1000 };
    await m.svc.handle({ ...m.msg('m1', 'A', EX.caption), hasMedia: true, media });
    expect(classify).not.toHaveBeenCalled();
    expect(m.mem.classes.get('m1')).toMatchObject({ status: 'INFO' });
    expect(m.mem.infos.get('m1')?.items).toEqual([
      { underlying: 'NIFTY', bias: 'BULL', levels: [22400], targetLevel: null, oi: { strike: 22400, side: 'PE', note: 'put OI 3x → support' }, condition: null, horizon: null, kind: 'VIEW' },
    ]);
  });

  it('a vision INFO reply stores the model items (extractor llm)', async () => {
    const reply = { kind: 'INFO', isSignal: false, signals: [], items: [{ underlying: 'NIFTY', bias: 'BEAR', levels: [22000], targetLevel: null, oiStrike: null, oiSide: null, oiNote: null, conditionDriver: null, conditionDirection: null, horizon: 'DAYS' }] };
    const vision = { unavailable: () => null, usedSince: jest.fn(async () => 0), classify: jest.fn(async () => reply) } as unknown as SignalVision;
    const m = make({ vision });
    await m.svc.handle({ ...m.msg('m1', 'A', 'chart dekho'), hasMedia: true, media: { kind: 'photo' as const, path: '/y.jpg', sha256: 'd'.repeat(64), mimeType: 'image/jpeg', bytes: 1000 } });
    await flush();
    await m.svc.handle(m.msg('z', 'A', 'Good night', 1));
    expect(m.mem.classes.get('m1')).toMatchObject({ status: 'INFO', parser: 'vision' });
    expect(m.mem.infos.get('m1')).toMatchObject({ extractor: 'llm', items: [expect.objectContaining({ underlying: 'NIFTY', bias: 'BEAR', horizon: 'DAYS' })] });
  });

  it('real noise and ads stay NOISE, even when an ad names NIFTY', async () => {
    const { svc, mem, msg } = make();
    const noise = ['Good morning guys 🙏🏻 Have a great weekend', "OCT BATCH is open … What's app us", 'TODAY BIG OFFER … paid group', 'JOIN EVENING LIVE: youtube', 'LAST 15 DAYS PNL 46,60,239 ++ PROFIT BOOK', 'NIFTY 1000 points jackpot — join premium'];
    for (const [i, t] of noise.entries()) await svc.handle(msg(`n${i}`, 'A', t, i));
    for (let i = 0; i < noise.length; i++) expect(mem.classes.get(`n${i}`)).toMatchObject({ status: 'NOISE' });
    expect(mem.infos.size).toBe(0);
  });

  it('the cheap-LLM fallback runs only when the detector says INFO and no item has a bias; cached by text; validated', async () => {
    const reply = { isInfo: true, items: [{ underlying: 'NIFTY', bias: 'BEAR', levels: [22000], targetLevel: null, oiStrike: null, oiSide: null, oiNote: null, conditionDriver: null, conditionDirection: null, horizon: null }] };
    const { port, info } = fakeInfoLlm(reply);
    const { svc, mem, msg } = make({ infoLlm: port });
    await svc.handle(msg('b1', 'A', 'Banknifty bearish below 51000')); // has a bias → no LLM
    expect(info).not.toHaveBeenCalled();
    await svc.handle(msg('m1', 'A', 'Nifty 22000 pe kya hoga dekhte hai', 1)); // INFO, no bias → LLM
    await flush();
    await svc.handle(msg('z', 'A', 'Good night', 2));
    expect(info).toHaveBeenCalledTimes(1);
    expect(mem.infos.get('m1')).toMatchObject({ extractor: 'llm', items: [expect.objectContaining({ underlying: 'NIFTY', bias: 'BEAR' })], llmReply: reply });
    expect(mem.classes.get('m1')).toMatchObject({ status: 'INFO', parser: 'llm', reason: expect.stringContaining('llm (llm)') });
    await svc.handle(msg('m2', 'B', 'Nifty 22000 pe kya hoga dekhte hai', 3)); // same text: the cache
    expect(info).toHaveBeenCalledTimes(1);
    expect(mem.infos.get('m2')).toMatchObject({ extractor: 'llm' });
  });

  it('no INFO LLM for posts older than 6 h, when off, or over SIGNAL_INFO_LLM_DAILY_CAP (counted from ai_calls)', async () => {
    const text = 'Nifty 22000 pe kya hoga dekhte hai';
    const a = fakeInfoLlm();
    const old = make({ infoLlm: a.port, now: new Date(T0.getTime() + 7 * 3_600_000) });
    await old.svc.handle(old.msg('m1', 'A', text));
    const off = make({ infoLlm: a.port, env: { SIGNAL_INFO_LLM: 'off' } });
    await off.svc.handle(off.msg('m1', 'A', text));
    expect(a.info).not.toHaveBeenCalled();
    expect(old.mem.classes.get('m1')).toMatchObject({ status: 'INFO' });
    const b = fakeInfoLlm(undefined, 60);
    const cap = make({ infoLlm: b.port });
    await cap.svc.handle(cap.msg('m1', 'A', text));
    expect(b.port.usedSince).toHaveBeenCalledWith(new Date('2026-10-22T18:30:00Z'));
    expect(b.info).not.toHaveBeenCalled();
    expect(cap.mem.infos.get('m1')).toMatchObject({ extractor: 'rule', items: [expect.objectContaining({ underlying: 'NIFTY', bias: null })] });
  });

  it('a reference close decides "X se dur nahi": without one the index item stays unbiased and the LLM is asked', async () => {
    const { port, info } = fakeInfoLlm({ isInfo: false, items: [] });
    const m = make({ infoLlm: port });
    m.mem.refs.clear();
    await m.svc.handle(m.msg('m1', 'A', 'Sensex 80000 se dur nahi'));
    await flush();
    await m.svc.handle(m.msg('z', 'A', 'Good night', 1));
    expect(info).toHaveBeenCalledTimes(1);
    expect(m.mem.infos.get('m1')).toMatchObject({ extractor: 'rule', items: [expect.objectContaining({ underlying: 'SENSEX', bias: null, targetLevel: 80000 })] });
  });

  it('re-classification: stored NOISE / VIEW rows become INFO (+ items) or RECAP once; a second run changes nothing', async () => {
    const { port, info } = fakeInfoLlm();
    const m = make({ infoLlm: port });
    const old = (id: string, status: string, text: string, extra: Partial<ClassRow> = {}) => {
      m.mem.texts.set(id, text);
      m.mem.classes.set(id, { messageId: id, channelId: 'A', postedAt: T0, textHash: textHash(text), status: status as never, reason: 'no-action', updatedAt: 0, classVersion: null, ...extra });
    };
    old('o1', 'NOISE', EX.crude);
    old('o2', 'NOISE', EX.oi);
    old('o3', 'LLM_SKIPPED', EX.caption, { parser: 'vision', reason: 'image not read: SIGNAL_VISION=off' });
    old('o4', 'VIEW', EX.usoil, { reason: 'analysis: IF' });
    old('o5', 'VIEW', 'Nifty near resistance, monthly close needed', { reason: 'analysis: RESISTANCE' });
    old('o9', 'VIEW', '', { parser: 'vision', reason: 'vision (llm): image is a view', llmResult: { kind: 'VIEW', imageSha256: 'e'.repeat(64) } });
    old('o6', 'NOISE', EX.recap);
    old('o7', 'NOISE', 'Good morning guys 🙏🏻 Have a great weekend');
    old('o8', 'SIGNAL', 'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140', { signalId: 'sigX', reason: null });

    const first = await m.svc.reclassifyStored();
    expect(first).toEqual({ scanned: 8, info: 6, recap: 1, noise: 0, kept: 1 });
    expect(['o1', 'o2', 'o3', 'o4', 'o5', 'o9'].map((id) => m.mem.classes.get(id)?.status)).toEqual(['INFO', 'INFO', 'INFO', 'INFO', 'INFO', 'INFO']);
    expect(m.mem.classes.get('o3')).toMatchObject({ parser: 'vision' }); // the vision state is kept
    expect(m.mem.classes.get('o5')).toMatchObject({ reason: expect.stringContaining('info') });
    expect(m.mem.classes.get('o9')).toMatchObject({ parser: 'vision', reason: expect.stringContaining('migrated from VIEW'), llmResult: expect.objectContaining({ imageSha256: 'e'.repeat(64) }) });
    expect(m.mem.classes.get('o6')).toMatchObject({ status: 'RECAP' });
    expect(m.mem.classes.get('o7')).toMatchObject({ status: 'NOISE', reason: 'no-action' });
    expect(m.mem.classes.get('o8')).toMatchObject({ status: 'SIGNAL', signalId: 'sigX' }); // never touched
    expect(m.mem.infos.get('o1')?.items).toHaveLength(2);
    expect(m.mem.infos.get('o3')?.items).toEqual([expect.objectContaining({ underlying: 'NIFTY', bias: 'BULL' })]);
    expect(m.mem.infos.get('o4')?.items).toEqual([expect.objectContaining({ underlying: 'NIFTY', bias: 'BEAR', horizon: 'MONTHS' })]);
    expect(info).not.toHaveBeenCalled(); // never an LLM for history
    expect(m.emitted).toEqual([]);

    const snapshot = JSON.stringify([...m.mem.classes.entries()].map(([k, v]) => [k, v.status, v.reason]));
    const second = await m.svc.reclassifyStored();
    expect(second).toEqual({ scanned: 0, info: 0, recap: 0, noise: 0, kept: 0 });
    expect(JSON.stringify([...m.mem.classes.entries()].map(([k, v]) => [k, v.status, v.reason]))).toBe(snapshot);

    const disabled = make({ env: { SIGNAL_INFO_RECLASSIFY: 'off' } });
    expect(await disabled.svc.reclassifyStored()).toEqual({ scanned: 0, info: 0, recap: 0, noise: 0, kept: 0 });
  });
});
