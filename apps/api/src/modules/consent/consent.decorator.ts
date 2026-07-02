import { applyDecorators, UseGuards } from '@nestjs/common';
import { ConsentGuard } from './consent.guard';

/**
 * Gate a route on the current risk-disclosure consent (spec §5). Applies
 * {@link ConsentGuard}, which 403s `{ code: 'CONSENT_REQUIRED' }` until the
 * caller has accepted the current version. TDA-011 attaches this to its
 * auto-execution / manual-execute routes; TDA-009 attaches it to none.
 */
export const RequiresConsent = () => applyDecorators(UseGuards(ConsentGuard));
