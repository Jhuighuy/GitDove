# GitDove

A fast, open-source Git GUI with first-class support for repositories on remote machines over SSH.

GitDove starts out as a clean-room reimplementation of the GitKraken workflow (commit graph, branch
sidebar, staging panel, diffs) and will diverge from there. It is built with performance and
robustness as the top priorities.

## Features

- **Commit graph:** virtualized, streams in incrementally, and handles 30k+ commit histories
  smoothly. Lanes are colored per branch; stashes show as single nodes.
- **Remote repositories over SSH:** git runs on the remote host over one multiplexed SSH
  connection (`ControlMaster`), using your `~/.ssh/config` and agent. The repository browser marks
  git repositories as you navigate.
- **Staging:** stage and unstage files or individual hunks, discard changes, and commit (with
  amend).
- **Branches, tags and stashes:** checkout, create, rename, delete, merge, rebase, cherry-pick,
  revert, reset (soft, mixed or hard), stash, pop, apply and drop.
- **Remotes:** fetch, pull (fast-forward, merge or rebase) and push (with upstream setup and force
  with lease).
- **Live updates:** native file watching for local repositories and cheap fingerprint polling for
  remote ones.
- **Tabs:** several repositories open at once, restored on restart.
- **Over-the-air updates:** delivered from GitHub releases.

## Development

Requires Node.js 24+ and `git`; `ssh` is needed for remote repositories.

```bash
npm install
npm run dev        # start the app with hot reload
npm test           # unit tests
npm run typecheck
npm run lint
npm run format
npm run dist       # package installers into release/
```

Run the integration smoke test against real repositories:

```bash
GITDOVE_INT_LOCAL=~/some/repo GITDOVE_INT_SSH=myhost:/path/to/repo npx vitest run int
```

`scripts/drive.mjs` launches the built app under Playwright for scripted UI checks and
screenshots. Set `GITDOVE_USER_DATA` to use an isolated profile.

## Architecture

| Layer           | Location       | Notes                                                                                                                                                              |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared contract | `src/shared`   | Domain types and the typed IPC API (`Api`, `Events`).                                                                                                              |
| Main process    | `src/main`     | [Effect](https://effect.website) services: `Hosts` (local and SSH command execution), `Repos` (open repositories, watchers), `Repository` (git operations, graph). |
| Preload         | `src/preload`  | Exposes a minimal `window.gitdove` bridge (`invoke`, `on`).                                                                                                        |
| Renderer        | `src/renderer` | React 19, Tailwind 4, shadcn/ui on Base UI, TanStack Query and Virtual, and zustand for UI state.                                                                  |

All git work happens in the main process by spawning `git`, either locally or via `ssh host -- git …`.
The renderer never touches the file system. Query results are cached with TanStack Query and
invalidated by `repo.changed` events from the watchers, so the UI never polls.

Releases: bump `version` in `package.json`, then push a `vX.Y.Z` tag. The release workflow builds
for macOS, Windows and Linux and publishes a GitHub release that installed apps update from. Signed
macOS builds are required for auto-update on macOS (see `electron-builder.yml`).

## License

[MIT](LICENSE)
