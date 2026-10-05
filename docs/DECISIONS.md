# Decisions & Assumptions Log

Each entry records a choice made autonomously during the build, why, and what to change if the
assumption is wrong. Newest at the bottom.

## D-001 — New repository at `~/workmode`
No existing repository matched the brief (see `REPO_AUDIT.md`). Created a fresh git repo on `main`.

## D-002 — Pin Next.js 15.5, Prisma 6.19, TypeScript 5.9, Vitest 3, ESLint 9
The registry's `latest` tags were Next 16, Prisma 7 (8 rc), TypeScript 7 (native), Vitest 5, ESLint 10.
The spec names Next.js 15 and `prisma migrate dev`; Prisma 7 replaced `datasource.url` + `prisma-client-js`
with `prisma.config.ts` + driver adapters, and TypeScript 7 is the Go port with incomplete tooling support.
Pinning to the last stable line of each keeps the toolchain predictable. Upgrade path: bump one major at a time.

## D-003 — pnpm `minimumReleaseAge` policy kept; three packages pinned one patch back
pnpm 11 refuses packages published < 24h ago. `typescript-eslint@8.71.1`, `@vitejs/plugin-react@6.1.2`
and `postcss@8.5.29` were published the day of the build, so `8.70.1`, `6.1.1`, `8.5.28` are pinned.
This is a supply-chain safety feature and intentionally left on.

## D-004 — Postgres on port 5433, Docker Compose, two databases
A Supabase stack on this machine already occupies 54321–54327; 5432 is kept free for any system Postgres.
`docker/postgres-init.sql` creates `workmode` and `workmode_test` with `citext` + `pgcrypto`.
Integration tests use `TEST_DATABASE_URL` and reset that database; they never touch dev data.

## D-005 — Single root `.env` loaded with `dotenv-cli`
Prisma and Next.js each look for `.env` in their own package. One root `.env` (from `.env.example` via
`pnpm setup:env`) is passed to every script with `dotenv -e ../../.env --`, so there is a single source
of configuration and nothing to keep in sync.

## D-006 — Internal packages consumed as TypeScript source (no build step)
`@workmode/shared`, `@workmode/validation`, `@workmode/db` export `./src/*.ts`. Next.js
`transpilePackages`, Vitest and `tsx` all consume TS directly. `build` for these packages is `tsc --noEmit`.
Simpler than maintaining `dist/` outputs; revisit only if a non-TS consumer appears.

## D-007 — First-party manager session auth instead of Auth.js v5 / Better Auth
The spec allows "Auth.js (NextAuth v5) or Better Auth". NextAuth v5 is still a beta line; Better Auth
imposes its own `user/account/session/verification` tables that conflict with the spec's `User` model
(`password_hash`, `email_verified_at` on the user). Email+password with argon2id, DB-backed sessions,
hashed/expiring reset + verification tokens, CSRF (origin check + double-submit), and rate limiting
are ~400 lines of well-understood code that match the §3 schema exactly and are fully covered by
integration tests. No OAuth is required for the MVP. If social login is needed later, Auth.js can be
layered on the same `User` table.

## D-008 — OpenAPI generated in-house from Zod 4 (`z.toJSONSchema`)
Zod 4 ships JSON-Schema export. A small route registry in `@workmode/validation` emits
`docs/openapi.json` without a third-party OpenAPI adapter whose Zod 4 support is uncertain.

## D-009 — iOS: XcodeGen `project.yml` is the source of truth; generated `.xcodeproj` committed
Hand-maintaining `project.pbxproj` for four targets is error-prone. `make generate` regenerates it.
Bundle id placeholder `com.workmode.app` (+ `.devicemonitor`, `.shieldconfig`, `.shieldaction`),
App Group `group.com.workmode.app.shared`, `DEVELOPMENT_TEAM` left blank in `Signing.xcconfig`.
No code-signing identity exists on the build machine, so real-device runs are documented, not executed.

## D-010 — Prisma config via `prisma.config.ts`, migrations committed, `db push` never used
`package.json#prisma` is deprecated; `prisma.config.ts` (`defineConfig`) holds schema path and seed command.
