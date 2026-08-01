import Link from "next/link";
import { BackLink } from "@/components/back-link";

/**
 * The trail above a detail page, plus the way out of it.
 *
 * Two things the hand-rolled trails got wrong, both of which made the crumb read as
 * decoration rather than navigation.
 *
 * **It never named the page you were on.** A run detail said `Runs / checkout-web` — true of
 * that run and of four hundred others. A trail whose last element is a link to somewhere
 * else is not a trail; it is a pair of links with a slash between them. The current page is
 * always the last crumb here, as plain text carrying `aria-current="page"`.
 *
 * **It started org-wide even for something that belongs to a project.** Every run and every
 * test has exactly one project, so the trail starts there and narrows: project → section →
 * this thing. Arriving from the organisation-wide list does not change what the run *is*,
 * and the org itself is already named in the header switcher, so repeating it here would
 * spend a crumb on the one piece of context that is never in doubt.
 *
 * Ordered general → specific, left to right, which is the only ordering a breadcrumb can
 * have. The previous run trail was inverted: `Runs` (everything) then the project (a subset),
 * with the actual run missing from the end.
 */
export interface Crumb {
  label: string;
  /** Omitted on the last crumb — the page you are already on is not a link to itself. */
  href?: string;
  /** Identifiers and suite paths, which are read character by character. */
  mono?: boolean;
}

export function Breadcrumbs({
  items,
  /**
   * Where "Back" goes when there is no in-app history to return to.
   *
   * Usually the list this page belongs to. A deep link from Slack has nowhere to go back
   * *to*, and a back control that does nothing is worse than none.
   */
  backHref,
}: {
  items: Crumb[];
  backHref: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="tc-print-hide mb-4 flex min-w-0 items-center gap-2 text-xs text-[var(--color-ink-muted)]"
    >
      <BackLink fallbackHref={backHref} />

      {/* A hairline rather than a slash: the back control is not part of the trail, and a
          third slash would imply it was another level. */}
      <span className="h-3.5 w-px shrink-0 bg-[var(--color-border-subtle)]" aria-hidden />

      <ol className="flex min-w-0 items-center gap-1.5">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden className="shrink-0">
                  /
                </span>
              ) : null}
              {item.href && !last ? (
                <Link
                  href={item.href}
                  className={`min-w-0 truncate hover:text-[var(--color-ink)] hover:underline ${
                    item.mono ? "font-mono" : ""
                  }`}
                >
                  {item.label}
                </Link>
              ) : (
                /*
                 * The leaf is the only crumb allowed to take the remaining width, and the
                 * only one in full ink. A run called "Nightly regression — shard 3 of 4" has
                 * to be able to truncate without squeezing the two crumbs that lead to it.
                 */
                <span
                  aria-current={last ? "page" : undefined}
                  title={item.label}
                  className={`min-w-0 truncate ${last ? "text-[var(--color-ink)]" : ""} ${
                    item.mono ? "font-mono" : ""
                  }`}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
