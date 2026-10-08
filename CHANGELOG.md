# Changelog

## 1.6.3 (2026-10-09)

### Fixed

- **A wired nested plugin now registers with its own id** (`src/wire-tui.ts`,
  `src/index.ts`, `test/wire-tui.test.js`). A nested ref is registered into
  `cli.json` as its tree DIRECTORY, and a directory load does not resolve
  `package.json` `exports["."]`. The host therefore listed the plugin with no
  id (`-`) even when the tree declared one - `oc-flight-deck` reported `-`
  instead of `flight-deck.host`. `wireTui` now also ensures a marker-owned root
  `index.ts` re-exporting the ref's declared server entry (`gh.meta.path`, from
  the resolve provenance) - the server half of what the TUI wrapper is for the
  TUI half. It never writes over a user-authored entry, removes itself when one
  appears beside it, and refuses loudly when the declared entry is not a real
  file inside the tree. The no-TUI skip path writes nothing.
- **Tests** (`test/wire-tui.test.js`): seven new cases - wrapper written for the
  declared target, idempotent repeat mount, no wrapper without the option, a
  user entry never clobbered, a managed wrapper removed beside a user entry, a
  loud refusal on a broken declaration, and no wrapper on the skip path.

## 1.6.2 (2026-10-09)

### Fixed

- **Registry belt covers the full control-character range - defence in depth
  (severity LOW)** (`src/registry.ts`, `test/registry.test.js`). The
  `FORBIDDEN_SPECIFIER_CHARS` belt covered newline, CR, NUL and tab but not
  the rest of the control range, so a direct `resolveRegistryPlugin` call with
  a hand-built `spec.bare` containing e.g. BEL, VT, ESC or DEL missed the
  named belt refusal and failed later with a generic message. The belt is now
  `/[&|;`$"\'(){}\[\]\\\x00-\x1f\x7f]/`, so every control character draws the
  named `refusing to install ... forbidden shell metacharacter` refusal on
  both the parser path and the direct-resolver path. Legal range syntax is
  untouched (`^ ~ * > < =` space, `pkg@latest`, `pkg@1.2.x`, `pkg@~1.2.0`).
- **Tests** (`test/registry.test.js`): four new hostile specifiers (BEL, VT,
  ESC, DEL) each asserting the NAMED refusal from both the parser and the
  resolver with the injected installer NEVER called, plus `pkg@latest`,
  `pkg@1.2.x` and `pkg@~1.2.0` positive range cases.

### Checks

- `npm run check` green (335 pass, 2 skip, 0 fail).
- `OC_BIFROST_REGISTRY_LIVE=1 node --test test/registry.test.js` green (32 pass, 0 fail).

## 1.6.1 (2026-10-09)

### Fixed

- **Command injection on Windows in the registry-install path - SECURITY
  (severity HIGH)** (`src/registry.ts`, `test/registry.test.js`). The 1.6.0
  range charset accepted `&` and `|`, and the npm fallback spawned `npm.cmd`
  via `cmd.exe /c`, so a specifier such as `pkg@1&...` was parsed by `cmd.exe`
  as a SECOND command - arbitrary command execution as the user. Defence in
  depth, both layers:
  - **The shell boundary is gone.** `bun` still spawns directly (a real `.exe`,
    no shell), and the npm fallback now runs npm's own JS entry (`npm-cli.js`)
    through the current JS runtime (`process.execPath`) with `shell: false`
    and an argv array - the `npm.cmd` shim (which can only run via a shell) is
    never invoked. A specifier now travels as one argv element: metacharacters
    reach the manager as data, never as syntax. On Windows with no shell-free
    npm entry found, the fallback is skipped loudly instead of reaching for a
    shell.
  - **Impossible characters are refused as a belt.** A bare spec carrying any
    of `& | ; \` `` ` `` `$ " ' ( ) { } [ ]` or control chars (newline, CR,
    NUL, tab) draws the named `refusing to install ... forbidden shell
    metacharacter` refusal - in the parser AND at the top of
    `resolveRegistryPlugin` before any installer runs. Legal range syntax
    (`^ ~ * > < =` space, e.g. `pkg@>=1.0.0 <2.0.0`, `pkg@^1.2.3`) still
    resolves and installs: the shell removal is what makes it safe.
- **Tests** (`test/registry.test.js`): eight hostile specifiers (`&`, `|`,
  `^&`, `;`, backticks, `$(...)`, newline, tab) each asserting the NAMED refusal
  from both the parser and the resolver with the injected installer NEVER
  called, plus a positive case proving a legitimate complex range still
  installs end to end.

### Checks

- `npm run check` green (331 pass, 2 skip, 0 fail).
- `OC_BIFROST_REGISTRY_LIVE=1 node --test test/registry.test.js` green (28 pass, 0 fail).

## 1.6.0 (2026-10-09)

### Added

- **Registry specifiers - `options.plugins` mounts from the npm registry**
  (`src/registry.ts`, `src/index.ts`): bare names (`oc-todo`, `oc-todo@0.4.0`,
  `@scope/pkg@^1.0.0`, `pkg@latest`) and `npm:` / `pnpm:` / `bun:` prefixed
  forms (the prefix is stripped and the remainder treated as the bare spec).
  bifrost installs the package itself - the host installer drops `npm:` alias
  specs and ships no pnpm/bun installer - by spawning `bun add --exact` first
  (the host runs on bun) with an `npm install --no-save --legacy-peer-deps`
  fallback, into a bifrost-owned cache dir mirroring the github convention
  (`<cacheRoot>/registry/<safe-id>/`). Zero runtime dependencies (node
  builtins + a spawned manager, never imported). Cache-first; the installed
  entry (resolved via its own `package.json` `exports`/`main`) must exist
  before import or the mount fails loudly. It mounts whatever it resolves to:
  V1 bridges, V2 runs its native `setup`, classified by the existing
  `src/discover.ts`. **Alias honesty:** `pnpm:`/`bun:` install through the same
  spawned manager, and the mount note says so plainly (never implying a real
  pnpm/bun install happened).
- **Tests** (`test/registry.test.js`): bare `name`, `name@version`,
  `name@range`, `name@tag`, `@scope/name@version`, each of `npm:`/`pnpm:`/`bun:`,
  the alias-honesty note, and malformed-spec refusals - all hermetic behind an
  injectable fake installer - plus ONE opt-in live case
  (`OC_BIFROST_REGISTRY_LIVE=1`) that really installs `escape-string-regexp@5.0.0`.

### Checks

- `npm run check` green (322 pass, 2 skip, 0 fail).

## 1.5.0 (2026-10-09)

### Changed

- **Three `partial` compat rows behaviour-upgraded, each with a write-back test** (`src/hooks.ts`, `src/compat-matrix.ts`): `tool.execute.after` now writes `error.message` and metadata on the failure branch; `chat.message` writes back `prompt.files`, `prompt.agents`, and `prompt.skills`; `experimental.chat.system.transform` preserves the non-text parts it does not touch.
- **Shape-aware alignment for `system.transform` + `messages.transform`** (`src/hooks.ts`): the write-back aligns returned messages by shape, so an add, remove, or reorder no longer misattributes an edit across messages.
- **A non-string `input.tool` reassignment now warns** (`src/hooks.ts`): the bridged `tool.execute.before` input keeps the V1-era tool name, and a hook that replaces it with a non-string is warned about instead of silently corrupting the call.
- **`serverUrl` placeholder + helper-only V1 mount warnings** (`src/context.ts`, `src/index.ts`): the facade states the `serverUrl` boundary out loud, and a V1 module that only carries helpers warns instead of mounting empty.
- **V2 `setup` options forwarding** (`src/index.ts`): a V2 definition's own entry options reach its `setup` call instead of being dropped.
- **Degraded message shape fixed** (`src/hooks.ts`): a degraded message always carries a string `role` and no `sessionID`.

### Checks

- `npm run check` green (304 pass, 1 skip, 0 fail).

## 1.4.5 (2026-10-07)

### Changed

- **A pushed release tag must name the version in `package.json`** (`.github/workflows/release.yml`). The publish job now compares the pushed tag (`GITHUB_REF_NAME`) against the version in `package.json` and fails before `npm publish` on a mismatch, so a stale tag can no longer publish from an unintended commit. A `workflow_dispatch` run carries no tag ref, so the guard is skipped there and the manifest version publishes.

- **CI runs the check on both supported Node lines** (`.github/workflows/ci.yml`). The `check` job now uses a `node-version` matrix of `[22, 24]` instead of Node 24 alone, matching the `node >=22` floor the README advertises.

- **The README setup steps carry the consumer verify command** (`README.md`). The copy-paste install block now ends with `opencode plugin check`, then `opencode plugin list` (shows what actually loaded), so a consumer confirms the mount instead of guessing.

### Checks

- `npm run check` green (289 pass, 1 skip, 0 fail).

## 1.4.4 (2026-10-06)

### Fixed

- **A re-provisioned plugin no longer accumulates duplicate `cli.json` entries**
  (`src/wire-tui.ts`, `src/index.ts`, `src/github.ts`). The managed TUI entry is
  a `file://` URL into a cache dir whose name embeds the resolved ref/commit, so
  a new commit minted a new URL that the exact-string dedupe never matched - the
  previous managed entry was left behind and one more was appended per resolved
  ref (observed live: five `nathwn12--oc-flight-deck--<commit>--...` trees, five
  entries). A managed entry now carries a ref-independent plugin key in its
  marker (`sha256(owner\0repo\0path)[0:16]`); before adding the new entry, the
  mount path removes the previous managed entry for that key, and the append
  dedupe compares parsed values. Entries written before this release are
  migrated by an exact canonical-shape match (equal 4-segment cache-dir names on
  owner, repo, and the digest-stripped tail). User entries and other plugins'
  managed entries are never removed.

## 1.4.3 (2026-10-01)

### Fixed

- **A managed `tui.tsx` wrapper is now healed, not trusted** (`src/wire-tui.ts`).
  Trees wired by the pre-derive release carry a hardcoded
  `export { default } from "./src/tui/index.tsx"` wrapper even when the package
  ships no `src/tui/index.tsx`; the TUI client then fails at `stage=read` with
  `Cannot find module './src/tui/index.tsx'`, which the host surfaces as a
  misleading "Plugin failed" toast and a failed count in the footer -
  `rtk-ai/rtk`, `obra/superpowers`, and `d3vv3/opencode-ascii` were affected;
  `nathwn12/oc-flight-deck` was unaffected, because its package genuinely ships
  `src/tui/index.tsx`. 1.4.2 fixed the cold path only: an already-fetched
  (warm-cache) tree keeps its stale wrapper, so 1.4.3 heals it on the next
  reconciliation.
- **The wrapper target is derived BEFORE any existing wrapper file is
  consulted** (`src/wire-tui.ts`). A tree with no derivable `./tui` target is
  skipped cleanly - no wrapper and no `cli.json` entry - instead of being wired
  through a wrapper that cannot resolve.
- **A wrapper this module wrote is ours to heal.** It is identified by its
  ownership marker, or by the exact bytes the pre-derive release wrote; it is
  removed when there is no derivable target, and rewritten when the target
  moved. A user-authored `tui.ts` / `tui.tsx` is never deleted or rewritten,
  and a managed `tui.tsx` that would shadow a user's `tui.ts` is removed -
  under Bun, `.tsx` resolves before `.ts`, and the host resolves a directory
  target as `path.resolve(dir, "tui")` with no `exports` consultation - so the
  tree stays wired through the user's own file.
- **The heal unwires the tree it healed, and only that tree.** The
  previously-dead `unwireTui` is now called with the healed tree's own
  `file://` entry, so a managed `cli.json` entry is removed for that tree and
  never for another.
- **Managed `cli.json` entries are matched by parsed value**, so a
  single-quoted or escape-spelled entry is still recognized as ours.
- **The `skipped` row reports truthfully:** its reason claims an unwire only
  when the unwire actually happened.

## 1.4.2 (2026-09-30)

### Changed

- **Republish of 1.4.1, whose provisioning fixes are unchanged.** 1.4.1 was never
  consumable, because its publish completed only partially on the registry: the
  version manifest and the version-status endpoint exist, but the tarball and the
  packument update never completed, so the version cannot be repaired and the
  identical change set ships as 1.4.2.

### Fixed

- **Host-store provisioning now resolves dependencies from the client's real
  per-package npm-cache layout** (`src/provision.ts`). The lookup scans the
  `node_modules` of EVERY per-package install root, so a hoisted peer that lives
  inside another package's install root - not under a root named for it - is
  resolved too. Still zero network, still no manual junctions.
- **`provision: "npm"` is hardened with `--legacy-peer-deps`.** A plain
  `npm install` ERESOLVEs on this peer set, so the fallback refused instead of
  installing; the flag lets the declared dependency set install.
- **Provision rows survive an entry-import failure** (`src/index.ts`). When a
  tree's entry import failed, its provision rows were swallowed with it; the
  provisioning result is now kept and reported even as the import fails.
- **The TUI wrapper target is derived from the package's own `./tui` export**
  (`src/wire-tui.ts`). Trees without a TUI entry are skipped cleanly - no wrapper
  and no `cli.json` entry - instead of producing broken entries.

## 1.4.1 (2026-09-30)

### Fixed

- **Host-store provisioning now resolves dependencies from the client's real
  per-package npm-cache layout** (`src/provision.ts`). The lookup scans the
  `node_modules` of EVERY per-package install root, so a hoisted peer that lives
  inside another package's install root - not under a root named for it - is
  resolved too. Still zero network, still no manual junctions.
- **`provision: "npm"` is hardened with `--legacy-peer-deps`.** A plain
  `npm install` ERESOLVEs on this peer set, so the fallback refused instead of
  installing; the flag lets the declared dependency set install.
- **Provision rows survive an entry-import failure** (`src/index.ts`). When a
  tree's entry import failed, its provision rows were swallowed with it; the
  provisioning result is now kept and reported even as the import fails.
- **The TUI wrapper target is derived from the package's own `./tui` export**
  (`src/wire-tui.ts`). Trees without a TUI entry are skipped cleanly - no wrapper
  and no `cli.json` entry - instead of producing broken entries.

## 1.4.0 (2026-09-30)

- Provision fetched GitHub snapshots from the OpenCode host npm store via junction, with consent-gated npm fallback and loud refusals.
- Add opt-in TUI wiring for fetched GitHub snapshots.
- Add tests: `resolveGithubPlugin: cold fetch provisions the tree's declared deps from the host store and the entry now imports`; `wireTui: true wires a mounted github: snapshot into the caller-provided cli.json`.

## 1.3.3 (2026-09-30)

### Changed

- **Per-spec in-flight serialization closes the shared-cache first-fetch race
  under multi-location loads** (`src/github.ts`). When the host activates the
  same configured package from several locations at once, two concurrent
  `resolveGithubPlugin` passes for the same `github:` spec used to race the
  same cache entry: pass B could land mid-materialization, see `tree` without
  a provenance record, fire the "never overwrite an incomplete cache"
  refusal, and its rollback then removed the partial state pass A was still
  writing - so every reload re-fetched and the mount never completed. A
  module-level in-flight map keyed by the derived cache directory now makes
  the second pass await the SAME fetch/materialize promise; a settled fetch
  (fulfilled or failed) clears the entry, so a warm cache still loads with
  zero network and a failed fetch is retried exactly as before.
  `test/github.test.js` pins the behaviour -
  `resolveGithubPlugin: CONCURRENT first fetches for the same spec share ONE
  codeload fetch (no race on the shared cache)`: two concurrent calls with a
  deliberately delayed tarball response both resolve, make exactly ONE
  codeload fetch, write provenance once, and the next load is a zero-network
  verified hit.

### Checks

- `npm run check` green (198/198).

## 1.3.2 (2026-09-30)

### Changed

- **A fully-pinned 40-hex `github:` ref resolves with zero GitHub API calls**
  (`src/github.ts`). Such a ref already IS the commit identity the resolution call
  would only echo back, so `resolveCommit` short-circuits on it before any API
  surface is reached - fully-pinned specs now mount even on hosts where the
  unauthenticated REST API is refused. `test/github.test.js` pins the behaviour:
  a 40-hex ref with the API forced to 404 still mounts, makes zero API calls,
  skips the default-branch lookup, and fetches the snapshot by the pinned commit.

### Checks

- `npm run check` green (197/197).

## 1.3.1 (2026-09-29)

### Changed

- **V1 factory discovery now recognises by shape, not just by name** (`src/discover.ts`). Any
  named function export is a V1 factory candidate; the legacy `/Plugin$/` name heuristic survives
  only as a preference for modules whose first function export is a helper. Plugins whose factory
  carries no `Plugin` suffix (SystemPromptLogger, DirenvLoader) now mount instead of being
  refused as unknown modules.
- **Bridged tool-hook input presents the V1-era tool name.** V2 registers its shell tool as
  `shell` (`packages/core/src/tool/plugin/shell.ts:22`), while V1-era plugins gate on
  `"bash"`; `src/hooks.ts` now presents `bash` for `shell` in bridged hook input, and every other
  tool name passes through unchanged.
- **`session.idle` is synthesised from the terminal execution events, not `session.status[idle]`.**
  V2 `session.execution.succeeded|failed|interrupted` - the durable events the host emits when a
  session run ends (`packages/schema/src/session-event.ts:246-257`, exactly what the client's own
  idle derivation reads at `packages/client/src/solid/data.ts:1025-1028`) - are translated to the
  V1 `session.idle` envelope. `session.status` never reaches the plugin feed on 2.0.18, so the
  earlier synthesis is gone rather than kept as a dead path. The matrix event row matches. All
  other event names and payloads pass through unchanged.
- **The docs record the dogfood run and the compat merge.** Flight 2 sampled ten plugins
  against the packed artifact and its verdicts are recorded (PROOF.md Proof 11,
  VERIFIED-PLUGINS.md), and README.md / SKILL.md pin 1.3.1 with the matrix agreeing with
  `src/compat-matrix.ts`.

### Checks

- `npm run check` green (196/196).

## 1.3.0 (2026-09-29)

### Added

- **The `client` facade now bridges the session domain it can actually reach.**
  `client.session.messages` returns the V1 `{ data: [{ info, parts }] }` envelope from
  `ctx.session.context`, preserving `role`, `modelID`, `providerID`, `tokens`, `time`,
  `cost`, and `finish` - **partial: post-compaction history only**, because V2 exposes
  the active context (messages after the last compaction) and the HTTP
  `session.messages` route is unreachable from a plugin. The loss is stated on the
  matrix row, not hidden.
- **`session.idle` is synthesised from V2 `session.status[idle]`.** All other event
  names and payloads pass through unchanged.
- **Two facade calls stay refused, loudly:** `client.session.children` and
  `client.tui.showToast`. V2 has no plugin-scoped child listing and no server-plugin
  toast surface; each refusal cites the V2 boundary it cannot cross instead of
  inventing one. A refusal is a feature.

### Changed

- **The token-tracker verdict is recorded, and the README matrix matches
  `src/compat-matrix.ts`.** A live mount of `eserete/opencode-token-tracker@6a634805`
  shows the synthesised `session.idle` reaching the tracker and its refused
  `client.session.children` call swallowed by the tracker's own blanket catch
  (`token-tracker.js:190-192`). `VERIFIED-PLUGINS.md`, `PROOF.md` (Proof 10), and the
  README matrix now agree on the same totals: 6 `full`, 9 `partial`, 9 refused over
  all 24 rows.

### Checks

- Tests green (`npm run check`), including the facade envelope round-trip, the loud
  refusals, the `session.idle` translation, and an end-to-end mount of the real
  cached `token-tracker.js`.

## 1.2.0 (2026-09-29)

### Added

- **`github:` resolves plugins by repository snapshot.** The ref still resolves to a
  commit once, at first fetch, but the download is now the **repository tarball from
  codeload at that resolved commit**, materialized as a whole tree — the entry file is
  imported from its real place inside it, so sibling files exist beside it (e.g.
  `obra/superpowers` reads its own `skills/`). One request, no tree walk.
- **Named caps, never truncation:** 16 MiB compressed · 64 MiB uncompressed · 5000
  files. A breach degrades loudly; it never silently cuts a tree.
- **Loud single-file fallback.** An over-cap, malformed, or candidate-less snapshot
  still mounts via the old one-file fetch, but the mount note then says loudly that
  sibling files are NOT available and a plugin that reads them by relative path is
  inert — the downgrade is never silent.
- **Hostile archives are refused outright, never materialized.** A path escape
  (absolute, `..`, outside the top-level directory), NUL/backslash names, Windows
  alternate-data-stream `:`, duplicate paths, or a link/device entry refuses the
  snapshot — nothing is cached and nothing is executed.
- **Cache layout `v2`, flat caches warned.** Snapshots live at
  `~/.cache/opencode/oc-bifrost/github/v2/<id>/tree/`; a pre-snapshot single-file cache
  at `…/github/<id>/` can never be mistaken for a snapshot — it is ignored with a
  warning and re-fetched with the same one-time consent. `meta.json` now records the
  tarball digest and the file/tree byte counts alongside the entry digest.

### Fixed

- **Archive reader NUL truncation could rename hostile input.** `readField` /
  `readCString` trimmed at the first embedded NUL, so an entry named e.g.
  `nul\0name.txt` silently became the Windows device name `nul`. Embedded NULs now
  survive decoding and reach the validators, which refuse them; only trailing NUL
  padding is trimmed. Numeric fields keep their spec truncation, and trailing-slash
  directory markers are skipped rather than misread as files.

### Checks

- 181 tests green (`npm run check`) plus a real-repo end-to-end: the
  `obra/superpowers@8ca22dba` snapshot materializes 229 files, with `skills/` readable
  beside the entry.

## 1.1.0 (2026-09-29)

### Added

- **Durable mount report — the proof surface now survives discarded stdout.** Every line the
  reporter emits is mirrored to a file, because the console is structurally unreachable where the
  report matters most: the V2 host spawns the background service with stdout ignored
  (`packages/client/src/service-contender.ts`), stdio mode uses stdout as the JSON-RPC channel, and
  the plugin loader does not wrap console (`packages/core/src/plugin/module.ts`).
  - **Default path:** `~/.cache/opencode/oc-bifrost/report.log`
    (`$XDG_CACHE_HOME/opencode/oc-bifrost/report.log` when set) — the same shared user cache the
    `github:` artifacts live under.
  - **Override / disable:** `OC_BIFROST_REPORT=<path>`, or `OC_BIFROST_REPORT=off`.
  - **Policy:** append across loads; hard-capped at 256 KiB, where a write that would cross the cap
    rolls the file over so the newest report survives whole. Control characters are escaped before
    they reach disk. Console behaviour is unchanged, and a sink failure is warned about once and
    never breaks a mount.

### Changed

- **The README and `VERIFIED-PLUGINS.md` now document both mounting routes.** V1 hook modules get
  hook translation; a V2-shaped `export default { id, setup | effect }` mounts as-is, and a
  dual-export file (a V1 named export plus a V2 default, e.g. `obra/superpowers@v6.4.2`) takes the
  V2 pass-through route with its V1 named export left untouched. Both docs also restate that
  `github:` / local / `preset:` are the only accepted sources (npm specifiers are refused) and that
  the seven refused V1 hooks still need a real port.

## 1.0.1

### Fixed

- **The `github:` cache no longer lands in every project you open.** Fetched plugins are now stored
  under the shared OpenCode user cache — `$XDG_CACHE_HOME/opencode/oc-bifrost/github/<id>/`
  (default: `~/.cache/opencode/oc-bifrost/github/<id>/`) — instead of a fresh `<project>/legacy/cache/`
  per working directory. One verified copy now serves every project.
  Because the move changes the cache location, the cache is **cold on upgrade**: the first mount
  re-fetches once and needs the same one-time opt-in it needed the first time. Old
  `<project>/legacy/cache/` directories are no longer read or written and can be deleted.

## 1.0.0

First stable release.

### Changed

- **`github:` is now the single advertised mounting route.** The README quick start, `INSTALL.md`,
  and the `skills/oc-bifrost` skill all lead with mounting a plugin by source.
- **`preset:rtk` is documented as the optional offline / no-fetch fallback** — clearly marked as a
  fallback, for offline or air-gapped hosts — rather than as the worked example.
- **The version gate is now stated truthfully** — `github:` requires oc-bifrost 0.4.0 or later;
  releases 0.3.0 and below cannot mount it. **No behavior change from 0.4.0.**

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
