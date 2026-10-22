# GitDove

[![CI](https://github.com/Jhuighuy/GitDove/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Jhuighuy/GitDove/actions/workflows/ci.yml?query=branch%3Amain)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=Jhuighuy_GitDove&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Jhuighuy_GitDove)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=Jhuighuy_GitDove&metric=coverage)](https://sonarcloud.io/component_measures?id=Jhuighuy_GitDove&metric=coverage)

A fast, open-source Git GUI with first-class support for repositories on remote machines over SSH.

GitDove starts out as a clean-room reimplementation of the GitKraken workflow (commit graph, branch
sidebar, staging panel, diffs) and will diverge from there. It is built with performance and
robustness as the top priorities.

## Features

- **Commit graph:** virtualized, streams in incrementally, and handles 30k+ commit histories
  smoothly. Lanes are colored per branch; stashes show as single nodes.
- **Remote repositories over SSH:** git runs on the remote host over one multiplexed SSH
  connection (`ControlMaster`), using your `~/.ssh/config` and agent. A persistent POSIX `sh`
  runner on the remote pipelines commands, so most git calls cost a fork instead of an SSH session.
  Nothing is installed on the remote. The repository browser marks git repositories as you navigate.
- **Staging:** stage and unstage files or individual hunks, discard changes, and commit (with
  amend).
- **Branches, tags and stashes:** checkout, create, rename, delete, merge, rebase, cherry-pick,
  revert, reset (soft, mixed or hard), stash, pop, apply and drop.
- **Remotes:** fetch, pull (fast-forward, merge or rebase) and push (with upstream setup and force
  with lease).
- **Live updates:** native file watching for local repositories and cheap fingerprint polling for
  remote ones.
- **Tabs:** several repositories open at once, restored on restart.
- **Author avatars:** taken from GitHub (including noreply emails), GitLab (gitlab.com or
  self-hosted, detected from the remote's host) and Gravatar, and cached on disk. Commit emails
  (or their hashes, for Gravatar) are sent to those services; GitHub and GitLab are only queried
  for repositories hosted there.
- **Over-the-air updates:** every push to `main` becomes a GitHub release that installed apps
  download in the background ([docs/updates.md](docs/updates.md)).

## Development

Requires Node.js 24.2+ and `git`; `ssh` is needed for remote repositories.
The macOS app requires macOS 26+ on Apple silicon. Local packaging needs Apple's Command
Line Tools for the updater helper; a full Xcode installation is optional.

```bash
npm install
npm run dev           # start the app with hot reload
npm test              # all tests: unit and integration (real git, shells and file watchers)
npm run test:unit     # unit tests only, for a fast inner loop
npm run test:coverage # all tests with LCOV coverage in coverage/lcov.info
npm run typecheck
npm run lint
npm run format
npm run dist          # package installers into release/ (macOS: arm64 only)
```

The icon artwork lives in `build/icon.svg`. Run `npm run icons` after editing it to
regenerate the committed exports, including the vector layers in `build/Fold.icon`.
Open `build/Fold.icon` in Icon Composer to edit the background, glass materials and
appearance variants; regeneration preserves these settings in `icon.json`. The dove's
paper facets share one glass surface, above the separate Git branch. The branch uses
filled outlines so the glass renderer doesn't highlight an implicit closing edge.
During macOS packaging, `scripts/before-pack.mjs` selects `Fold.icon` when the active
`actool` compiler is version 26 or newer. Otherwise it uses the committed `build/icon.icns`
fallback. Xcode 26+ is only needed to compile the Liquid Glass asset catalog (`Assets.car`);
Icon Composer alone can preview it. CI packages with Xcode so releases keep the layered
icon. The choice depends on the build machine: users running the packaged app need
neither Xcode nor Icon Composer. Windows and Linux use the static exports.

`npm run icons` refreshes the `.icns` fallback on macOS using the system `iconutil`
(no Xcode needed); on other platforms it preserves the committed `.icns`.

The repository tests create throwaway repositories under `/tmp` and ignore your global and system
git configuration. Set `GITDOVE_INT_SSH_HOST` to also run them on a remote host over SSH (CI uses
an SSH server on localhost):

```bash
GITDOVE_INT_SSH_HOST=myhost npm test
```

Run the integration smoke test against real repositories:

```bash
GITDOVE_INT_LOCAL=~/some/repo GITDOVE_INT_SSH=myhost:/path/to/repo npx vitest run int
```

CI runs on pull requests and pushes to `main`, including a
[SonarCloud analysis](https://sonarcloud.io/dashboard?id=Jhuighuy_GitDove) that fails if the quality
gate fails. The scan imports Vitest coverage from `coverage/lcov.info` and uses the repository's
`SONAR_TOKEN` Actions secret and the settings in `sonar-project.properties`, which also lists the
rules this project ignores and why. SonarCloud's Automatic Analysis must be disabled under
**Administration > Analysis Method** when using this CI analysis. Pull requests from forks and
Dependabot run the usual checks but skip the scan because GitHub does not expose repository
secrets to them.

`scripts/drive.mjs` launches the built app under Playwright for scripted UI checks and
screenshots. It uses the profile in `GITDOVE_USER_DATA`, or a throwaway one if that is unset.

## Architecture

| Layer           | Location       | Notes                                                                                                                                                              |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared contract | `src/shared`   | Domain types and the typed IPC API (`Api`, `Events`).                                                                                                              |
| Main process    | `src/main`     | [Effect](https://effect.website) services: `Hosts` (local and SSH command execution), `Repos` (open repositories, watchers), `Repository` (git operations, graph). |
| Preload         | `src/preload`  | Exposes a minimal `window.gitdove` bridge (`invoke`, `on`).                                                                                                        |
| Renderer        | `src/renderer` | React 19, Tailwind 4, shadcn/ui on Base UI, TanStack Query and Virtual, and zustand for UI state.                                                                  |

All git work happens in the main process. Local repositories spawn `git` directly. For a remote
host, GitDove keeps one multiplexed SSH connection (`ControlMaster`) and a persistent POSIX `sh`
runner on the host that executes commands sent over its stdin, so a git call costs a fork on the
remote rather than a new SSH session; commands that stream output or take large input use a
session of their own. The renderer never touches the file system. Query results are cached with TanStack Query and
invalidated by `repo.changed` events from the watchers, so the UI never polls.

Releases: every push to `main` that passes CI is packaged for macOS (Apple silicon), Windows and
Linux and published as the latest GitHub release. Installed apps update from it (Sparkle on macOS,
electron-updater elsewhere). See [docs/updates.md](docs/updates.md) for the pipeline, the signing
key and how to test updates.

## License

[MIT](LICENSE)
