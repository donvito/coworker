# Releasing

Installers for macOS, Windows, and Linux are attached to every [GitHub release](https://github.com/donvito/coworker/releases/latest).

| Platform | File |
| --- | --- |
| macOS (Apple silicon) | `Coworker-<version>-mac-arm64.dmg` |
| macOS (Intel) | `Coworker-<version>-mac-x64.dmg` |
| Windows | `Coworker-<version>-win-x64-setup.exe` (also `arm64`) |
| Linux | `Coworker-<version>-linux-x64.AppImage` or `.deb` |

## After you download

The builds are not code-signed yet, so the OS warns on first launch:

- **macOS** — Open the DMG and drag Coworker to `/Applications`. Right-click the app and choose *Open*, or run
  `xattr -dr com.apple.quarantine "/Applications/Coworker.app"`.
- **Windows** — SmartScreen: *More info* → *Run anyway*.
- **Linux** — `chmod +x Coworker-*.AppImage` before running it.

## Publishing a release

Installers are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
on a matrix of macOS, Windows and Ubuntu runners, then attached to a GitHub release.

```sh
# bump "version" in package.json first
git tag v0.1.0
git push origin v0.1.0
```

Pushing a `v*` tag builds all three platforms and publishes the release. Re-running the
workflow manually (**Actions → Release → Run workflow**) with an existing tag rebuilds it
and re-uploads the assets to the same release.

Nothing in the dependency tree is native — the database is `node:sqlite` — so each runner
packages its own platform without a rebuild toolchain. Signing is not configured: add
`CSC_LINK`/`CSC_KEY_PASSWORD` (macOS) and `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (Windows)
as repository secrets, and drop `identity: null` from `build.mac`, once certificates exist.
