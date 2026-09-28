# Token Windows release process

## Release authority

The Windows release artifact is the per-user assisted NSIS
`Token-Setup.exe`. Every install or reinstall replaces the user's
`commandcode-models.json` with the catalog bundled in that installer. Normal
Backend startup never performs this replacement. A portable ZIP is not published
for Windows. Users with the older Squirrel install uninstall it first; the user
`.Token` directory is preserved.

One Forge Package and NSIS build invocation owns one candidate. Tests receive the absolute path
of that invocation's packaged `Token.exe`; no release test may select a
candidate by modification time. The tested Setup.exe is copied to the release
directory without rebuilding or recompressing it.

## Commands

- Change only the root `package.json` `version`, then run
  `npm run release:sync-version`. The root version is the release authority;
  this command synchronizes every shipped workspace version, exact internal
  `@token/*` dependency, and `package-lock.json`, then runs the version
  certification gate.
- `npm run release:candidate` builds and certifies a local candidate. Dirty or
  unsigned candidates are allowed for development, machine installation is
  skipped to avoid touching the developer's user state, and the manifest is
  not promotable. A disposable blank Windows user may opt into the same machine
  check with `TOKEN_RELEASE_MACHINE_CERTIFY=1`.
- `npm run release:windows` is the official gate. It requires a clean Git
  worktree and the two `TOKEN_WINDOWS_CERTIFICATE_*` environment
  variables. It never accepts a reused build directory.
- `.github/workflows/windows-release.yml` runs that same official command on
  `windows-2022` after `npm ci`. Configure the repository secrets
  `WINDOWS_CERTIFICATE_PFX_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`; the
  certificate is materialized only in the runner's temporary directory and is
  removed in an always-run cleanup step.

## Blocking sequence

1. Verify TypeScript, lint, the production dependency audit,
   certification/unit tests, and integration tests. The release pretest first
   rebuilds and assembles the current root Backend so the installed-layout version
   test cannot reuse stale output. Release Vitest workers are capped at four so
   process-owning integration tests are not invalidated by Windows resource
   starvation.
2. Build workspace packages and assemble the fixed Backend runtime.
3. Run Electron Forge Package and electron-builder NSIS once.
4. Require exactly one packaged EXE and one Setup.exe from that output directory.
5. Verify the packaged layout and distribution packages.
6. Run packaged Electron journeys against the selected absolute EXE, including
   a genuinely blank user profile. The Data Plane must run, recovery must be
   absent, and Anthropic plus CommandCode Private must appear through both the
   Control Plane catalog and the Providers UI.
7. In official or explicitly opted-in machine certification, silently install
   the selected Setup.exe in a blank Windows user, verify the user catalog is
   byte-equivalent by SHA-256 to the installed bundled authority, replace the
   user file with sentinel content, silently reinstall the same candidate and
   verify the bundled authority replaces it again. Then launch the app and
   verify its Backend and Provider catalog, run the UI test against the installed
   EXE, stop all installed processes, uninstall it, and prove user state is
   preserved.
8. For an official release, require valid Authenticode signatures on the
   installer and installed EXE.
9. Copy the exact NSIS installer and write `release-manifest.json` with
   commit, dirty state, Backend build identity, hashes, sizes, certification
   results, and promotability.

Any failed step stops publication. The CommandCode catalog is intentionally
not migrated across schema versions: the certified Windows install/reinstall
contract replaces it with the current bundled schema. Other persisted
configuration follows the normal compatibility policy. macOS/Linux remain
structurally supported but are not certified release authorities, so this
Windows replacement guarantee must not be generalized to those platforms.
