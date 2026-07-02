/**
 * Public barrel for the TDA-009 versioned consent & disclaimer gate.
 *
 * This is the TDA-011 seam import point: `ConsentService.hasAcceptedCurrent`
 * (the worker-safe boolean check) plus `ConsentGuard` / `@RequiresConsent()`
 * (the HTTP gate) are all re-exported here. `ConsentModule` is `@Global`, so
 * TDA-011 injects `ConsentService` without importing the module.
 */
export { ConsentService } from './consent.service';
export type { CurrentConsent, ConsentStatus } from './consent.service';
export { ConsentModule } from './consent.module';
export { RISK_DISCLOSURE, CONSENT_ERRORS } from './consent.constants';
export type { ConsentErrorCode } from './consent.constants';
