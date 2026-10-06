# Demo seed

```sh
cd packages/db && pnpm seed        # or, from the repo root: pnpm db:seed
```

The seed wipes the two demo organisations (by stable id _and_ by slug / email, so an older seed is removed
too), their mobile identities and their manager accounts, then recreates everything in one transaction.
It is safe to run repeatedly: the second run leaves identical row counts. Every instant is derived from
`now` in `Europe/London` through the shared time helpers (`localToInstant`, `buildShiftInstants`), so
"today 09:00" and the 22:00→06:00 overnight shift resolve exactly as a manager-entered shift would, DST
included. Set `SEED_NOW=<ISO instant>` for a reproducible fixture. The seed refuses to run against a
database whose name ends in `_test` (the integration harness owns those) unless `SEED_ALLOW_TEST_DB=1`.

Row ids are deterministic (`stableId(key)` = sha256-derived UUIDv4), so dashboard URLs survive a re-seed.

## Accounts

Password for every manager: `Password123!` (argon2id, same parameters as the web app, email verified).

| Organisation         | Slug                  | Role    | Email                             | Join code                                                |
| -------------------- | --------------------- | ------- | --------------------------------- | -------------------------------------------------------- |
| Harpenden Coffee Co. | `harpenden-coffee-co` | OWNER   | `owner@harpendencoffee.test`      | `BREW-4821` (active), `LATTE-3407` (revoked 12 days ago) |
| Harpenden Coffee Co. |                       | ADMIN   | `manager@harpendencoffee.test`    |                                                          |
| Harpenden Coffee Co. |                       | MANAGER | `supervisor@harpendencoffee.test` |                                                          |
| Other Co             | `other-co`            | OWNER   | `owner@otherco.test`              | `OTHR-1234`                                              |

Other Co exists for tenant-isolation checks: one location, one published default policy, two employees
(Alex Rivera CONNECTED with a device, Jordan Blake NOT_INVITED), four shifts, its own audit trail. Nothing
in it references Harpenden rows.

## Harpenden Coffee Co.

Europe/London, DMY dates, BUSINESS plan, onboarding dismissed. Locations Harpenden, St Albans, Luton;
departments Front of House, Kitchen, Management; one Front of House and one Kitchen team per location.

### Work Policies

| Policy            | Status    | Restricts                                                                 | Assigned to                                                         |
| ----------------- | --------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Standard Staff    | ACTIVE v1 | SOCIAL_MEDIA, GAMES, ENTERTAINMENT                                        | organisation default (resolved by Zach Stephens, who is on no team) |
| Front of House    | ACTIVE v1 | + VIDEO, STREAMING                                                        | every Front of House team                                           |
| Kitchen           | ACTIVE v1 | SOCIAL_MEDIA, GAMES, VIDEO, STREAMING, SHOPPING; breaks keep restrictions | every Kitchen team                                                  |
| Management        | ACTIVE v1 | GAMES only                                                                | Charlotte Davies, James Taylor (EMPLOYEE scope)                     |
| Social Media Team | ACTIVE v1 | GAMES, ENTERTAINMENT, STREAMING (social apps stay open)                   | Grace Evans (EMPLOYEE scope)                                        |
| Warehouse Staff   | DRAFT     | two unpublished versions                                                  | nobody                                                              |

### Break Policies

| Break policy          | Rules                                                       | Assigned to            |
| --------------------- | ----------------------------------------------------------- | ---------------------- |
| Standard Break 2×15   | 2 × 15 min, ≥ 60 min after start, ≥ 60 min apart, RELAX_ALL | organisation default   |
| Lunch Shift 1×30      | 1 × 30 min, ≥ 180 min after start, RELAX_ALL                | Luton (LOCATION scope) |
| No Phone Break Unlock | 2 × 15 min, KEEP_RESTRICTIONS                               | every Kitchen team     |

Policies are resolved with the shared `resolvePolicy` (EMPLOYEE → TEAM → LOCATION → organisation default,
see `docs/POLICY_HIERARCHY.md`), so each employee's device carries the current version of the policy the API
would resolve for them. Because TEAM beats LOCATION, the Kitchen teams at Luton get No Phone Break Unlock,
and Lunch Shift 1×30 reaches only Luton's Front of House staff (Isla, Ethan, Sophie).

### Employees and the scenario each one demonstrates

| Employee         | Lifecycle        | Scenario                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zach Stephens    | CONNECTED        | WORKING right now whenever the seed runs: today's shift at Harpenden is anchored on `now` (started 2 h ago, ends in 4 h, scheduled break at +180 min); one EXPIRED break 75 min into the shift that ended 30 min ago; device synced 3 minutes ago, 3 categories selected. On no team, so he resolves Standard Staff via the organisation default; other days follow his 09:00–15:00 pattern. |
| Jack Smith       | CONNECTED        | Off shift: next shift tomorrow 10:00–18:00. Had an EXEMPT_TEMPORARILY override 13:00–15:00 yesterday (expired, OVERRIDE_CREATED + OVERRIDE_EXPIRED).                                                                                                                                                                                                                                         |
| Sarah Jones      | SETUP_INCOMPLETE | Joined but denied Screen Time: PERMISSIONS_MISSING badge, PERMISSION_NEEDS_ATTENTION event, shift today 12:00–20:00 that cannot be enforced. (The brief calls this "JOINED"; the shared `deriveInviteStatus` maps a denial to SETUP_INCOMPLETE, which is what the API would store.)                                                                                                          |
| Tom Brown        | INVITED          | Invite link sent two days ago (code `TBRWN7`), not joined; first shifts next week.                                                                                                                                                                                                                                                                                                           |
| Amelia Clarke    | CONNECTED        | ON_BREAK right now: shift from now−3h to now+3h, ACTIVE break started 5 min ago, planned to end in 10. Also works at St Albans as a secondary location.                                                                                                                                                                                                                                      |
| Oliver Patel     | CONNECTED        | Night baker at Luton: overnight shift tonight 22:00→06:00 (WORKING when seeded during it); Kitchen policy and No Phone Break Unlock via the Luton Kitchen team (TEAM beats the Luton LOCATION break assignment).                                                                                                                                                                             |
| Mia Khan         | SETUP_INCOMPLETE | Joined 6 hours ago, approved Screen Time but has selected no apps; the device has never reported an engine state.                                                                                                                                                                                                                                                                            |
| Noah Wright      | CONNECTED        | Phone last synced 30 hours ago: SYNC_DELAYED badge, DEVICE_SYNC_DELAYED event, unread notification for the owner.                                                                                                                                                                                                                                                                            |
| Isla Murphy      | NOT_INVITED      | On the rota (two shifts came from the CSV import) but never invited.                                                                                                                                                                                                                                                                                                                         |
| Leo Garcia       | DEACTIVATED      | Left four days ago: employment INACTIVE, device deactivated, past shifts kept.                                                                                                                                                                                                                                                                                                               |
| Grace Evans      | CONNECTED        | Management department on the Social Media Team policy; shifts are a weekly Mon/Wed/Fri recurrence (anchor shift + child occurrences).                                                                                                                                                                                                                                                        |
| Harry Wilson     | CONNECTED        | Head chef at St Albans: Kitchen policy + No Phone Break Unlock; early shifts 06:30–14:30 including today, one EMPLOYEE_ENDED break yesterday.                                                                                                                                                                                                                                                |
| Charlotte Davies | CONNECTED        | Store manager on the light Management policy (EMPLOYEE assignment).                                                                                                                                                                                                                                                                                                                          |
| James Taylor     | INVITED          | Invited by email yesterday; Management policy assigned ahead of joining.                                                                                                                                                                                                                                                                                                                     |
| Ethan Hughes     | JOINED           | Joined 20 minutes ago with the company code; Screen Time setup not started (never synced).                                                                                                                                                                                                                                                                                                   |
| Sophie Martin    | CONNECTED        | Joined five days ago at Luton (recent EMPLOYEE_JOINED / SETUP_COMPLETED); three shifts came from the CSV import.                                                                                                                                                                                                                                                                             |

### Everything else

- Two weeks of shifts (−7 d … +7 d) across all three locations, no overlaps per employee; past shifts are
  COMPLETED, future ones SCHEDULED; several carry scheduled breaks. Shifts created yesterday by the
  supervisor have SHIFT_CREATED events and `shift.created` audit rows.
- A committed CSV import (`luton-rota-week.csv`, IMPORTED three days ago): 5 IMPORTED rows, 2 ERROR rows
  (unknown employee, invalid time) and 1 SKIPPED duplicate, with the imports service's problem shapes.
- `EmployeeWorkState` rows are produced by the shared Work Mode state machine and `deriveDeviceStatus`
  at `now` (the same functions the work-state job runs), so the dashboard, status badges and the machine
  agree on first load. The device's reported state is what the machine said at its last sync.
- 50+ activity events over the last week with operational metadata in the services' shapes
  (EMPLOYEE_JOINED, SETUP_COMPLETED, WORK_MODE_STARTED/ENDED per enforced past shift, BREAK_*,
  POLICY_UPDATED, SHIFT_CREATED, DEVICE_SYNC_DELAYED, PERMISSION_NEEDS_ATTENTION, IMPORT_COMPLETED,
  OVERRIDE_CREATED/EXPIRED, SCHEDULE_SYNCED, POLICY_SYNCED).
- Audit log rows for every seeded manager mutation (organisation, join code, structure, policies,
  assignments, employees, invites, shifts, import, override, integration interest).
- Three in-app notifications for the owner (one unread) and a PLANDAY integration row with
  `notifyRequested = true`.

## Layout

| File                          | Purpose                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `../seed.ts`                  | Entry point: env, password hashes, reset + insert in one transaction, summary tables.           |
| `constants.ts`                | Organisations, managers, join codes, stable id helpers.                                         |
| `clock.ts`                    | `SeedClock`: every instant relative to `now` via the shared time helpers.                       |
| `builder.ts`                  | `OrgBuilder`: shifts, break sessions, audit/activity rows, device + work-state materialisation. |
| `workState.ts`                | Mirrors the work-state job: state machine + `deriveDeviceStatus` → `EmployeeWorkState` row.     |
| `harpenden.ts` / `otherCo.ts` | The two organisations' data.                                                                    |
| `collector.ts`                | Row buffers and FK-ordered `createMany` inserts.                                                |
| `reset.ts`                    | Deletes previous demo data.                                                                     |
| `summary.ts`                  | Row-count and employee tables printed at the end.                                               |
