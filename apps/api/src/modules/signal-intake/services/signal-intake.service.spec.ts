import { AssistBusyError } from '../../ai-assist/assist-slot';
import type { ClusterRow } from '../domain/cluster';
import type { LlmParseReply } from '../domain/llm-schema';
import { buildVocabulary } from '../domain/vocabulary';
import type { ClassRow, NewSignal } from '../repositories/signal-intake.repository';
import { parseSignalIntakeConfig } from '../signal-intake.config';
import { SignalIntakeService, textHash, type IntakeStore } from './signal-intake.service';

/** In-memory stand-in for SignalIntakeRepository. */
function memStore() {
  const classes = new Map<string, ClassRow & { updatedAt: number }>();
  const signals: Array<NewSignal & { id: string; clusterId: string | null }> = [];
  const clusters: ClusterRow[] = [];
  const texts = new Map<string, string>();
  let seq = 0;
  const store: IntakeStore = {
    classOf: async (id) => (classes.get(id) ?? null) as never,
    saveClass: async (row) => void classes.set(row.messageId, { ...row, updatedAt: seq++ }),
    cachedLlm: async (hash) => [...classes.values()].reverse().find((c) => c.textHash === hash && c.llmResult)?.llmResult ?? null,
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
  return { store, classes, signals, clusters, texts };
}

const vocab = buildVocabulary(['RELIANCE-EQ', 'TATAMOTORS-EQ', 'SBIN-EQ']);
const T0 = new Date('2026-10-23T04:30:00Z'); // Fri 10:00 IST

function make(o: { llm?: jest.Mock; master?: unknown[] | null; now?: Date; env?: Record<string, string> } = {}) {
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
});
