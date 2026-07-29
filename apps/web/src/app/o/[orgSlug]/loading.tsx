import { PageSkeleton } from "@/components/skeletons";

/**
 * Shown while any organisation-scoped page renders on the server.
 *
 * The header and sidebar live in the layout, so they stay put — only the content column is
 * replaced. That is the behaviour worth having: the chrome you navigated *with* does not
 * flicker, and the region you are waiting for is the region that shows it is working.
 */
export default function Loading() {
  return <PageSkeleton label="Loading page" />;
}
