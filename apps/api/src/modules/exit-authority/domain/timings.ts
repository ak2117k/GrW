/**
 * Trade agent exit authority timings (docs/superpowers/specs/2026-11-27-trade-agent-exit-authority-design.md).
 * Constants on purpose: no env knobs.
 */

/** Supreme confirm call: no answer in this time → the trade agent's EXIT/BOOK stands. */
export const CONFIRM_TIMEOUT_MS = 30_000;
/** An unanswered alarm goes to the owner on Telegram after this long. */
export const ESCALATE_AFTER_MS = 120_000;
/** The same for an `urgent` alarm (hard loss). */
export const ESCALATE_URGENT_AFTER_MS = 60_000;
/** A `deadline` alarm warns the owner this long before its deadline. */
export const DEADLINE_WARN_MS = 600_000;
/** Unanswered `deadline` alarm → code exits at deadline minus this. */
export const DEADLINE_EXIT_LEAD_MS = 120_000;
/** Hard-loss backstop: the owner must have been silent this long after the alert. */
export const BACKSTOP_OWNER_SILENT_MS = 600_000;
/** Owner taps Hold → the alarm is silenced this long. */
export const OWNER_HOLD_SNOOZE_MS = 900_000;
/** Repeat (edit) the owner alert while unresolved. */
export const REALERT_EVERY_MS = 300_000;
/** Re-raise a still-true alarm at most this often (normal / deadline). */
export const REALARM_EVERY_MS = 300_000;
/** Re-raise a still-true `urgent` alarm at most this often. */
export const REALARM_URGENT_EVERY_MS = 120_000;
/** Minimum gap between two alarm wakes of one tracker's agent. */
export const TRACKER_WAKE_MIN_GAP_MS = 20_000;
/** A supreme exit request: the agent gets this long to look before the exit goes ahead. */
export const SUPREME_EXIT_AGENT_LOOK_MS = 60_000;
/** The DEADLINE backstop never acts later than deadline + this: after it the alarm is closed, never sold (a past session's alarm). */
export const DEADLINE_BACKSTOP_GRACE_MS = 300_000;
