/**
 * MANAGER TRACKERS — which real positions the desk manager opened (desk-manager spec 2026-11-26, "Decided
 * after the builder check"): the flat HARD_LOSS_EXIT_RUPEES (₹2,000) exit does not cut them; their stop is the
 * manager's own underlying stop (an armed trigger), and the class catastrophe floor (HARD_LOSS_CEILING_BY_CLASS)
 * stays as the backstop.
 *
 * The cycle asks once per pass for the roster's tracker ids and keeps the answer for that pass. A failed or
 * absent lookup means "none is a manager tracker", so the flat rule keeps applying: fail safe, never looser.
 * Implemented by desk-manager (DeskExitActions.managerTrackerIds over signal_orders.source = 'manager').
 */
export const MANAGER_TRACKERS = 'SENTINEL_MANAGER_TRACKERS';

export interface ManagerTrackerLookup {
  /** The subset of `trackerIds` the desk manager opened (live). */
  managerTrackerIds(trackerIds: readonly string[]): Promise<ReadonlySet<string>>;
}
