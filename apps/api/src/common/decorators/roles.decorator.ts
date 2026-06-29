import { SetMetadata } from '@nestjs/common';

/** Role identifiers, mirroring the Prisma `UserRole` enum (`USER | ADMIN`). */
export type Role = 'USER' | 'ADMIN';

/** Metadata key set by {@link Roles} and read by `RolesGuard`. */
export const ROLES_KEY = 'roles';

/**
 * Restricts a route handler (or whole controller) to the listed roles. Read by
 * the global `RolesGuard`, which runs after `JwtAuthGuard` populates `req.user`.
 * A route without this metadata is open to any authenticated user.
 *
 *   @Roles('ADMIN')          // admin-only
 *   @Roles('USER', 'ADMIN')  // any authenticated user
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Shorthand for {@link Roles}('ADMIN') — admin-only routes. */
export const AdminOnly = () => Roles('ADMIN');
