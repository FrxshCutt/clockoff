# Repository Audit (Stage 1)

_Date: 2026-10-05. Author: Claude (autonomous build run)._

## What existed before this run

**Nothing.** The task was started from `~` (not a git repository) and no directory on the machine
contained a Work Mode / shift-blocking project. Sibling directories were inspected to be sure:

| Directory                                                         | What it is                                               | Relevance                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `~/routeready`, `~/clutchup-site`, `~/lockedin`, `~/drivetest-ai` | Unrelated apps (learner-driver, fitness, marketing site) | None — left untouched                                                   |
| `~/downshift`                                                     | pnpm + Turborepo monorepo (API gateway)                  | Confirms the pnpm/Turbo toolchain works on this machine; no code reused |
| `~/tripeaks-advisor`, `~/polymarket-paper-trader`                 | Unrelated                                                | None                                                                    |
| `~/supabase`, `~/app`, `~/lib`                                    | Empty scaffolding                                        | None                                                                    |

Therefore a **new repository was created at `~/workmode`** (`git init -b main`). There is no
existing code to preserve or replace; everything in this repo is new in this run.

## Machine / toolchain inventory

| Tool                    | Version                    | Notes                                                                                                                                            |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node                    | 24.15.0                    | `.node-version` pins 24                                                                                                                          |
| pnpm                    | 11.10.0                    | `allowBuilds` + `minimumReleaseAge` policy active (see DECISIONS)                                                                                |
| Docker                  | 29.6.1                     | Desktop was stopped; started for Postgres. A Supabase stack already uses 54321–54327, so Work Mode Postgres uses **5433**                        |
| Xcode                   | 26.6 (17F113), Swift 6.3.3 | iPhone 17 Pro simulator booted                                                                                                                   |
| XcodeGen                | 2.46.0                     | Installed this run (brew) to generate the Xcode project from `apps/ios/project.yml`                                                              |
| Code-signing identities | **none**                   | Real-device Screen Time testing is impossible on this machine; simulator + `MockRestrictionProvider` is used and the device steps are documented |
| psql                    | not installed              | `docker exec workmode-postgres psql …` is used instead                                                                                           |

## Decisions on stack (full rationale in `docs/DECISIONS.md`)

- Monorepo exactly as the spec's §2 layout: `apps/web`, `apps/ios`, `packages/{db,shared,validation,config}`, `docs`.
- Next.js **15.5** (spec says 15; 16 is current but outside the spec), React 19, TypeScript 5.9, Tailwind 4, shadcn/ui.
- Prisma **6.19** (Prisma 7/8 change the config/driver model; 6 is the stable line the spec's `prisma migrate dev` workflow assumes).
- Zod **4**, Vitest 3, ESLint 9 flat config, Turborepo 2.
- Manager auth is a small first-party session implementation (argon2id, DB sessions, hashed tokens) rather than Auth.js/Better Auth — see DECISIONS for why.

## What will be built

Everything in the specification, in the order of §16. Nothing is kept from a prior codebase and nothing is replaced.
