# Changelog

## 0.4.0

### Added

- **`github:` - mount a V1 plugin BY SOURCE, not only from a local copy.** A plugin can now be
  named from its repository instead of from a path on disk:

  ```
  github:obra/superpowers
  github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts
  ```

  The spec is `github:<owner>/<repo>[@<ref>][#<path>]`. The ref is resolved to a commit sha at
  first fetch and the bytes are downloaded **by that commit, never by the ref**, so a ref that
  moves cannot produce a `meta.json`/bytes disagreement. The verified artifact is written under
  `legacy/cache/<safe-id>/` with its `meta.json` beside it, and later mounts load from there with
  **zero network**. A cached artifact is never silently replaced because a ref moved; deleting the
  cache directory is the documented refresh.
- **A consent gate on the first fetch.** A cold cache **refuses** to fetch and execute unless you
  opted in for that oc-bifrost entry (`trustRemote: true`) or in the environment
  (`OC_BIFROST_TRUST=github`). The refusal names exactly what would be downloaded, that it would run
  with the host process's full user rights, and both exact opt-ins. This is trust-on-first-use as a
  human decision, never a silent default. A warm, hash-verified cache mounts with **no consent and
  no network**: the opt-in is about the first fetch, not about every mount.

### Changed

- **The install docs now name exactly three paths, in order: by source (above) first, then
  `preset:rtk`, then a local file.** A local copy is the last resort, not the advertised path.

### Security

- Cache writes go through one shared boundary (`validateCachePath`) that runs before **any** fetch
  or write: root and entry must each be absent or a real directory - never a symlink - and
  realpath-contained. Writes are temp+rename with restrictive modes and roll back on failure,
  leaving no partial file and no temp leftover. A partial cache refuses rather than re-fetching.
- Remote bodies are read incrementally under a size cap and are never dumped into a message.
  Refusals are sanitized: control characters from specs, URLs, or remote responses are escaped
  before they reach a message.
- **Stated limit, not a hidden one:** the sha256 in `meta.json` sits beside the file it pins, so it
  detects corruption and accidental drift and **cannot** defend against an attacker who already has
  the user's own rights. The docs say so where the check is described.

### Fixed

- **The shipped `vendor-update` script now explains why it cannot run from an installed copy.** It
  rewrites `src/preset.ts`, which is not part of the published package, so running it from inside
  `node_modules` previously failed with a bare `ENOENT`. The message now names the cause and the fix,
  and `vendor/README.md` states the source-checkout requirement before the command list.
- **Six published claims that the code did not back are corrected or removed**, including a
  verification row with no test behind it, a hook count that was off by one, and wording that
  implied a registry mount could do what only a source mount does.

## 0.3.0

### Added

- **Freshness notice — the pin can no longer go stale silently.** The mount report always names
  the pinned upstream version (offline, zero network). An **opt-in** check
  (`freshness: "online"`, or `OC_BIFROST_FRESHNESS=online`) compares that pin against the latest
  upstream release and warns, with both update paths, when the vendored copy is behind.
- **`npm run vendor:update`** — one command to refresh the vendored RTK plugin and every copy of
  its pin: it downloads (or takes `--from-file` for offline/CI), **verifies the bytes against an
  independent record** — GitHub's own blob id on the network path, or a caller-supplied
  `--expect-sha256` / `--expect-blob` offline (a real offline run refuses to write without one) —
  rewrites `vendor/rtk.ts`, `vendor/rtk.meta.json`, the table in `vendor/README.md`, and the
  version in `src/preset.ts`, then runs the full check. `--dry-run` previews without writing; a
  failed check prints the exact revert. Refs are validated and inserted literally, so a hostile
  tag cannot corrupt the pin.
- **`vendor/rtk.meta.json`** — machine-readable provenance (sha256, git blob, bytes, ref,
  license, upstream).
- **A provenance drift guard** (`test/provenance.test.js`) — recomputes the hashes from the real
  vendored bytes and fails if the three copies of the pin disagree.

### Changed

- `PRESETS`, `compareTags`, `pinnedNote`, `freshnessEnabled`, and `checkFreshness` are exported
  from the package root.
- `package.json` now ships `scripts/` so the provenance tooling is auditable in the tarball.

### Security

- **Runtime auto-fetch was REFUSED, deliberately.** Fetching the upstream plugin at install or
  load time would execute unverified remote code, would silently break the recorded provenance
  (the sha256 / git blob / license that make the vendored copy auditable), and would break offline
  installs. The freshness check is therefore a comparison only — it downloads and runs no plugin
  code — and is **off by default**; updating stays a deliberate, human-run, verified step.
- No new dependencies, runtime or dev. The freshness check uses only `globalThis.fetch` and
  `AbortSignal.timeout`, never throws, and reports `unknown` (informational, not a warning) on any
  failure — an offline machine is not an error.

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
