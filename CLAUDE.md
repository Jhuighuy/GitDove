# GitDove — notes for agents

Electron Git GUI. Goal: GitKraken-level feature parity (minus AI), performance and robustness first,
first-class SSH remotes.

## Commands

- `npm run dev`: run the app (electron-vite, HMR for the renderer).
- `npm run typecheck && npm run lint && npm test`: run before committing; also `npm run format`.
  `npm run test:unit` skips the slow integration tests (real git, shells, watchers; the list is in
  `vitest.config.ts`) for a fast inner loop. Tests ignore the global and system git config
  (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`), so set any git config a test needs explicitly.
- `npm run build && node scripts/drive.mjs <scenario.mjs> <outDir>`: drive the built app with
  Playwright and take screenshots; exits non-zero if the scenario throws. A scenario module
  default-exports `async ({ app, page, shot })`. Use `GITDOVE_USER_DATA=<dir>` with a `state.json`
  (`{tabs, activeTab, recent}`) to preload tabs; without it a throwaway profile is used.
- Packaged apps have Electron fuses set (`electron-builder.yml`): no `ELECTRON_RUN_AS_NODE`
  (so no `child_process.fork` of the app binary; use `utilityProcess`), no `NODE_OPTIONS` or
  `--inspect`, and code loads only from the integrity-checked `app.asar`.
- `ssh fedora` has test repositories in `~` (e.g. `~/cholx`). `~/vcpkg` (31k commits) is a good
  local performance test.

## Conventions

- Main process code is Effect v4 (`effect@4`): services are `Context.Service` classes, layers are
  built in `src/main/index.ts`, and errors are `Data.TaggedError` values in `src/main/exec/errors.ts`.
  In v4, `Effect.catchAll` is `Effect.catch` and `Effect.async` is `Effect.callback`.
- Every IPC method is declared in `src/shared/ipc.ts` (`Api`) and implemented in `src/main/ipc.ts`
  (`handlers`). Keep payloads structured-clone friendly.
- Git commands go through `Repository.git()`, which adds safe `-c` options. Validate revisions and
  names (`validateRev`) and pass paths after `--` or through `--pathspec-from-file`.
- Anything that runs remotely must stay POSIX `sh` compatible and minimize round trips. SSH commands
  go through a persistent remote runner (`exec/runner.ts`, one session per host); streaming output
  (`onStdout`) and large stdin use one SSH session per command (sshd allows about 10 per connection).
- Renderer: TanStack Query for repository data (keys in `lib/queries.ts`; staleness is driven by
  events), zustand for UI state, shadcn components in `components/ui` (generated, do not hand-edit
  heavily). User-facing operations go through `features/commands.ts`, which shows toasts on error.
- TypeScript 7 (`tsc` is the native compiler), oxlint and oxfmt.
