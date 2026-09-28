# Changelog

## 0.2.0

### Added

- **`preset:rtk`** — the bundled showcase.
  `"plugins": ["preset:rtk"]` mounts the verbatim upstream RTK V1 plugin
  (`rtk-ai/rtk` `v0.50.0`, Apache-2.0) with nothing fetched at install time, and probes for the
  `rtk` binary **first** — so a missing prerequisite is a loud, actionable message instead of a
  mount that silently rewrites nothing.
- **Stranded-file detection.** Warns when a file that looks like a V1 plugin sits in a plugin
  *discovery* directory (`plugin/`, `plugins/`), where OpenCode V2 rejects it before this bridge can
  run. That trap is invisible today: the error mentions neither discovery directories nor the
  bridge.
- **`~` expansion** in `options.plugins` specifiers — a reliable way to name a global path.
- `PRESETS` is now exported from the package root, so agents can introspect the preset list.

### Changed

- **`strict` is now coherent.** It aborts setup on *anything* that prevented a mount — an
  unsupported V1 hook, an unresolvable specifier, a missing preset binary, a failed import, or a
  failed mount — rather than on only some of those. Without `strict`, a bad entry is still skipped
  and the remaining plugins mount.
- **`package.json` gained `main` and an `exports` `default` condition.** The `exports` map is only
  consulted for bare specifiers, so a path-based directory lookup found nothing and the host
  dropped the plugin **silently**. `main` fixes path-based resolution.
- **The `rtk` probe now separates "absent" from "installed but invisible".** If the binary is on
  `PATH` but the plugin's own `which rtk` preflight cannot resolve it (real on Windows without
  Git-for-Windows), the message says exactly that instead of claiming the binary is missing.

### Fixed

- **A failed plugin import is no longer silent.** The warning now names the spec as written, the
  directory it resolved against, the resolved target, the underlying error, and a concrete fix. A
  global install that used a relative path used to "succeed" and do nothing.
- **The published tarball now ships the docs the README links to.** `files` previously listed only
  `dist`, `README.md`, and `LICENSE`, so `INSTALL.md`, `PROOF.md`, `VERIFIED-PLUGINS.md`,
  `CONTRIBUTING.md`, and `skills/` were 404s on npm — and the agent-first instructions live in
  exactly those files.

### Security

- No new runtime dependencies. The vendored file is byte-identical to upstream and its sha256 is
  recorded in `vendor/README.md`.

## 0.1.0

- First release. V1 hook → V2 registration bridge with a 21-row compatibility matrix
  (`src/compat-matrix.ts`): 5 `full`, 9 `partial`, 7 refused out loud.
