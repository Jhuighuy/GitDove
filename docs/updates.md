# Updates and releases

GitDove uses Sparkle 2.10.0 on macOS and electron-updater on Windows and Linux.
macOS builds use ad-hoc code signing, with no Apple Developer ID certificate or
notarization. Sparkle authenticates both the update feed and ZIP archive with our
Ed25519 update key before extracting or installing the update.

The public key, pinned Sparkle distribution checksum, and feed location are in
`build/sparkle.json`. The private seed is stored as the repository Actions secret
`SPARKLE_PRIVATE_KEY`. That secret is available only to the release signing step,
after a successful push-to-main CI run. PR packaging and tests use no release key.

## Release pipeline

Every PR and push to `main` runs checks and produces distribution packages for
macOS arm64/x64, Windows x64, and Linux x64. Each package gets the same version:
the source package's major/minor version plus the CI workflow run number as its
patch version, for example `0.1.25`. Rerunning a CI run preserves that version.
Change major/minor in `package.json` when starting a new release series.

The macOS jobs perform an isolated A (`1.0.1`) to B (`1.0.2`) update proof using
temporary Ed25519 keys and ad-hoc signing. An altered archive must be rejected
without replacing A; the valid archive must replace A and relaunch B. Evidence is
uploaded as the `update-proof-arm64` and `update-proof-x64` CI artifacts.

The macOS jobs also test actual packaged GitDove copies: the renderer displays the
Restart toast in A, clicking it completes Electron's shutdown, Sparkle replaces
the bundle, and B must load its renderer and attest its runtime version. These
copies use a unique app identity and isolated user-data directory. The production
app's packages and update key are left untouched.

After packaging, the release validation job checks that all platform artifacts
exist, use one version, and match the Windows/Linux update metadata checksums.
It also verifies each macOS bundle's identity, version, embedded feed/public key,
and code signature.

Only a successful CI run triggered by a push to this repository's `main` can
start the Release workflow. It checks out that exact tested commit and downloads
packages from that exact run. It verifies that the private key matches the
embedded public key, then signs the macOS archives and architecture-specific
appcasts. It uploads every asset to a draft GitHub release before publishing it.
An older run cannot move the latest release backwards. Failed uploads remain
drafts, and reruns can resume them.

The Sparkle feeds are `appcast-arm64.xml` and `appcast-x64.xml` in the latest GitHub
release. Windows/Linux retain electron-builder's `latest.yml` and
`latest-linux.yml` metadata. Packages and metadata are published together.

## Application behavior

Packaged apps check on startup and every four hours. Updates download in the
background. Once the verified update is ready, the app displays a persistent
Restart action. Help > Check for Updates can trigger another check. Development
builds do not check for updates.

On macOS, a small native subprocess bridges Sparkle's user-driver callbacks to
Electron over JSON lines. Sparkle owns archive validation, replacement, permission
prompts, and relaunch. The updater/installer outlives Electron during replacement;
Electron disposes repository watchers and SSH connections before quitting.

## Local verification

```sh
npm ci
npm run typecheck
npm run lint
npm run test:coverage
npm run test:updates  # macOS: real replacement/relaunch plus tamper rejection
npm run build
npm run package -- --mac --arm64
npm run test:updates:electron -- release/0.1.0
```

`npm run test:updates` uses a loopback-only HTTP server, temporary app bundles,
unique bundle identifiers, and temporary signing keys. It never replaces an
installed GitDove app or touches a user's repository checkout. Its JSON result is
saved to `out/update-proof/result-<arch>.json`. Local HTTP exceptions exist only in
these disposable fixtures; production feeds and downloads use HTTPS.

Sparkle's source and binary license notice is included in the updater helper.
The framework download is pinned and its SHA-256 is verified before extraction.

## Signing key maintenance and distribution limits

A backup of the current update key is stored in the maintainer's macOS Keychain
under the Sparkle key account `dev.gitdove.app`. Sparkle's `generate_keys --account
dev.gitdove.app -p` shows its public key; `-x <secure-file>` exports its private
seed for a protected backup. Losing this key may require users to reinstall
manually. Changing the embedded key requires a planned migration.

Ad-hoc signing and Ed25519 update signatures do not provide Apple notarization
or an Apple-verified publisher identity. A first installation can require manual
approval in macOS Privacy & Security. No system Gatekeeper settings are disabled.
Windows packages are also unsigned unless a Windows signing service is configured.

Existing builds using the old macOS Squirrel updater need one manual installation
of a Sparkle-enabled release. Subsequent updates use Sparkle. The Release workflow
starts publishing after this change is merged; it does not publish from a PR.
