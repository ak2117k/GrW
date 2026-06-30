/**
 * Public barrel for the TDA-008 tamper-evident audit log.
 *
 * Single import surface for the audit subsystem: the service + module, the
 * action taxonomy, the append/verify types, the genesis constant, and the
 * canonicalization primitives.
 */
export { AuditService, GENESIS_PREV_HASH } from './audit.service';
export type { AuditEvent, VerifyResult } from './audit.service';
export { AuditModule } from './audit.module';
export { AUDIT_ACTIONS } from './audit-actions';
export type { AuditAction } from './audit-actions';
export { canonicalize, sha256 } from './canonicalize';
