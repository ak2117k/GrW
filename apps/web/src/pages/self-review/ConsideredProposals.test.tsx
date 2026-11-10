import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsideredProposals, consideredFrom } from './ConsideredProposals';

const runs = [
  { sessionDate: '2026-11-10', summary: { session: '2026-11-10' } },
  { sessionDate: '2026-11-10', summary: { session: '2026-11-10', proposalsConsidered: [{ target: 'scorecard.factor.oi.weight', reason: 'only 7 sessions of evidence (need 10)' }] } },
];

describe('ConsideredProposals (owner 2026-11-10: the Proposals tab showed nothing and the reasons were only in the server log)', () => {
  it('takes the newest run that recorded what it considered', () => {
    expect(consideredFrom(runs as never)).toEqual({ session: '2026-11-10', items: [{ target: 'scorecard.factor.oi.weight', reason: 'only 7 sessions of evidence (need 10)' }] });
    expect(consideredFrom([runs[0]] as never)).toBeNull();
  });
  it('lists each setting the review checked and why it raised no proposal', () => {
    const html = renderToStaticMarkup(<ConsideredProposals data={consideredFrom(runs as never)} />);
    expect(html).toContain('Checked in the 2026-11-10 review, not proposed');
    expect(html).toContain('scorecard.factor.oi.weight');
    expect(html).toContain('only 7 sessions of evidence (need 10)');
  });
  it('says when no run has recorded it yet', () => {
    expect(renderToStaticMarkup(<ConsideredProposals data={null} />)).toContain('from the next nightly review');
  });
});
