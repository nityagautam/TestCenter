# Test Center — login and usage guide

How to sign in, what each role can do, and how to work through the app.

---

## 1. Start the app

```bash
cd /Users/amishra/workspace/code/poc/TestCenter

# Postgres and Redis (installed via brew)
brew services start postgresql@17
brew services start redis

# Apply migrations, provision partitions, bootstrap
pnpm db:migrate

# Seed the Test Organisation with believable history, then the account roster
# (both safe to re-run)
pnpm --filter @testcenter/db seed-test-org 45
pnpm --filter @testcenter/db seed-users

# Run web + worker together
pnpm dev
```

Open <http://localhost:3000>. You will be redirected to `/signin`.

> **Run it with `pnpm dev`, not `pnpm start`.** Local email sign-in is disabled when
> `NODE_ENV=production`, which is what `next start` sets. That is a deliberate safety
> guard, not a bug — see §3.

---

## 2. There are no passwords — and that is on purpose

**Local sign-in asks for an email address only.** No password field, no password to
remember or share.

That is a deliberate decision, not an omission:

- A password we invented for local accounts would be a *fake* security boundary. Anyone
  who can reach `localhost:3000` can already reach the database directly, so a password
  would protect nothing while implying it protected something.
- It makes multi-user testing practical. Verifying that one organisation cannot read
  another's results needs several accounts; creating several real Google accounts to
  check a `WHERE` clause is absurd.
- It cannot leak into production. The provider is registered only when
  `NODE_ENV !== "production"`, so a deployed build has no such login at all.

**In production, identity comes from Google** (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`).
Google holds the password; Test Center never sees or stores one. The only credential this
app ever stores is a **sha256 hash of a CI API token**.

If you specifically want password-protected local accounts, say so — it is a small
addition, and worth doing deliberately rather than by accident.

---

## 3. Signing in

1. Go to <http://localhost:3000/signin>
2. Under **Development sign-in**, type one of the emails below
3. Optionally type a display name
4. Press **Sign in**

That is the whole flow. First sign-in creates the account; later sign-ins reuse it.

### Accounts

All of these already have access to **Test Organisation** (4 projects, 45 days of
history, 330 runs, ~14,500 results). Type the email, leave everything else blank.

| Email | Role | Use it to see |
| --- | --- | --- |
| `admin@testcenter.dev` | **superadmin + owner** | everything, plus the Platform admin area across all organisations |
| `qalead@testcenter.dev` | **maintainer** | creating and editing projects, but *not* managing members or tokens |
| `sdet@testcenter.dev` | **member** | uploading results and tagging, but *not* creating projects |
| `qa@testcenter.dev` | **viewer** | read-only — Upload and Members are hidden, and refused server-side |
| `future-hire@testcenter.dev` | member *(pending)* | a grant made before the account existed — signing in activates it |

The roster lives in `packages/db/scripts/seed-users.ts` and is idempotent, so it survives
a database reset:

```bash
pnpm --filter @testcenter/db seed-users
```

### Superadmin

`admin@testcenter.dev` is **both** the organisation owner and a platform administrator.
Those are two separate things:

- **owner** is a role *within* Test Organisation — granted by a membership row.
- **superadmin** (platform admin) spans *all* organisations — granted only by listing the
  address in `TESTCENTER_ADMIN_EMAILS` in `.env`.

Platform status is re-read from `.env` on **every** sign-in, deliberately outside anything
the database or a seed script can set. Removing an address revokes it at the next login,
and no action inside the app can grant it — otherwise "superadmin" would be escalatable
from within the product it protects.

Also configured as platform admins: `ashutoshmishra@gofynd.com`,
`nityanarayan44@live.com`.

Sign in as `admin@testcenter.dev` and you get **Platform admin** in the left nav: every
organisation, with the ability to grant access to ones you are not a member of. That is
how a new user gets into an existing team.

### Try any address at all

Type any valid email — e.g. `you@example.com` — and you get a brand-new account with no
access, which is exactly what a real new user experiences. You will be offered a choice:
create your own organisation, or skip and be told what to ask an administrator for.

---

## 4. Roles: what each one can do

Organisation membership grants access to **every project** in that organisation. Roles
control what you can *do*, and are ordered — each includes everything below it.

| | viewer<br>`qa@` | member<br>`sdet@` | maintainer<br>`qalead@` | admin | owner<br>`admin@` |
| --- | :-: | :-: | :-: | :-: | :-: |
| Dashboard, runs, tests, flaky, projects | ✓ | ✓ | ✓ | ✓ | ✓ |
| Upload results | | ✓ | ✓ | ✓ | ✓ |
| Edit tags, quarantine tests | | ✓ | ✓ | ✓ | ✓ |
| Delete runs | | | ✓ | ✓ | ✓ |
| Create projects / edit project settings | | | ✓ | ✓ | ✓ |
| Archive projects | | | | ✓ | ✓ |
| Manage members and API tokens | | | | ✓ | ✓ |
| Platform admin area | | | | | superadmin only |
| Delete the organisation | | | | | ✓ |

This table was verified by request against every account, not written from intent — each
row reflects what the server actually returns.

Two things worth knowing:

- **The UI hides what your role cannot do, and the server refuses it independently.**
  Hiding a button is a convenience; the server check is the enforcement. Reaching a
  forbidden page directly by URL gives a clear "requires the *admin* role, yours is
  *viewer*" page — not a 500, and not a silent success.
- **An organisation always keeps at least one owner.** Removing the last one is refused,
  because an organisation with no owner cannot be administered again from inside the app.

---

## 5. Getting people into an organisation

There are no emails to send. Two routes:

**An admin or owner grants access** — Settings → Members, type the email, pick a role,
Grant. If that person has never signed in, the grant is **held** and applied
automatically at their first login. It shows as `pending` until then.

**A platform admin grants access to any organisation** — the Platform admin area lists
every organisation; pick one and grant access there. This works for organisations the
admin is not a member of.

Access takes effect immediately. The recipient can just reload.

---

## 6. Working through the app

### Where things live

Scope is in the URL, so every link is shareable and unambiguous:

```
/o/test-organisation                     organisation dashboard
/o/test-organisation/runs                run list  (all projects)
/o/test-organisation/tests               test search (all projects)
/o/test-organisation/tests/412070        one test's full history
/o/test-organisation/flaky               flaky leaderboard
/o/test-organisation/p/checkout-web      one project's dashboard
```

Pasting a link into Slack lands the recipient on exactly what you were looking at,
provided they have access.

### The dashboard

Headline numbers first — pass rate, runs, tests, failing, flaky, quarantined — then three
charts, then two named lists.

**"Flakiest tests" and "Most-failing tests" are deliberately separate lists.** A test
that always fails is *broken*, not flaky, and scores 0 on flakiness. Mixing them is what
makes most flake dashboards useless. In the seeded data `test_case_7` fails 76 times out
of 89 runs and appears only in "most-failing"; the flaky list holds tests that pass
*inconsistently*.

Hover any chart for a per-day tooltip. Use the 7d / 30d / 90d buttons to change the
window.

### Finding a test

Go to **Tests** and type a fragment — `case_3`, `payment`, `refund`. Matching is
substring-based, so a fragment from the middle of a name works.

Then narrow with the filter row: **Failing**, **Flaky**, **Passing**, **Skipped**,
**Quarantined**; by project; and sort by most failures, flakiest, or slowest. Every
filter is in the URL, so a useful view can be bookmarked.

### Reading a test's history — the main event

Open any test (or click **history** next to a result on a run page). You get:

1. **Stat tiles** — fail rate, runs, failures, flake score, average and p95 duration.
2. **Execution history strip** — one cell per run, oldest on the left, `✓` pass, `✕`
   fail, `!` error, `–` skipped, amber for "passed only on retry". Hover for the date,
   branch and duration; click to open that run.
3. **Distinct failure modes** — this is the part worth understanding. If a test failed
   15 times, the first question is *"one bug or several?"*. Failures are grouped by a
   signature computed from the error type and the top frames of your own code, so you
   see e.g. `ConnectionError ×11` and `ValidationError ×10` as two separate problems.
   Click a mode to filter the list below to only those failures.
4. **Failure history** — every failure in full: branch, commit, duration, attempts, the
   message, the stack trace, and captured stdout/stderr. This is the "show me all three
   failures" view.

**Quarantine** (member and above) marks a known-flaky test so it stops dominating
dashboards while staying visible and still reported. It is not skipping or deleting.

### Uploading results

**From the browser** — pick a project → Upload → drag JUnit XML files in, optionally set
branch, environment and tags, then Upload. You land on the run and watch it parse live.

**From CI** — one command:

```bash
curl -X POST "http://localhost:3000/api/v1/ingest?project=checkout-web&branch=$BRANCH&tag=suite:regression" \
  -H "Authorization: Bearer $TESTCENTER_TOKEN" \
  -F "report=@reports/junit.xml"
```

Get a token from **Settings → API tokens**, or from the screen shown right after you
create a project. A token is displayed **once** — only its hash is stored.

In GitHub Actions, use `if: always()` on the publish step. Without it the step is skipped
exactly when tests fail, which is when you most want the results.

Supported today: **JUnit / xUnit XML** — pytest `--junitxml`, Playwright's junit
reporter, Maven Surefire, Gradle, jest-junit, Cypress, Robot, TestNG.

### Creating a project

Projects → **New project**. Name it; the key is derived and is what CI sends, so keep it
short and stable — renaming it later means updating every pipeline, which is why the key
is not editable afterwards.

A CI token is minted at the same moment and shown with a copy-paste recipe. That is
intentional: the minute after creating a project is when you are actually ready to wire
up a pipeline.

---

## 7. Try the interesting cases

| To see | Do this |
| --- | --- |
| Roles actually enforced | Sign in as `qa@testcenter.dev` (viewer). Upload and Members vanish from the nav; visiting `/o/test-organisation/settings/members` explains why rather than erroring. |
| Maintainer's ceiling | Sign in as `qalead@testcenter.dev`. Projects can be created and edited, but Members and API tokens are refused — maintainer sits below admin. |
| A pending grant activating | Sign in as `future-hire@testcenter.dev` — never signed in before, and lands straight in Test Organisation with member access because the grant was waiting. |
| A brand-new user | Sign in as any unknown address. You get the onboarding choice, then the "no access yet" page with your address to hand to an admin. |
| Tenant isolation | As a new user, create your own organisation, then try `/o/test-organisation` directly. You are redirected away — and a nonexistent slug behaves identically, so slugs cannot be probed. |
| Cross-org granting | Sign in as `admin@testcenter.dev`, open Platform admin, select any organisation and grant an address access — including organisations you are not a member of. |
| Multiple failure modes | Open the test linked from "Most-failing tests" in `payments-service` — it has two distinct signatures. |
| A duration regression | Test search → sort by **Slowest**. The seeded `slowing` tests climb steadily. |

---

## 8. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Sign-in form shows no email field | You are running a production build. Use `pnpm dev`. |
| "No sign-in method configured" | Neither Google credentials nor dev login is available. Use `pnpm dev`, or set `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`. |
| Signed in but "No organisations yet" | Expected for a new account. Create one, or have an admin grant access to yours. |
| Google sign-in rejected | `AUTH_ALLOWED_DOMAINS` restricts which email domains may sign in. Clear it to allow any. |
| No Platform admin link | Your address is not in `TESTCENTER_ADMIN_EMAILS`. Add it and sign in again. |
| Postgres will not start | See the Homebrew `postgresql@17` lib-link repair in the README. |
| A run sits at "parsing" | The worker is not running. Start it with `pnpm dev`; runs stuck beyond 30 minutes are failed automatically with an explanation. |
| Uploads fail with ENOENT | Web and worker disagree on `BLOB_LOCAL_DIR`. Check `curl localhost:3000/api/health?deep=1` — it prints the resolved path. |

---

## 9. Health check

```bash
curl localhost:3000/api/health?deep=1
```

Reports Postgres latency, ingest queue depth, whether the current month's partition
exists, and the resolved object-storage path. Queue depth is the metric that moves first
when something is wrong.
