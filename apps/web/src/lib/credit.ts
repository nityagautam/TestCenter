/**
 * Who built this.
 *
 * Kept as data in one place rather than inline in the shell, so it can also be used on the
 * sign-in page or an about panel later without the two copies drifting.
 *
 * `INITIALS` exists because the sidebar collapses to a 56px rail where a full name has
 * nowhere to go. Derived by hand rather than computed: initials are a naming decision, and
 * splitting on spaces gets it wrong for a good number of real names.
 */
export const CREDIT = {
  name: "Ashutosh Mishra",
  initials: "AM",
  /** Shown as the tooltip on the collapsed rail, where only the initials are visible. */
  title: "Built by Ashutosh Mishra",
} as const;
