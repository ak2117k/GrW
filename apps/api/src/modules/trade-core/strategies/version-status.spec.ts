import { checkTransition, isEditable, isSelectable, SELECTABLE_STATUSES, VERSION_STATUSES } from './version-status';

describe('checkTransition', () => {
  it('approves a draft into PAPER', () => {
    expect(checkTransition('DRAFT', 'PAPER')).toEqual({ ok: true });
  });

  it('retires a draft or a paper version', () => {
    expect(checkTransition('DRAFT', 'RETIRED')).toEqual({ ok: true });
    expect(checkTransition('PAPER', 'RETIRED')).toEqual({ ok: true });
  });

  it('refuses LIVE from every status (reserved until SP7)', () => {
    for (const from of VERSION_STATUSES) {
      const verdict = checkTransition(from, 'LIVE');
      expect(verdict.ok).toBe(false);
      expect(verdict.ok ? '' : verdict.reason).toMatch(/LIVE is reserved until SP7/);
    }
  });

  it('never returns to DRAFT and never leaves RETIRED', () => {
    expect(checkTransition('PAPER', 'DRAFT').ok).toBe(false);
    expect(checkTransition('RETIRED', 'DRAFT').ok).toBe(false);
    expect(checkTransition('RETIRED', 'PAPER').ok).toBe(false);
  });

  it('refuses a no-op move with a reason', () => {
    expect(checkTransition('PAPER', 'PAPER')).toEqual({ ok: false, reason: 'already PAPER' });
    expect(checkTransition('DRAFT', 'DRAFT')).toEqual({ ok: false, reason: 'already DRAFT' });
  });
});

describe('isSelectable / isEditable', () => {
  it('only PAPER is selectable in SP2', () => {
    expect(SELECTABLE_STATUSES).toEqual(['PAPER']);
    expect(VERSION_STATUSES.filter(isSelectable)).toEqual(['PAPER']);
    expect(isSelectable('BOGUS')).toBe(false);
  });

  it('only DRAFT is editable in place', () => {
    expect(VERSION_STATUSES.filter(isEditable)).toEqual(['DRAFT']);
  });
});
