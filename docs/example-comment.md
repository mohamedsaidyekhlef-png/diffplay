<!-- diffplay -->
### ▶ diffplay: Add per-seat team billing

11 files changed (+148 −11), told as 7 steps. 8 high-risk spots need a careful look before merging.

**11 files** · <code>+148 −11</code> · read closely: **62%** of the diff · 🔴 8 🟠 5 🔵 3

#### Read these first
- 🔴 **Destructive schema change** in `prisma/migrations/20261030_team_seats.sql:8`. Drops or truncates data. Make sure there is a backup and a rollback plan.
- 🔴 **Unscoped delete or update** in `prisma/migrations/20261030_team_seats.sql:9`. Deletes or updates rows without an obvious filter. Check the WHERE clause.
- 🔴 **Auth check removed** in `src/app/api/billing/webhook/route.ts:10`. A line that looks like an authentication, permission or signature check was deleted.
- 🔴 **SQL built from strings** in `src/app/api/billing/webhook/route.ts:21`. Query text is built with interpolation: use parameters to avoid SQL injection.
- 🔴 **Auth check removed** in `src/lib/billing.ts:5`. A line that looks like an authentication, permission or signature check was deleted.
- 🔴 **Possible secret** in `src/lib/billing.ts:19`. Looks like a real credential committed to the repo. Rotate it if it is live.
- 🔴 **Hardcoded credential** in `src/lib/billing.ts:20`. A key, password or token is written into the code. Move it to an environment variable.
- 🟠 **Dependency added or bumped** in `package.json`. New third-party code. Check the package name for typos (typosquatting) and maintenance.

#### The story, in reading order
| # | Step | Files | Risk | What it does |
|---|---|---|---|---|
| 1 | Data model & migrations | 2 | 🔴 high risk | Start here: these change what is stored, so everything else depends on them. New: 20261030_team_seats.sql. Watch for: database migration, destructive schema change, unscoped delete or update. |
| 2 | Dependencies | 1 | 🟠 worth a check | New or changed packages: check every one is expected and trusted. Watch for: dependency added or bumped. |
| 3 | Core logic | 2 | 🔴 high risk | The behaviour change itself: read this part closely. New: seats.ts. Watch for: auth check removed, error swallowed, possible secret. |
| 4 | API, routes & handlers | 1 | 🔴 high risk | Where the outside world reaches the new logic: check inputs and auth. Watch for: auth check removed, SQL built from strings. |
| 5 | User interface | 2 | 🟠 worth a check | What users will see and click. New: SeatManager.tsx. Watch for: raw HTML injection. |
| 6 | Tests | 1 | 🟠 worth a check | Does the change prove itself? Check the tests cover the risky parts above. Watch for: test skipped or weakened. |
| 7 | Docs & comments | 1 | ⚪ clean | Explanations only: safe to skim. |

<sub>1 generated, lock or renamed files hidden.</sub>

<sub>Narration: heuristics. Flags are static rules pointing at places to look, not a verdict. Made with [diffplay](https://github.com/mohamedsaidyekhlef-png/diffplay).</sub>