import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /*
     * One test file at a time.
     *
     * These are integration tests against a single real Postgres, and vitest runs files in
     * parallel by default. Each suite cleans up in `afterAll` by deleting its throwaway
     * organisation, which cascades through runs, test_results across every monthly
     * partition, test_cases, memberships and api_tokens. Two of those cascades overlapping
     * acquire the same partition locks in different orders, and Postgres resolves it the
     * only way it can:
     *
     *   delete from "organizations" where slug = $1
     *   PostgresError: deadlock detected (40P01)
     *   Process 60709 waits for RowExclusiveLock ...; blocked by process 60714
     *
     * That was the intermittent failure in this suite — roughly one run in eight, and it
     * became noticeable only when a fourth test file was added. It is a property of sharing
     * one database, not of any single test, so the fix belongs here rather than in a retry
     * wrapped around each teardown.
     *
     * The cost is wall-clock: about 3.5s parallel against about 6s serial. A suite that
     * fails one run in eight is worth far less than the seconds saved, and a flakiness
     * product with an intermittently failing test suite has a credibility problem as much
     * as a technical one.
     */
    fileParallelism: false,
  },
});
