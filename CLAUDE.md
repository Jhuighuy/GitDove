# GitDove — notes for agents

Electron Git GUI. Goal: GitKraken-level feature parity (minus AI), performance and robustness first,
first-class SSH remotes.

## Commands

- `npm run dev`: run the app (electron-vite, HMR for the renderer). Unpackaged runs use their own
  profile (`<userData>-dev`) and log file (`dev.log`).
- `npm run typecheck && npm run lint && npm test`: run before committing; also `npm run format`.
  Vitest has two projects: `unit` and `integration` (real git, shells, watchers; the list is in
  `vitest.config.ts`). `npm run test:unit` runs only the fast unit tests. Tests ignore the global
  and system git config (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`), so set any git config a test
  needs explicitly. `GITDOVE_INT_SSH_HOST=fedora` also runs the `Repository` tests over SSH.
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
  In v4, `Effect.catchAll` is `Effect.catch` and `Effect.async` is `Effect.callback`. Logs go to
  the app log through `LoggerLive`; start background fibers with `Repository.fork` (or a layer's
  FiberSet), not a bare `Effect.runFork`, so they log there and are interrupted at quit.
- Every IPC method is declared in `src/shared/ipc.ts` (`Api`), and has an argument schema
  (`argSchemas`, checked against `Api` at compile time) and a handler (`handlers`) in
  `src/main/ipc.ts`: requests are decoded before dispatch. Keep payloads structured-clone friendly.
  Read-only methods listed in `CANCELLABLE_METHODS` can be cancelled (`apiWithSignal`, which query
  functions use with TanStack's `signal`); writes never are.
- Git commands go through `Repository.git()`, which adds safe `-c` options. Validate revisions and
  names (`validateRev`, `validateBranchName`, …), put `--` before names, refs and paths, and pass
  paths through `--pathspec-from-file` when there can be many. Commands that take paths use
  `--literal-pathspecs` (`LITERAL`), per command: some (e.g. `stash pop`) break with it globally.
- Anything that runs remotely must stay POSIX `sh` compatible and minimize round trips. All SSH
  commands, including streaming output and large stdin, go through one persistent runner per host
  (`exec/runner.ts`, chunked frames); plain SSH sessions are only a fallback when the runner cannot
  start. Failed connections back off per host; `Hosts.connect` (a user's request) retries at once.
  The local host's id is `LOCAL_HOST` (`"<local>"`), never a literal.
- Repositories are open while some renderer uses them (`Repos`); hidden ones (`repo.setVisible`)
  poll rarely and defer watcher events and graph checks until shown.
- Renderer: TanStack Query for repository data (keys in `lib/queries.ts`; staleness is driven by
  events, background tabs only go stale), zustand for UI state, shadcn components in
  `components/ui` (generated, do not hand-edit heavily). User-facing operations go through
  `features/commands.ts`, which shows toasts on error.
- TypeScript 7 (`tsc` is the native compiler), oxlint and oxfmt.
