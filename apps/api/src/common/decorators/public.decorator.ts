import { SetMetadata } from '@nestjs/common';

/** Metadata key set by {@link Public} and read by `JwtAuthGuard`. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route handler (or whole controller) as public, opting it out of the
 * globally-registered `JwtAuthGuard`. Apply to signup/login/verify/refresh and
 * other unauthenticated endpoints.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
