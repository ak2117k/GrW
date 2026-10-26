import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { callLine, classLabel, FILTERS, lagLabel, whyLine, type FeedItem } from './telegramFeed';
import { TelegramFeedView } from './TelegramFeedView';

const base: FeedItem = {
  id: 'm1',
  channelId: 'ch1',
  channel: 'Stock Gainers (SEBI Registered)',
  postedAt: '2026-10-26T11:07:00.000Z',
  receivedAt: '2026-10-26T11:07:58.000Z',
  lagSec: 58,
  text: 'PRIZOR VIZTECH 1064 to 1350 🔥🔥🔥🔥 Solid Bounce from Lower Levels',
  hasMedia: false,
  status: 'INFO',
  reason: 'info: entity, level',
  parser: null,
  call: null,
};

const call: FeedItem = {
  ...base,
  id: 'm2',
  channel: 'MCX COMMODITY',
  text: 'CRUDEOIL 10500 CE BUY 270 TGT 300 330 380',
  status: 'SIGNAL',
  reason: null,
  parser: 'rule',
  call: {
    tradingsymbol: 'CRUDEOIL17NOV2610500CE', side: 'BUY', entryType: 'AT', entryLow: 270, entryHigh: 270, sl: null,
    targets: [300, 330, 380], decision: 'SKIP', skipReason: 'risk_cap', mode: 'shadow',
  },
};

describe('telegram feed labels', () => {
  it('names every classifier status in plain words', () => {
    expect(classLabel('SIGNAL')).toEqual({ label: 'Call', variant: 'success' });
    expect(classLabel('INFO').label).toBe('Information');
    expect(classLabel('VIEW').label).toBe('Information');
    expect(classLabel('RECAP').label).toBe('Result');
    expect(classLabel('UPDATE_ORPHAN').label).toBe('Update');
    expect(classLabel('NOISE').label).toBe('Noise');
    expect(classLabel('LLM_NOT_SIGNAL').label).toBe('Not a call');
    expect(classLabel('LLM_PENDING').label).toBe('Reading…');
    expect(classLabel(null).label).toBe('Not classified');
    expect(classLabel('SOMETHING_NEW').label).toBe('SOMETHING_NEW');
  });

  it('explains a reason code, keeping unknown reasons as they are', () => {
    expect(whyLine({ ...base, status: 'NOISE', reason: 'no-instrument' })).toBe('no stock, index or contract named');
    expect(whyLine({ ...base, status: 'NOISE', reason: 'ad' })).toBe('advert / promotion');
    expect(whyLine({ ...base, status: 'NOISE', reason: 'empty', hasMedia: true })).toBe('image only, no text');
    expect(whyLine({ ...base, status: 'LLM_NOT_SIGNAL', reason: 'invalid: unknown underlying HEL' })).toBe('invalid: unknown underlying HEL');
    expect(whyLine({ ...base, status: 'LLM_NOT_SIGNAL', reason: 'llm' })).toBe('AI read it as not a call');
  });

  it('describes a call and its trade decision', () => {
    expect(callLine(call.call!)).toBe('BUY CRUDEOIL17NOV2610500CE at 270 · SL — · targets 300 / 330 / 380');
    expect(whyLine(call)).toBe('skipped (shadow): risk above cap');
  });

  it('shows the reader delay only when it is slow', () => {
    expect(lagLabel(4)).toBe('');
    expect(lagLabel(58)).toBe('arrived 58s late');
    expect(lagLabel(250)).toBe('arrived 4m late');
  });

  it('filters group the classifier statuses', () => {
    expect(FILTERS.find((f) => f.key === 'calls')?.statuses).toEqual(['SIGNAL']);
    expect(FILTERS.find((f) => f.key === 'all')?.statuses).toBeUndefined();
  });
});

describe('TelegramFeedView', () => {
  it('renders each message with channel, class, text and the call line', () => {
    const html = renderToStaticMarkup(<TelegramFeedView items={[call, base]} />);
    expect(html).toContain('Stock Gainers (SEBI Registered)');
    expect(html).toContain('PRIZOR VIZTECH 1064 to 1350');
    expect(html).toContain('Information');
    expect(html).toContain('Call');
    expect(html).toContain('BUY CRUDEOIL17NOV2610500CE at 270');
    expect(html).toContain('arrived 58s late');
  });

  it('says so when nothing matches', () => {
    expect(renderToStaticMarkup(<TelegramFeedView items={[]} />)).toContain('No messages');
  });
});
