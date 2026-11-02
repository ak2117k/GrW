import type { PreOpenOutlook } from './domain/outlook';

/**
 * Read port of the pre-open outlook for other modules (the night report injects it @Optional;
 * the module is @Global). Pure types + a symbol: importing this file pulls in nothing else.
 */
export const PRE_OPEN_OUTLOOK_REPORT = Symbol('PRE_OPEN_OUTLOOK_REPORT');

export interface PreOpenOutlookReport {
  /** stored = the 08:30 run's rows (≤ 6 h old); preview = computed now from DB data, not stored. */
  source: 'stored' | 'preview';
  asOf: string;
  items: PreOpenOutlook[];
  note: string;
}

export interface PreOpenOutlookSource {
  forReport(now: Date): Promise<PreOpenOutlookReport>;
}
