import { validateBriefReply, validateReadReply } from './news-ai.validate';

const goodRead = () => ({
  direction: 'BEAR',
  strength: 62,
  importance: 80,
  takeaway: '  Crude up 4% on supply cut;   OMCs and paint names under pressure. ',
  affected: [
    { kind: 'COMMODITY', name: 'crudeoil', direction: 'BULL', why: 'OPEC+ cut' },
    { kind: 'STOCK', name: 'BPCL', direction: 'BEAR', why: 'margin squeeze' },
  ],
});

describe('validateReadReply', () => {
  it('accepts a well-formed reply and normalises text and names', () => {
    const v = validateReadReply(goodRead());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.takeaway).toBe('Crude up 4% on supply cut; OMCs and paint names under pressure.');
    expect(v.value.affected.map((a) => a.name)).toEqual(['CRUDEOIL', 'BPCL']);
  });

  it.each([
    ['not an object', 'BULL'],
    ['null', null],
    ['an array', [goodRead()]],
    ['bad direction', { ...goodRead(), direction: 'BULLISH' }],
    ['lower-case direction', { ...goodRead(), direction: 'bull' }],
    ['strength above 100', { ...goodRead(), strength: 140 }],
    ['negative importance', { ...goodRead(), importance: -1 }],
    ['string strength', { ...goodRead(), strength: '60' }],
    ['NaN importance', { ...goodRead(), importance: NaN }],
    ['empty takeaway', { ...goodRead(), takeaway: '   ' }],
    ['missing takeaway', { ...goodRead(), takeaway: undefined }],
    ['affected not an array', { ...goodRead(), affected: { kind: 'INDEX' } }],
    ['missing affected', { ...goodRead(), affected: undefined }],
  ])('rejects %s', (_label, reply) => {
    expect(validateReadReply(reply).ok).toBe(false);
  });

  it('drops malformed / duplicate affected entries but keeps the read', () => {
    const v = validateReadReply({
      ...goodRead(),
      affected: [
        { kind: 'INDEX', name: 'NIFTY', direction: 'BEAR', why: 'x' },
        { kind: 'INDEX', name: 'nifty', direction: 'BEAR', why: 'dup' },
        { kind: 'PLANET', name: 'MARS', direction: 'BULL', why: 'bad kind' },
        { kind: 'STOCK', name: 'TCS', direction: 'MIXED', why: 'bad direction' },
        { kind: 'STOCK', name: '  ', direction: 'BULL', why: 'no name' },
        'junk',
      ],
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.affected).toEqual([{ kind: 'INDEX', name: 'NIFTY', direction: 'BEAR', why: 'x' }]);
  });

  it('caps affected at 15 and accepts an empty list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ kind: 'STOCK', name: `S${i}`, direction: 'BULL', why: '' }));
    const v = validateReadReply({ ...goodRead(), affected: many });
    expect(v.ok && v.value.affected.length).toBe(15);
    expect(validateReadReply({ ...goodRead(), affected: [] }).ok).toBe(true);
  });
});

const known = new Set(['a1', 'a2', 'a3']);
const tone = (ids: string[] = ['a1']) => ({ direction: 'MIXED', summary: 'Banks up, IT down.', articleIds: ids });
const goodBrief = () => ({
  headline: 'Crude spike is the story; banks hold up.',
  indiaTone: tone(),
  globalTone: tone(['a2']),
  indices: [
    { name: 'NIFTY', direction: 'BEAR', summary: 's', articleIds: ['a1'] },
    { name: 'FINNIFTY', direction: 'BEAR', summary: 'not a brief index', articleIds: ['a1'] },
    { name: 'BANKNIFTY', direction: 'BULL', summary: 'uncited', articleIds: [] },
  ],
  sectors: [{ name: 'oil gas', direction: 'BEAR', summary: 's', articleIds: ['a1', 'zz'] }],
  commodities: [{ name: 'CRUDEOIL', direction: 'BULL', summary: 's', articleIds: ['a2'] }],
  holdings: [
    { symbol: 'bpcl', direction: 'BEAR', summary: 's', articleIds: ['a1'] },
    { symbol: 'TCS', direction: 'BULL', summary: 'invented id', articleIds: ['nope'] },
  ],
  topStories: [
    { articleId: 'a1', headline: 'h', direction: 'BEAR', whyItMatters: 'w' },
    { articleId: 'a1', headline: 'dup', direction: 'BEAR', whyItMatters: 'w' },
    { articleId: 'zz', headline: 'unknown id', direction: 'BEAR', whyItMatters: 'w' },
  ],
  watchNext: [
    { item: 'OPEC meeting Thursday', articleIds: ['a2'] },
    { item: 'no cite', articleIds: [] },
  ],
});

describe('validateBriefReply', () => {
  it('keeps only points citing ids that were actually sent', () => {
    const v = validateBriefReply(goodBrief(), known);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.indices.map((p) => p.name)).toEqual(['NIFTY']);
    expect(v.value.sectors).toEqual([{ name: 'OIL GAS', direction: 'BEAR', summary: 's', articleIds: ['a1'] }]);
    expect(v.value.holdings.map((h) => h.symbol)).toEqual(['BPCL']);
    expect(v.value.topStories.map((s) => s.articleId)).toEqual(['a1']);
    expect(v.value.watchNext.map((w) => w.item)).toEqual(['OPEC meeting Thursday']);
  });

  it('caps top stories at 5', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `x${i}`);
    const v = validateBriefReply(
      { ...goodBrief(), topStories: ids.map((id) => ({ articleId: id, headline: 'h', direction: 'BULL', whyItMatters: 'w' })) },
      new Set(ids),
    );
    expect(v.ok && v.value.topStories.length).toBe(5);
  });

  it.each([
    ['not an object', 'text'],
    ['empty headline', { ...goodBrief(), headline: '' }],
    ['bad india tone', { ...goodBrief(), indiaTone: { direction: 'UP', summary: 's', articleIds: [] } }],
    ['missing global tone', { ...goodBrief(), globalTone: undefined }],
    ['indices not an array', { ...goodBrief(), indices: {} }],
    ['watchNext missing', { ...goodBrief(), watchNext: undefined }],
    ['no top story cites a known id', { ...goodBrief(), topStories: [{ articleId: 'zz', headline: 'h', direction: 'BULL', whyItMatters: 'w' }] }],
  ])('rejects %s', (_label, reply) => {
    expect(validateBriefReply(reply, known).ok).toBe(false);
  });
});
