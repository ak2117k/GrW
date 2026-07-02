import { describe, expect, it } from 'vitest';
import { needsConsent } from './useConsent';

describe('needsConsent', () => {
  it('is false only when the current version is accepted and no reconsent is due', () => {
    expect(needsConsent({ accepted: true, requiresReconsent: false })).toBe(false);
  });

  it('is true when the user has not accepted', () => {
    expect(needsConsent({ accepted: false, requiresReconsent: false })).toBe(true);
  });

  it('is true when a version bump requires re-consent', () => {
    expect(needsConsent({ accepted: true, requiresReconsent: true })).toBe(true);
  });

  it('is true for the fail-closed null-status case', () => {
    expect(needsConsent(null)).toBe(true);
  });
});
