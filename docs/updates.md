# Updates and releases

## How updates work

Installed apps update from the latest GitHub release. They check on startup and every 4 hours,
download in the background, and show a toast once an update is ready: **Restart** installs it
right away, otherwise it is installed when GitDove quits. **Check for Updates…** (in the GitDove
menu on macOS, Help elsewhere) checks immediately. Development builds never check.

**Windows and Linux** use electron-updater with the `latest.yml` and `latest-linux.yml` manifests
that electron-builder generates. The manifests carry each file's SHA-512, but they are published in
the same GitHub release as the files, so these updates are only as trustworthy as the GitHub
account and the release workflow; there is no signature independent of GitHub (the Windows builds
are not code-signed either).

**macOS** builds (Apple silicon only) use [Sparkle](https://sparkle-project.org). Electron's own
macOS updater requires a build signed with an Apple Developer ID, and GitDove has none. Instead,
macOS builds are ad-hoc signed, and Sparkle accepts an update only if both the feed
(`appcast.xml`) and the ZIP carry an Ed25519 signature from our key.

- `native/macos/Updater.swift` is a small helper app that runs Sparkle on GitDove's behalf.
  Packaging embeds it, with Sparkle.framework, in `GitDove.app/Contents/Frameworks`
  (`scripts/sparkle.mjs`, run from `scripts/after-pack.mjs`). It also writes the Sparkle settings
  into GitDove's `Info.plist`: feed URL, public key, check interval.
- `src/main/sparkle.ts` starts the helper and talks to it over JSON lines (the protocol is
  described at the top of `Updater.swift`). On Restart, Sparkle quits GitDove, replaces the bundle
  and relaunches it. When GitDove quits on its own, the helper exits and Sparkle's installer
  replaces the bundle afterwards.
- The Sparkle version and the SHA-256 of its release archive are pinned in `build/sparkle.json`,
  along with our public key and the feed URL.

## Releases

Every push to `main` that passes CI is published as the latest release. Its version is the
`major.minor` from `package.json` plus the CI run number, e.g. `0.1.57`. Bump `major.minor` in
`package.json` to start a new series. The run number belongs to the workflow: renaming or
recreating `ci.yml` restarts it, and the release job then refuses to publish versions older than
the latest release (with a warning), so bump `major.minor` at the same time.

The pipeline is in `.github/workflows/ci.yml`:

1. **Package** (pushes to `main`, and pull requests that touch packaging or updates) builds the
   macOS (arm64), Windows and Linux packages. On macOS it also verifies the code signature
   (`codesign --verify --deep --strict`) and runs `scripts/test-updates.mjs` (below).
2. **Release** (pushes to `main` only) first checks with `release.mjs check` that every file keeps
   its name when uploaded to GitHub (which turns spaces into dots) and that every file named in
   `latest*.yml` is there with the listed checksum; a mismatch would make updates fail to
   download. It then signs the macOS ZIP and writes `appcast.xml` with `scripts/release.mjs`,
   which refuses a key or package that installed apps would not accept, and publishes everything
   as a GitHub release. It never moves the latest release backwards, and a rerun replaces a draft
   left by an interrupted upload.

The packaged apps have Electron's [fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
set (`electronFuses` in `electron-builder.yml`): GitDove's binary cannot be run as plain Node
(`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`), and it only loads its code from `app.asar`,
whose integrity is checked against the hash embedded at packaging time.

### The signing key

The Ed25519 private key is the `SPARKLE_PRIVATE_KEY` secret of the `release` environment (base64,
as exported by Sparkle's `generate_keys -x`); its public half is in `build/sparkle.json`. Keep a
backup outside GitHub: if the key is lost, macOS users must download the next version by hand. To
replace the key, first release a build that embeds the new public key, signed with the old key.

Only the release job uses the `release` environment. Set it up once under **Settings →
Environments → release**:

- **Deployment branches and tags:** selected branches, `main` only. Workflow runs for other
  branches and pull requests then cannot read the key, even if they edit `ci.yml`.
- **Environment secrets:** add `SPARKLE_PRIVATE_KEY`, then delete the repository-level secret of
  the same name (**Settings → Secrets and variables → Actions**). Until the repository secret is
  deleted, every workflow run can still read it.

### Distribution limits

macOS builds are not notarized, so the first launch of a downloaded GitDove is blocked. Open
**System Settings → Privacy & Security** and click **Open Anyway**. Updates installed by Sparkle
are not affected. Windows builds are unsigned, so SmartScreen warns on first install.

## Testing

```bash
npm run build
npm run package -- --mac          # release/<version>/mac-arm64/GitDove.app
node scripts/test-updates.mjs release/0.1.0/mac-arm64/GitDove.app
```

`test-updates.mjs` makes throwaway copies of the packaged app (versions 1.0.0 and 1.0.1), serves
the update from a loopback server with a test key, and checks with real Sparkle that:

- a tampered update is rejected;
- a downloaded update is installed when GitDove quits, without relaunching it;
- clicking Restart in the toast installs the update and relaunches GitDove.

The copies use their own bundle identifier and user data, so an installed GitDove is not affected.
Set `CASE` to run only the matching cases.
