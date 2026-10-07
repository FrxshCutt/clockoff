# Policy Hierarchy (§6.1)

How ClockOff decides which **Work Policy** and which **Break Policy** apply to an employee at a given
instant. The logic is pure TypeScript in `packages/shared/src/policy/` and is exercised by the tests next to
it (`resolvePolicy.test.ts` holds the exhaustive precedence / fall-through matrices and a 200-permutation
determinism check). This document is the human-readable contract that code implements.

Entry points (all exported from `@clockoff/shared` and `@clockoff/shared/policy/resolvePolicy`):

| Function                                                                                 | Purpose                                                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `resolvePolicy(input)`                                                                   | Pick the one policy that applies. Generic: same code for `Policy` and `BreakPolicy`.    |
| `resolvePolicyVersion(policy)`                                                           | For Work Policies: the current _published_ version's `restrictionConfig`.               |
| `resolveWorkPolicy(input)`                                                               | `resolvePolicy` + `resolvePolicyVersion` in one call, warnings merged.                  |
| `explainResolution(result, names?)`                                                      | Dashboard copy such as `Resolved from Team: Front of House`.                            |
| `fromBreakPolicyAssignment(row)`                                                         | Adapts a `BreakPolicyAssignment` (`breakPolicyId` → `policyId`).                        |
| `indexPoliciesById(rows)`                                                                | Builds the `policiesById` map.                                                          |
| `resolutionWarningKey(warning)`                                                          | Stable de-duplication key for persisting warnings as activities (§6).                   |
| `isAssignmentActive(a, now)`, `isPolicyUsable(p)`, `compareAssignmentsNewestFirst(a, b)` | The window, archived/deleted and ordering rules used internally (§2–§4).                |
| `POLICY_SCOPE_PRECEDENCE`                                                                | Frozen `["EMPLOYEE", "TEAM", "LOCATION", "ORGANISATION"]`, for rendering the hierarchy. |

Input types are structural (`PolicyLike`, `AssignmentLike`, `EmployeeContextLike`), so Prisma rows are
passed as-is and the result keeps the concrete row type (`result.policy.name`, `.maxBreaksPerShift`, … are
typed). `AssignmentLike<T>` accepts an optional, documentation-only type parameter (`AssignmentLike<Policy>`,
`AssignmentLike<BreakPolicy>`); it does not change the shape, so nothing stops a break assignment from being
passed with work policies — keep the two sets apart when loading.

**Errors.** Resolution never throws for data problems: every anomaly is a `ResolutionWarning` (§6). The
only throw is a `RangeError` for an Invalid Date in `now`, in any assignment's `createdAt` /
`effectiveFrom` / `effectiveTo`, or in any supplied policy's `deletedAt`. Database rows cannot hold one, so
it is always a caller bug (e.g. `new Date(badString)`), and every comparison against `NaN` is false, so it
would otherwise make windows silently open-ended and the ordering arbitrary. Every row is checked, not only
those that apply to the employee, so whether it throws never depends on which levels happen to be reached.

## 1. Precedence

Levels are consulted in this fixed order (`POLICY_SCOPE_PRECEDENCE`). The first level that yields a
usable policy wins; nothing below it is looked at.

| #   | Level                         | Applies when the assignment's `scopeId` is …            | `resolvedFrom`                                                           |
| --- | ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **EMPLOYEE**                  | the employee's id                                       | `{ via: "ASSIGNMENT", scopeType: "EMPLOYEE", scopeId, assignmentId }`    |
| 2   | **TEAM**                      | any team the employee belongs to (`EmployeeTeam`)       | `{ via: "ASSIGNMENT", scopeType: "TEAM", … }`                            |
| 3   | **LOCATION**                  | the employee's **primary** location only                | `{ via: "ASSIGNMENT", scopeType: "LOCATION", … }`                        |
| 4   | **ORGANISATION** (assignment) | the organisation id                                     | `{ via: "ASSIGNMENT", scopeType: "ORGANISATION", … }`                    |
| 5   | **ORGANISATION default**      | `Organisation.defaultPolicyId` / `defaultBreakPolicyId` | `{ via: "DEFAULT", scopeType: "ORGANISATION", scopeId: organisationId }` |
| 6   | nothing                       | —                                                       | `null` (`policy: null, policyId: null`)                                  |

The same hierarchy applies to Break Policies: feed `BreakPolicyAssignment` rows through
`fromBreakPolicyAssignment`, pass `BreakPolicy` rows as `policiesById`, and `defaultBreakPolicyId` as
`organisationDefaultPolicyId`. Windows, tie-breaks, fall-through and every warning behave identically.
Break Policies have no versions, so `resolvePolicyVersion` is not used for them.

### Organisation assignment vs organisation default

Both can exist at once. **An ORGANISATION-scope assignment row beats the organisation default id.**
Rationale: an assignment is an explicit, audited act (it has `createdBy`, `createdAt` and an effective
window) and can be scheduled; the default id is a fallback pointer with no window. If a manager wants the
default to apply, the organisation-scope assignment should be ended (set `effectiveTo`), not the default
changed underneath it.

### Secondary locations

Only `primaryLocationId` participates. `EmployeeContextLike.locationIds` (secondary locations from
`EmployeeLocation`) is accepted for completeness but **never consulted**. An employee with no primary
location simply has no LOCATION level. This keeps resolution unambiguous without a second tie-break rule;
if secondary locations ever need to count, add them as a level _below_ primary location and document it
here first.

## 2. Effective windows

An assignment is _active_ at instant `now` when

```
(effectiveFrom is null  OR  effectiveFrom <= now)   AND
(effectiveTo   is null  OR  effectiveTo   >  now)
```

- `effectiveFrom` is **inclusive**, `effectiveTo` is **exclusive**, so a window ending at 09:00 and one
  starting at 09:00 never overlap.
- `null` on either side means unbounded.
- An empty or inverted window (`effectiveFrom >= effectiveTo`) is never active. The database has no CHECK
  constraint against it; such a row is simply ignored, with no warning.
- `now` is a UTC instant (`Date`); defaults to the wall clock. Pass it explicitly from request handlers
  so a whole request evaluates at one instant, and from tests for determinism.
- Inactive assignments (expired or not yet effective) are ignored silently — that is normal scheduling,
  not an anomaly, so **no warning** is emitted for them.
- A not-yet-effective assignment never shadows a currently active one, even if it was created later.

## 3. Ordering and tie-breaking within a level

After filtering to active assignments whose policy is usable (see §4):

1. Sort by `createdAt` **descending**; equal instants fall back to `id` **descending** (plain string
   comparison, which for lowercase UUIDs is the same order as Postgres `ORDER BY id DESC`). The order is
   total, so the result — winner _and_ the order of warnings — never depends on input order or on the
   order of `teamIds`.
2. The first entry wins.
3. Several usable assignments for the **same** `(scopeType, scopeId)` → warning
   `DUPLICATE_SCOPE_ASSIGNMENT`; the newest wins and the warning names the rows to clean up. The partial
   unique index `policy_assignments_active_scope_unique` (and its break twin) is only
   `UNIQUE (scope_type, scope_id) WHERE effective_to IS NULL`: it stops two **open-ended** rows for one
   scope, but **not** overlapping bounded windows (e.g. one row ending next month plus a new open-ended
   one). Preventing those is the assignment API's job: when assigning, end the previous assignment at the
   new one's `effectiveFrom`.
4. At the TEAM level, ambiguity is judged on each team's **own winner** (its newest usable assignment).
   When two or more teams' winners point at **different policies** → warning `AMBIGUOUS_TEAM_ASSIGNMENT`
   ("if multiple teams, the most recently created active assignment wins; log a WARNING activity"), whose
   `details.candidates` lists one entry per team, newest first. No warning when every team's winner is the
   same policy, since the outcome is unambiguous — even if a stale duplicate row inside one team points
   elsewhere (that row is reported as `DUPLICATE_SCOPE_ASSIGNMENT` instead).

Two practical consequences:

- **Pass every assignment and let the resolver choose.** Do not pick the winner in SQL with
  `ORDER BY created_at DESC, id DESC LIMIT 1`: Postgres stores `created_at` to the microsecond, a JS `Date`
  only to the millisecond, so two rows created in the same millisecond can order differently in SQL and in
  the resolver.
- A row that appears twice in `assignments` (same `id`, e.g. two loading queries concatenated) is counted
  once — first occurrence kept — so it is not reported as a duplicate.

## 4. Archived, soft-deleted and foreign policies

A policy is **usable** unless `status === "ARCHIVED"` or `deletedAt` is set (`isPolicyUsable`). A runtime
`status` outside `PolicyStatus` (a stale enum mirror, hand-built data) is also treated as unusable rather
than thrown on.

- An assignment pointing at an unusable policy is skipped with `INACTIVE_POLICY_SKIPPED` and resolution
  **falls through**: first to other candidates at the same level, then to the next level, finally to the
  organisation default. One warning is emitted per skipped assignment (only for levels that were reached).
- Within a level, an older assignment to a usable policy beats a newer one to an archived policy, and no
  ambiguity warning is raised for the archived one.
- An archived or deleted **organisation default** resolves to nothing (`policy: null`) with a
  `INACTIVE_POLICY_SKIPPED` warning whose `details.via === "DEFAULT"`.
- `DRAFT` policies are **not** skipped here. The API should refuse to assign a draft
  (`POLICY_NOT_PUBLISHED` error), but if one is assigned anyway, resolution still selects it and
  `resolvePolicyVersion` reports `POLICY_NOT_PUBLISHED`. Falling through silently would hand the
  employee a _weaker_ policy from a lower level, which is the wrong failure mode for a blocking product.

### Policies owned by another organisation

The database does not enforce that an assignment (or `Organisation.defaultPolicyId`) points at a policy
of the **same** organisation. When the policy row carries `organisationId` (Prisma rows always do; keep it
if you `select`), a policy whose `organisationId` differs from the employee's is **never applied**: it is
skipped with `POLICY_ORGANISATION_MISMATCH` and resolution falls through exactly as for an archived policy
(a foreign default resolves to nothing). This check runs before the status check, so a foreign archived
policy is reported once, as the mismatch. It is a tenancy bug in whatever wrote the reference; treat it as
an incident, not as manager-facing data clean-up.

### Policies missing from `policiesById`

`policiesById` must contain **every** policy referenced by any assignment or the default, _regardless of
status or organisation_ (do not filter when loading). If the winning assignment's policy is missing, the
resolver keeps the winner (precedence is never weakened by a caller bug), returns `policy: null` with
`policyId` set, and emits `POLICY_NOT_LOADED`. Treat that warning as a bug in the loading query. Only own
properties of `policiesById` are read, so ids such as `toString` or `__proto__` can never resolve to
`Object.prototype` members; `indexPoliciesById` stores even a `__proto__` id as an ordinary key.

## 5. Version resolution (Work Policies only)

`resolvePolicyVersion(policy)` reads `policy.currentVersion` (load with `include: { currentVersion: true }`):

| Situation                                                                          | `restrictionConfig`                 | Warning                                                               |
| ---------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `policy` is `null`                                                                 | `null`                              | none (upstream already said nothing resolved)                         |
| `currentVersionId` set but `currentVersion` absent, `null`, or a different version | `null`                              | `POLICY_VERSION_NOT_LOADED` (`currentVersionId`, `suppliedVersionId`) |
| no current version at all                                                          | `null`                              | `POLICY_NOT_PUBLISHED` (`currentVersionId: null`)                     |
| `currentVersion.publishedAt` is `null`                                             | `null`                              | `POLICY_NOT_PUBLISHED` (`currentVersionId` set)                       |
| stored JSON fails `isRestrictionConfig`                                            | `null` (version ids still returned) | `INVALID_RESTRICTION_CONFIG`                                          |
| published, valid                                                                   | the `RestrictionConfig`             | none                                                                  |

A version counts as published only when `publishedAt` is set; `currentVersionId` alone is not enough.
Publishing code must set both. `POLICY_VERSION_NOT_LOADED` exists so a forgotten `include` is never
mistaken for an unpublished policy (which would send a manager to "publish" a policy that already is).
When the shape carries no `currentVersionId` property at all, the supplied `currentVersion` is trusted.

## 6. Warnings

Every anomaly is a `ResolutionWarning` with a stable `code` (`POLICY_RESOLUTION_WARNING_CODES`; a
type-level test keeps the array and the union identical), a human `message` and JSON-safe `details`
(dates are ISO strings). Callers should persist them — the spec asks for a WARNING activity — not drop them.

| Code                           | Meaning                                                                  | Action                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `AMBIGUOUS_TEAM_ASSIGNMENT`    | Employee in several teams with different policies; newest assignment won | Show on the employee page; manager should add an EMPLOYEE assignment or fix team membership |
| `DUPLICATE_SCOPE_ASSIGNMENT`   | More than one active assignment for one scope                            | Data clean-up; the assignment API should end the previous row (see §3)                      |
| `INACTIVE_POLICY_SKIPPED`      | Assignment or default points at an archived / deleted policy             | End the stale assignment; pick a new default                                                |
| `POLICY_ORGANISATION_MISMATCH` | Assignment or default points at another organisation's policy            | Tenancy bug: fix the writer, repair the row; never shown as a manager task                  |
| `POLICY_NOT_LOADED`            | Winning id missing from `policiesById`                                   | Fix the loading query (never filter by status or organisation)                              |
| `POLICY_NOT_PUBLISHED`         | Resolved policy has no published version                                 | Publish the policy; device gets no restrictions until then                                  |
| `POLICY_VERSION_NOT_LOADED`    | Policy's current version was not supplied                                | Fix the loading query (`include: { currentVersion: true }`)                                 |
| `INVALID_RESTRICTION_CONFIG`   | Stored version JSON does not match `RestrictionConfig`                   | Data integrity bug; repair the version                                                      |

### Persisting warnings as activities

Resolution runs on every device sync and dashboard render, so logging every warning it returns would
flood the activity feed with the same finding. Record a warning only when its condition is **new**:

```ts
const key = `${employeeId}:work:${resolutionWarningKey(warning)}`; // "break" for break policies
if (!alreadyRecorded(key)) recordWarningActivity({ employeeId, metadata: { key, ...warning } });
```

`resolutionWarningKey` is stable across `now`, input order and message wording, and changes exactly when
the condition changes (another winner, a team repointed, a new version). It is unique per employee and per
policy kind only, hence the prefix above. `details` contain ids and enum values only, so the payload is
operational metadata as required by the privacy rules (§12).

> **Open gap:** `ActivityEventType` has no warning/resolution type today (see `enums.ts` and the Prisma
> enum). Until one is added (proposed: `POLICY_RESOLUTION_WARNING`, with the warning in `metadata`), callers
> should log warnings with the server logger and surface them on the employee page, rather than
> mislabel them as another event type.

## 7. Worked examples

Setup: Sam (employee `E`) is in teams _Front of House_ (`T1`) and _Baristas_ (`T2`), primary location
_Shoreditch_ (`L`), organisation _Acme Coffee_ (`O`, default policy `P-default`). All instants UTC.

**A. Plain hierarchy**

| Assignment | Scope            | Policy | Window |
| ---------- | ---------------- | ------ | ------ |
| a1         | ORGANISATION `O` | P-org  | always |
| a2         | LOCATION `L`     | P-loc  | always |
| a3         | TEAM `T1`        | P-foh  | always |

→ `P-foh`, `Resolved from Team: Front of House`. No warnings. Remove a3 → `P-loc`. Remove a2 → `P-org`
(the organisation **assignment**, not the default). Remove a1 → `P-default`, `Resolved from Organisation
default`.

**B. Two teams, different policies**

| Assignment | Scope     | Policy    | createdAt  |
| ---------- | --------- | --------- | ---------- |
| a3         | TEAM `T1` | P-foh     | 2026-09-01 |
| a4         | TEAM `T2` | P-barista | 2026-09-20 |

→ `P-barista` (a4 is newer) + `AMBIGUOUS_TEAM_ASSIGNMENT` listing both candidates. If a4 also pointed at
`P-foh` there would be no warning. Had both rows the same `createdAt`, the higher `id` would win, whatever
the input order.

**C. Scheduled change**

| Assignment | Scope        | Policy | Window                            | createdAt  |
| ---------- | ------------ | ------ | --------------------------------- | ---------- |
| a5         | EMPLOYEE `E` | P-old  | `effectiveTo` 2026-11-01T00:00Z   | 2026-06-01 |
| a6         | EMPLOYEE `E` | P-new  | `effectiveFrom` 2026-11-01T00:00Z | 2026-10-05 |

At 2026-10-31T23:59Z → `P-old`; at 2026-11-01T00:00Z → `P-new`. No warnings at any instant, no overlap.
(Only a6 is open-ended, so the partial unique index allows it.)

**D. Archived policy**

a7: EMPLOYEE `E` → `P-retired` (status ARCHIVED); a3: TEAM `T1` → `P-foh`.
→ `P-foh` + `INACTIVE_POLICY_SKIPPED { policyId: P-retired, scopeType: EMPLOYEE, assignmentId: a7 }`.

**E. Nothing configured**

No assignments, `defaultPolicyId = null` → `{ policy: null, policyId: null, resolvedFrom: null, warnings: [] }`.
The device receives no restriction config and Work Mode stays off; the dashboard should prompt the manager
to set a default policy.

**F. Break policy**

`BreakPolicyAssignment` b1: TEAM `T1` → `BP-strict`; `defaultBreakPolicyId = BP-default`.

```ts
resolvePolicy({
  employee,
  assignments: breakAssignments.map(fromBreakPolicyAssignment),
  policiesById: indexPoliciesById(breakPolicies),
  organisationDefaultPolicyId: organisation.defaultBreakPolicyId,
  now,
});
```

→ `BP-strict`, `Resolved from Team: Front of House`. The returned `policy` keeps its concrete type, so
`result.policy.maxBreaksPerShift` is typed.

## 8. How the dashboard shows "Resolved from"

- Use `explainResolution(result, { TEAM: teamNamesById, LOCATION: …, EMPLOYEE: …, ORGANISATION: … })` for the
  badge text; `SCOPE_TYPE_LABELS` gives the bare labels for filters and legends.
- Render `resolvedFrom.via === "DEFAULT"` distinctly ("Organisation default") from an ORGANISATION-scope
  assignment ("Organisation"), because the fix for each is different (change the default vs end the
  assignment).
- Link the badge to the scope object (`resolvedFrom.scopeId`) and, for assignments, to the assignment
  (`assignmentId`) so a manager can end or edit it in one click.
- Show `warnings` as an amber notice under the badge; `AMBIGUOUS_TEAM_ASSIGNMENT.details.candidates` lists
  the competing teams for an "assign directly to this employee" call to action.
- `policy === null` with `resolvedFrom === null` → "No policy — set an organisation default".
- `policy !== null` but `version.restrictionConfig === null`: show "Policy not published" with a publish
  link **only** for `POLICY_NOT_PUBLISHED`; `POLICY_VERSION_NOT_LOADED` and `INVALID_RESTRICTION_CONFIG` are
  system errors, not manager tasks.
- Managers care about _today_; pass `now = new Date()`. To preview a scheduled change, pass the future
  instant — the function is pure, so previews are free.

## 9. Loading the inputs

Resolution is pure; the caller loads data. A recipe for one employee (type-checked against the generated
Prisma client):

```ts
const employee = await prisma.employee.findUniqueOrThrow({
  where: { id: employeeId },
  select: {
    id: true,
    organisationId: true,
    primaryLocationId: true,
    teams: { select: { teamId: true } },
    organisation: { select: { defaultPolicyId: true, defaultBreakPolicyId: true } },
  },
});
const context = {
  employeeId: employee.id,
  organisationId: employee.organisationId,
  teamIds: employee.teams.map((t) => t.teamId),
  primaryLocationId: employee.primaryLocationId,
};

// Work policy: every assignment of the organisation (any scope, any window); resolution picks the winner.
const assignments = await prisma.policyAssignment.findMany({
  where: { organisationId: employee.organisationId },
});
const policyIds = new Set(assignments.map((a) => a.policyId));
if (employee.organisation.defaultPolicyId !== null)
  policyIds.add(employee.organisation.defaultPolicyId);
const policies = await prisma.policy.findMany({
  where: { id: { in: [...policyIds] } }, // NO status / deletedAt / organisation filter
  include: { currentVersion: true },
});
const work = resolveWorkPolicy({
  employee: context,
  assignments,
  policiesById: indexPoliciesById(policies),
  organisationDefaultPolicyId: employee.organisation.defaultPolicyId,
  now,
});

// Break policy: same shape, adapted assignment rows, no versions.
const breakAssignments = await prisma.breakPolicyAssignment.findMany({
  where: { organisationId: employee.organisationId },
});
const breakPolicyIds = new Set(breakAssignments.map((a) => a.breakPolicyId));
if (employee.organisation.defaultBreakPolicyId !== null)
  breakPolicyIds.add(employee.organisation.defaultBreakPolicyId);
const breakPolicies = await prisma.breakPolicy.findMany({
  where: { id: { in: [...breakPolicyIds] } },
});
const breaks = resolvePolicy({
  employee: context,
  assignments: breakAssignments.map(fromBreakPolicyAssignment),
  policiesById: indexPoliciesById(breakPolicies),
  organisationDefaultPolicyId: employee.organisation.defaultBreakPolicyId,
  now,
});
```

Why no filters on the policy query: archived and deleted rows must be present to be _skipped_ with a
warning (absent rows become `POLICY_NOT_LOADED`), and foreign rows must be present to be _rejected_ by the
organisation check. The Prisma client has no soft-delete extension, so `findMany` returns deleted rows.

For a whole organisation, load assignments and policies once and call `resolvePolicy` per employee —
it is O(assignments) per call with no I/O.

## 10. `RestrictionConfig` is defined in `@clockoff/shared`

`packages/shared/src/policy/restrictionConfig.ts` holds the TypeScript interface `RestrictionConfig`
and `DEFAULT_RESTRICTION_CONFIG`; it is the source of truth for the JSON stored in
`PolicyVersion.restrictionConfig` and decoded by the iOS client. The Zod schema
`restrictionConfigSchema` in `@clockoff/validation` validates API input and **must stay structurally
identical**. `@clockoff/shared` cannot import from `@clockoff/validation` (circular), so the validation
package should pin the two together at the type level, e.g.

```ts
import type { RestrictionConfig } from "@clockoff/shared/policy/restrictionConfig";
type _SchemaMatchesType = [z.infer<typeof restrictionConfigSchema>] extends [RestrictionConfig]
  ? true
  : never;
type _TypeMatchesSchema = [RestrictionConfig] extends [z.infer<typeof restrictionConfigSchema>]
  ? true
  : never;
```

`isRestrictionConfig` in shared is a lightweight structural guard for JSON read back from the database;
it is not a substitute for the Zod schema at the API boundary. The two agree on **shape**; the Zod schema
is additionally strict about **values** (at least one category, no duplicates, no unknown keys,
`shieldMessage` ≤ 120 chars, `preShiftWarningMinutes` ≤ 120, at most 20 trimmed non-empty notes of ≤ 200
chars — see `RESTRICTION_CONFIG_LIMITS`). Anything the API accepted therefore always passes the guard,
and `DEFAULT_RESTRICTION_CONFIG` is within every limit. When adding a field, change the interface here,
the Zod schema, `isRestrictionConfig`, and the iOS decoder together.

## 11. Out of scope

Manager **overrides** (§ overrides: exempt temporarily, end early, emergency policy override) are a
runtime layer applied by the Work Mode state machine _on top of_ the resolved policy; they do not change
which policy resolves and are not visible to `resolvePolicy`.
