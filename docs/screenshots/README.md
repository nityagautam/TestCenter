# Screenshots

The images the root `README.md` embeds as a UI reference.

**Generated, not hand-taken.** Run:

```bash
pnpm add -Dw playwright && npx playwright install chromium   # once
pnpm dev                                                     # in another terminal
node scripts/capture-screenshots.mjs
```

Everything that would otherwise drift between shots is pinned by the script — 1440×900 at 2×,
light theme, UTC — so re-running it after a UI change produces a consistent set rather than
one fresh image among eight stale ones. Retake the whole set, never one file.

It signs in through the dev credentials provider, which does not exist in a production build,
so this cannot be pointed at a real deployment by accident.

| File | Page |
| --- | --- |
| `dashboard.png` | `/o/:org` — organisation dashboard |
| `project-overview.png` | `/o/:org/p/:project` — project overview |
| `runs.png` | `/o/:org/runs` — run list with search, verdict filter and facets |
| `run-detail.png` | `/o/:org/runs/:id` — one run |
| `tests.png` | `/o/:org/tests` — test search |
| `test-detail.png` | `/o/:org/tests/:id` — test history |
| `flaky.png` | `/o/:org/flaky` — flaky leaderboard |
| `reports.png` | `/o/:org/reports` — reports |
| `help.png` | `/help` — the in-app guide |
