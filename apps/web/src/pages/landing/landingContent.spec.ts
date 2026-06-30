import { describe, it, expect } from 'vitest';
import { landingContent } from './landingContent';

// IP boundary: marketing copy must never expose signal provenance (TDA-006/§7).
const FORBIDDEN = [
  'scanner', 'chartink', 'strategy', 'signal engine', 'provenance',
  'source', 'rejection', 'gate',
];

function allCopy(): string {
  return JSON.stringify(landingContent).toLowerCase();
}

describe('landingContent IP guard', () => {
  it('contains no provenance terms', () => {
    const copy = allCopy();
    for (const term of FORBIDDEN) expect(copy).not.toContain(term);
  });
  it('exposes exactly the Intraday and Swing product sections', () => {
    expect(landingContent.valueProps.map((v) => v.segment).sort())
      .toEqual(['Intraday', 'Swing']);
  });
});
