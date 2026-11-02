import { AssistBusyError } from '../../ai-assist/assist-slot';
import type { ImageSetupExtraction } from '../domain/image-setup';
import { buildVocabulary } from '../domain/vocabulary';
import { parseImageSetupConfig } from '../image-setup.config';
import type { ImageReadRow, ImageReadStore } from '../repositories/image-read.repository';
import type { ImageSetupReader } from './image-setup-reader.service';
import { ImageSetupService, type ImageSignalSink } from './image-setup.service';

const CH = 'cmvkyxugk01kutd01df3yclc6';
const vocab = buildVocabulary(['RELIANCE-EQ']);
const PHOTO = { kind: 'photo' as const, path: '/app/data/telegram-media/2026-11/x.jpg', sha256: 'd'.repeat(64), mimeType: 'image/jpeg', bytes: 97_000 };
/** Posted 14:35 IST on 2026-11-02. */
const POSTED = new Date('2026-11-02T09:05:00Z');

const SHORT: ImageSetupExtraction = {
  kind: 'NEW_SETUP',
  instrument: { raw: 'NIFTY 03 NOV 2026 23200 PE · NSE FO', underlying: 'NIFTY', expiry: '2026-11-03', strike: 23200, optionType: 'PE', exchange: 'NSE FO' },
  side: 'SELL',
  entry: 87.55,
  stopLoss: 100.5,
  targets: [48],
  currentPrice: 85,
  chartTimeframe: '1m',
  screenshotClock: '2:31',
  tool: 'position_tool',
  confidence: 0.9,
  notes: 'short position tool',
};
const LONG: ImageSetupExtraction = { ...SHORT, side: 'BUY', instrument: { ...SHORT.instrument, raw: 'NIFTY 03 NOV 2026 23200 CE · NSE FO', optionType: 'CE' }, entry: 120, stopLoss: 105, targets: [150], currentPrice: 121 };

/** A master with the two NIFTY 03 NOV 23200 contracts. */
const MASTER = ['CE', 'PE'].map((t, i) => ({
  token: String(50000 + i), symbol: `NIFTY03NOV2623200${t}`, name: 'NIFTY', expiry: '03NOV2026', strike: '2320000.000000', lotsize: '65', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000',
}));

function memStore(o: { reads?: number } = {}) {
  const rows = new Map<string, ImageReadRow>();
  const store: ImageReadStore & { rows: typeof rows } = {
    rows,
    exists: async (id) => rows.has(id),
    save: async (r) => void rows.set(r.messageId, { ...r }),
    readsSince: async () => (o.reads ?? 0) + [...rows.values()].filter((r) => r.model).length,
    link: async (id, signalId, reason) => void Object.assign(rows.get(id)!, { linkedSignalId: signalId, reason }),
    channelTitle: async () => 'Stock Wale Bhaiyaa Learning Group',
  };
  return store;
}

function make(o: { env?: Record<string, string>; reply?: string | (() => Promise<{ text: string; model: string }>); unavailable?: string | null; master?: unknown[] | null; reads?: number; now?: Date } = {}) {
  const store = memStore({ reads: o.reads });
  const reply = o.reply;
  const read = jest.fn(typeof reply === 'function' ? reply : async () => ({ text: reply ?? JSON.stringify(SHORT), model: 'claude-haiku-5-5' }));
  const reader: ImageSetupReader = { unavailable: () => o.unavailable ?? null, read };
  const sink: ImageSignalSink & { ingestImageSetup: jest.Mock } = { ingestImageSetup: jest.fn(async () => 'sig9') };
  const cfg = parseImageSetupConfig({ IMAGE_SETUP_MIN_GAP_SEC: '0', ...(o.env ?? {}) });
  const now = o.now ?? new Date(POSTED.getTime() + 60_000);
  const svc = new ImageSetupService(cfg, store, reader, { get: async () => vocab }, { rows: async () => (o.master === undefined ? MASTER : o.master) }, sink, () => now, async () => undefined);
  const evt = (over: Record<string, unknown> = {}) => ({ messageId: 'm1', channelId: CH, postedAt: POSTED, text: '', hasMedia: true, media: PHOTO, ...over });
  return { svc, store, read, sink, evt };
}

describe('ImageSetupService — what gets read', () => {
  it.each([
    ['IMAGE_SETUPS=off', { env: { IMAGE_SETUPS: 'off' } }, {}, 'off'],
    ['a text message', {}, { media: null }, 'not a photo'],
    ['an image document', {}, { media: { ...PHOTO, kind: 'image-document' } }, 'not a photo'],
    ['another channel', {}, { channelId: 'other' }, 'channel not enabled'],
    ['a caption edit', {}, { edited: true }, 'caption edit (image already read)'],
    ['an old post (restart replay)', { now: new Date(POSTED.getTime() + 61 * 60_000) }, {}, 'too old'],
  ])('%s is not queued', async (_why, opts, over, result) => {
    const m = make(opts as never);
    expect(m.svc.enqueue(m.evt(over) as never)).toBe(result);
    await m.svc.idle();
    expect(m.read).not.toHaveBeenCalled();
    expect(m.store.rows.size).toBe(0);
  });

  it('a photo of the channel is queued, read once (caption + channel title + post time to the reader) and stored', async () => {
    const m = make();
    expect(m.svc.enqueue(m.evt({ text: 'Sell karo' }) as never)).toBe('queued');
    expect(m.svc.enqueue(m.evt() as never)).toBe('already queued');
    await m.svc.idle();
    expect(m.read).toHaveBeenCalledTimes(1);
    expect(m.read).toHaveBeenCalledWith({ path: PHOTO.path, mimeType: 'image/jpeg', sha256: PHOTO.sha256, caption: 'Sell karo', channel: 'Stock Wale Bhaiyaa Learning Group', postedAt: POSTED });
    expect(m.store.rows.get('m1')).toMatchObject({ kind: 'NEW_SETUP', valid: true, model: 'claude-haiku-5-5', channelId: CH });
    m.svc.enqueue(m.evt() as never);
    await m.svc.idle();
    expect(m.read).toHaveBeenCalledTimes(1); // already read
  });

  it('a backfilled (old) image is still read, never traded', async () => {
    const m = make({ env: { IMAGE_SETUPS: 'signal', SIGNAL_ALLOW_OPTION_SELL: 'true' }, now: new Date(POSTED.getTime() + 5 * 3_600_000) });
    expect(m.svc.enqueue(m.evt({ backfill: true }) as never)).toBe('queued');
    await m.svc.idle();
    expect(m.store.rows.get('m1')?.reason).toContain('backfilled image');
    expect(m.sink.ingestImageSetup).not.toHaveBeenCalled();
  });
});

describe('ImageSetupService — modes', () => {
  it('observe (default): a valid fresh NEW_SETUP is stored only — no signal', async () => {
    const m = make({ reply: JSON.stringify(LONG) });
    const row = await m.svc.process(m.evt() as never);
    expect(row).toMatchObject({ kind: 'NEW_SETUP', valid: true, reason: 'observe mode (fresh)' });
    expect(row?.extraction).toMatchObject({ modelKind: 'NEW_SETUP', contract: 'NIFTY03NOV2623200CE', signalText: '[image] BUY NIFTY 23200 CE 03NOV AT 120 SL 105 T 150', fresh: { fresh: true, lagMin: 4 } });
    expect(m.sink.ingestImageSetup).not.toHaveBeenCalled();
  });

  it('signal: a valid fresh BUY becomes a signal through the sink with the [image] text, and the read is linked', async () => {
    const m = make({ env: { IMAGE_SETUPS: 'signal' }, reply: JSON.stringify(LONG) });
    const row = await m.svc.process(m.evt() as never);
    expect(m.sink.ingestImageSetup).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1' }),
      expect.objectContaining({ underlying: 'NIFTY', instrumentKind: 'CE', strike: 23200, side: 'BUY', entryLow: 120, sl: 105, targets: [150], tags: ['IMAGE_SETUP'] }),
      '[image] BUY NIFTY 23200 CE 03NOV AT 120 SL 105 T 150',
    );
    expect(row).toMatchObject({ linkedSignalId: 'sig9', reason: 'signal sig9' });
    expect(m.store.rows.get('m1')).toMatchObject({ linkedSignalId: 'sig9', reason: 'signal sig9' });
  });

  it('signal: option SELL stays observe unless SIGNAL_ALLOW_OPTION_SELL=true', async () => {
    const a = make({ env: { IMAGE_SETUPS: 'signal' } });
    expect(await a.svc.process(a.evt() as never)).toMatchObject({ valid: true, reason: expect.stringContaining('option SELL kept observe') });
    expect(a.sink.ingestImageSetup).not.toHaveBeenCalled();
    const b = make({ env: { IMAGE_SETUPS: 'signal', SIGNAL_ALLOW_OPTION_SELL: 'true' } });
    await b.svc.process(b.evt() as never);
    expect(b.sink.ingestImageSetup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ side: 'SELL', instrumentKind: 'PE' }), '[image] SELL NIFTY 23200 PE 03NOV AT 87.55 SL 100.5 T 48');
  });

  it('signal: a stale screenshot (18210: 1:57 posted 14:19) is not promoted', async () => {
    const m = make({ env: { IMAGE_SETUPS: 'signal' }, reply: JSON.stringify({ ...LONG, screenshotClock: '1:57' }) });
    const row = await m.svc.process(m.evt({ postedAt: new Date('2026-11-02T08:49:46Z') }) as never);
    expect(row?.reason).toMatch(/not fresh: screenshot taken 22 min before the post/);
    expect(m.sink.ingestImageSetup).not.toHaveBeenCalled();
  });

  it.each([
    ['a RESULT (target done)', { ...LONG }, 'Target done 👍', 'RESULT'],
    ['an UPDATE', { ...LONG, kind: 'UPDATE' }, '', 'UPDATE'],
    ['NOT_A_SETUP', { ...LONG, kind: 'NOT_A_SETUP', notes: 'P&L screen' }, '', 'NOT_A_SETUP'],
  ])('signal: %s is never a signal', async (_why, read, caption, kind) => {
    const m = make({ env: { IMAGE_SETUPS: 'signal' }, reply: JSON.stringify(read) });
    expect(await m.svc.process(m.evt({ text: caption }) as never)).toMatchObject({ kind });
    expect(m.sink.ingestImageSetup).not.toHaveBeenCalled();
  });

  it('a contract the instrument master does not list → NOT_A_SETUP; master unavailable → the read stands', async () => {
    const a = make({ master: [] });
    expect(await a.svc.process(a.evt() as never)).toMatchObject({ kind: 'NOT_A_SETUP', valid: false, reason: 'contract not found in the instrument master' });
    const b = make({ master: null });
    expect(await b.svc.process(b.evt() as never)).toMatchObject({ kind: 'NEW_SETUP', valid: true });
  });
});

describe('ImageSetupService — failures, cap, rate limit', () => {
  it('a malformed model reply is stored as NOT_A_SETUP with the raw text', async () => {
    const m = make({ reply: 'Sure! The chart shows a short on NIFTY puts.' });
    expect(await m.svc.process(m.evt() as never)).toMatchObject({ kind: 'NOT_A_SETUP', valid: false, reason: 'model reply is not the setup JSON', extraction: { raw: expect.stringContaining('short on NIFTY') } });
  });

  it('no image transport: stored as not read, the reader is never called', async () => {
    const m = make({ unavailable: 'SENTINEL_JUDGE=api but no ANTHROPIC_API_KEY' });
    expect(await m.svc.process(m.evt() as never)).toMatchObject({ kind: 'NOT_A_SETUP', model: null, reason: 'not read: SENTINEL_JUDGE=api but no ANTHROPIC_API_KEY' });
    expect(m.read).not.toHaveBeenCalled();
  });

  it('daily cap: at the cap the image is stored as not read', async () => {
    const m = make({ reads: 40 });
    expect(await m.svc.process(m.evt() as never)).toMatchObject({ reason: 'not read: daily cap 40 reached', model: null });
    expect(m.read).not.toHaveBeenCalled();
  });

  it('a read error is stored with the reason', async () => {
    const m = make({ reply: async () => Promise.reject(new Error('claude CLI: timed out')) });
    expect(await m.svc.process(m.evt() as never)).toMatchObject({ kind: 'NOT_A_SETUP', reason: expect.stringContaining('read failed: claude CLI: timed out') });
  });

  it('a busy shared slot re-queues the read (no spend) and it succeeds later', async () => {
    let n = 0;
    const m = make({ reply: async () => (n++ === 0 ? Promise.reject(new AssistBusyError(90_000)) : { text: JSON.stringify(SHORT), model: 'claude-haiku-5-5' }) });
    m.svc.enqueue(m.evt() as never);
    await m.svc.idle();
    expect(m.read).toHaveBeenCalledTimes(2);
    expect(m.store.rows.get('m1')).toMatchObject({ kind: 'NEW_SETUP', valid: true });
  });

  it('reads wait IMAGE_SETUP_MIN_GAP_SEC between them', async () => {
    const store = memStore();
    const sleeps: number[] = [];
    const reader: ImageSetupReader = { unavailable: () => null, read: jest.fn(async () => ({ text: JSON.stringify(SHORT), model: 'm' })) };
    const svc = new ImageSetupService(parseImageSetupConfig({ IMAGE_SETUP_MIN_GAP_SEC: '20' }), store, reader, { get: async () => vocab }, { rows: async () => MASTER }, { ingestImageSetup: jest.fn() }, () => new Date(POSTED.getTime() + 60_000), async (ms) => void sleeps.push(ms));
    const e = (id: string) => ({ messageId: id, channelId: CH, postedAt: POSTED, text: '', hasMedia: true, media: PHOTO });
    svc.enqueue(e('a') as never);
    svc.enqueue(e('b') as never);
    await svc.idle();
    expect(store.rows.size).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(19_000);
  });
});
