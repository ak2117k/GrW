/**
 * Audit action taxonomy (TDA-008, spec §5).
 *
 * `AuditAction` is a TypeScript string union — NOT a Prisma enum — so the
 * vocabulary can grow without a database migration. The full vocabulary is
 * defined here now; later specs emit most groups, this task only needs them
 * declared.
 *
 * `AUDIT_ACTIONS` is the single grouped constant. The `AuditAction` union is
 * DERIVED from it (via the value type below), so the two can never drift: add
 * a string to a group and the union updates automatically.
 */
export const AUDIT_ACTIONS = {
  auth: {
    AUTH_SIGNUP: 'AUTH_SIGNUP',
    AUTH_LOGIN: 'AUTH_LOGIN',
    AUTH_LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
    AUTH_LOGOUT: 'AUTH_LOGOUT',
    AUTH_REFRESH: 'AUTH_REFRESH',
    AUTH_REFRESH_REUSE: 'AUTH_REFRESH_REUSE',
    AUTH_PASSWORD_FORGOT: 'AUTH_PASSWORD_FORGOT',
    AUTH_PASSWORD_RESET: 'AUTH_PASSWORD_RESET',
    AUTH_MFA_CHALLENGE: 'AUTH_MFA_CHALLENGE',
    AUTH_MFA_FAILED: 'AUTH_MFA_FAILED',
    AUTH_MFA_ENROLL: 'AUTH_MFA_ENROLL',
    AUTH_MFA_ACTIVATE: 'AUTH_MFA_ACTIVATE',
    AUTH_MFA_DISABLE: 'AUTH_MFA_DISABLE',
  },
  credential: {
    CREDENTIAL_CONNECT: 'CREDENTIAL_CONNECT',
    CREDENTIAL_DECRYPT: 'CREDENTIAL_DECRYPT',
    CREDENTIAL_ROTATE: 'CREDENTIAL_ROTATE',
    CREDENTIAL_DELETE: 'CREDENTIAL_DELETE',
  },
  consent: {
    CONSENT_ACCEPT: 'CONSENT_ACCEPT',
    CONSENT_REVOKE: 'CONSENT_REVOKE',
    CONSENT_VERSION_PUBLISHED: 'CONSENT_VERSION_PUBLISHED',
  },
  execution: {
    ORDER_PLACED: 'ORDER_PLACED',
    ORDER_REJECTED: 'ORDER_REJECTED',
    ORDER_FILLED: 'ORDER_FILLED',
    ORDER_CANCELLED: 'ORDER_CANCELLED',
    AUTOTRADE_ENABLED: 'AUTOTRADE_ENABLED',
    AUTOTRADE_DISABLED: 'AUTOTRADE_DISABLED',
    KILL_SWITCH_TRIGGERED: 'KILL_SWITCH_TRIGGERED',
  },
} as const;

type AuditActionGroups = typeof AUDIT_ACTIONS;

/**
 * The full set of audit action strings, derived from `AUDIT_ACTIONS` so the
 * union and the constant cannot drift.
 */
export type AuditAction = {
  [G in keyof AuditActionGroups]: AuditActionGroups[G][keyof AuditActionGroups[G]];
}[keyof AuditActionGroups];
