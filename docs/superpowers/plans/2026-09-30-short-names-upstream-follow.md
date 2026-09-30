# Short Names + Upstream Auto-Update Implementation Plan (1.5.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live config's long `github:` spec strings with short registry aliases that float to upstream (or deny loudly when upstream is unreachable), landing as oc-bifrost 1.5.0.

**Architecture:** A user-editable alias registry (`registry.json` under the shared OpenCode cache, seeded from a bundled default) maps short names to full specs plus a per-entry update policy (`off` | `line` | `branch`). A new zero-API tip resolver shells out to `git ls-remote` (atom-feed fallback for branch entries) and classifies each float entry as `updated` / `up-to-date` / `denied`. The `github:` fetch path performs that tip check before its pinned fetch and reports old->new sha provenance; a denied update still serves the last verified snapshot with `fetched: false`. Provisioning reuses Phase 1's `provisionTree`.

**Tech Stack:** Node/Bun, zero new runtime deps, Node test runner (`test/*.test.js` against `dist/`), `node:child_process` spawn (args array, no shell), injected `fetchImpl`/`spawnImpl` seams, `compareTags` from `src/freshness.ts`, Windows `.cmd` shim precedent.

**Spec:** `docs/superpowers/specs/2026-09-30-short-names-upstream-follow.md` (this plan argues from that spec; it travels with it). Phase 1 provisioning (1.4.0) lands first in its own worktree and is a hard prerequisite - this plan calls its `provisionTree`.

## Global Constraints

- Zero runtime dependencies (`package.json` has `"dependencies": {}`; `CONTRIBUTING.md:30`) - tip resolution shells out to `git`, never imports anything new; provisioning shells out to npm (Phase 1).
- `npm run check` (typecheck + build + test) must be green after every task; repo rule: one logical change per commit.
- Refusal classes stay loud (`report.ts` pattern): nothing silently dropped; `strict: true` turns any failure into a setup abort. Denial rows name the alias, the endpoint, and the status/error.
- Provenance invariants unchanged: sha256 pins the tarball + entry file; caps (16 MiB / 64 MiB / 5000 files) unchanged; `update` re-verifies the tarball sha256 on every float. New `updatedFrom` provenance records old->new sha.
- **No `api.github.com` anywhere.** Tip resolution is `git ls-remote` (primary) + atom feeds (branch fallback) only.
- `trustRemote` (or `OC_BIFROST_TRUST=github`) is the single consent gate; update + provisioning are covered by the same consent - the report must say so.
- Full long spec strings (no registry entry) stay static and byte-for-byte unchanged in behavior.

## Review Focus

1. **Alias classification + refusal rows** - a bare name must become an alias lookup while `npm:`, `@scope/name`, `file:`, `preset:`, `~`, `./`, `../`, and absolute paths must NOT; an unknown alias must produce a loud row naming the alias AND the registry path. Test in Task 1: `isAliasCandidate` truth table + `resolveAlias` unknown-alias throw message.
2. **Registry corruption + seed atomicity** - corrupt JSON, wrong shape, missing seed, and unreadable `vendor/registry.seed.json` must each produce a loud refusal (never a silent empty registry), and the seed-on-absent write must be atomic (temp + rename), never a partial user file. Test in Task 1: each corrupt/missing input asserts the throw, and the seed write leaves no `*.tmp-*` sibling.
3. **ls-remote parsing** - peeled `^{}` shas must be preferred over tag-object shas, `refs/tags/*` vs `refs/heads/<branch>` must be distinguished, and an empty ref list must classify as denied, never "up-to-date". Test in Task 2: `parseLsRemote` over a fixture with annotated + lightweight tags + a branch, and empty stdout.
4. **Semver-line newest-tag selection** - `v0.9` vs `v0.10` (numeric, not lexicographic), tags without a `v` prefix, and pre-release tags (excluded from `line`). Test in Task 2: `selectLineTag` over mixed tag fixtures.
5. **Full-sha baseline float transition** - a 40-hex source with `update: "branch"` must float from the sha to the branch tip; a 40-hex source with `update: "line"` must be static (not an error) with a loud row. Test in Task 2: `defaultUpdatePolicy` + `nextUpdate` on full-sha baselines.
6. **Offline/unreachable -> denial + stale-cache honesty** - when `ls-remote` and the atom fallback both fail, a warm cache must serve the last verified snapshot with `fetched: false` AND a denial row, and `strict: true` must abort setup. Test in Task 3 with a `noNetwork()` fetch and a failing spawn.
7. **Update->provision wiring order** - a float update must fetch the new pin, provision it (`provisionTree`), then import; a denial must never skip provisioning of the served snapshot. Test in Task 3: a float entry that updates and whose new tree declares a dependency mounts with the provision row before the mount row.

---

### Task 1: Alias registry (load / validate / seed / resolve)

**Files:**
- Create: `src/registry.ts`
- Create: `vendor/registry.seed.json`
- Test: `test/registry.test.js`

**Interfaces:**
- Consumes: `safe()` from `src/github.ts` (established pattern - `github.ts` does not runtime-import `registry.ts`, so there is no cycle). The ref is extracted from `source` with a self-contained `@<ref>` regex (no import of the `github:` parser).
- Produces:
  - `export type UpdatePolicy = "off" | "line" | "branch"`
  - `export function defaultUpdatePolicy(source: string): UpdatePolicy` - `"off"` for a 40-hex ref, `"line"` for a tag ref (`/^v?\d+\.\d+\.\d+/`), else `"branch"`.
  - `export interface RegistryEntry { source: string; update: UpdatePolicy; branch?: string }`
  - `export interface Registry { aliases: Record<string, RegistryEntry> }`
  - `export function registryPath(homeDirectory?: string, env?: NodeJS.ProcessEnv): string` - `path.join(env.XDG_CACHE_HOME || path.join(homeDirectory, ".cache"), "opencode", "oc-bifrost", "registry.json")`; `OC_BIFROST_REGISTRY` (a path) overrides.
  - `export function isAliasCandidate(spec: string): boolean` - `false` when the spec starts with `github:`, `npm:`, `file:`, `preset:`, `~`, `./`, or `../`, is an absolute path (`path.isAbsolute`), or matches `/^@[^/]+\/[^/]+$/`; otherwise `true`.
  - `export function validateRegistry(input: unknown, source: string): Registry` - shape-check + fill defaults (a missing `update` is filled via `defaultUpdatePolicy(source)`); throws `[oc-bifrost]` refusal on any gap.
  - `export function loadRegistry(opts?: { path?: string; seedPath?: string; homeDirectory?: string; env?: NodeJS.ProcessEnv }): Registry` - reads the file, or atomically seeds from the bundled default when absent; corrupt/missing-when-expected -> throw.
  - `export function resolveAlias(alias: string, registry: Registry, registrySource: string): RegistryEntry` - lookup; unknown -> throw naming alias + `registrySource`.
  - `export function resolveEntrySpec(spec: string, registry: Registry, registrySource: string): { spec: string; update: UpdatePolicy; branch?: string }` - alias -> `{ spec: entry.source, update, branch }`; non-alias -> `{ spec, update: "off" }`.

- [ ] **Step 1: Write the failing tests** - `test/registry.test.js` (Node test runner, `fs.mkdtempSync` temp dirs like `test/github.test.js`'s `tmpRoot`):
  - `registryPath`: with `homeDirectory` and empty env returns `.../opencode/oc-bifrost/registry.json`; with `env.OC_BIFROST_REGISTRY = "/custom/r.json"` returns `/custom/r.json`; with `XDG_CACHE_HOME` set, that wins over `.cache`.
  - `isAliasCandidate` truth table: `"rtk"`, `"superpowers"`, `"ascii"`, `"flight-deck"` -> `true`; `"github:o/r"`, `"npm:pkg"`, `"@scope/name"`, `"file://x"`, `"preset:rtk"`, `"~/x"`, `"./x"`, `"../x"`, an absolute path -> `false`.
  - `defaultUpdatePolicy`: `"...@e42bb23f...40-hex..."` -> `"off"`; `"...@v0.50.0..."` -> `"line"`; `"...@main..."` -> `"branch"`.
  - `validateRegistry`: the seed shape parses to 4 aliases; a missing `update` fills by ref (`...@v0.50.0...` -> `"line"`, `...@<40-hex>...` -> `"off"`, `...@main...` -> `"branch"`); wrong types (`aliases` not an object, `source` not a string, `update: "nope"`) each throw `/\[oc-bifrost\]/`.
  - `resolveAlias`: `resolveAlias("rtk", reg, "/tmp/r.json")` -> `{ source: "github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts", update: "line" }`; unknown `resolveAlias("nope", reg, "/tmp/r.json")` throws `/unknown plugin alias "nope"/` AND `/\/tmp\/r\.json/`.
  - `loadRegistry` seed-on-absent: empty temp dir + `seedPath` pointing at `vendor/registry.seed.json` -> writes `registry.json` (content equals the seed's `aliases`), no `*.tmp-*` sibling left (Review Focus 2).
  - `loadRegistry` corrupt/missing: a registry file of `not json` throws `/not usable/`; `loadRegistry` with a missing file AND a missing seed throws `/not usable/` (never returns an empty registry).
  - `resolveEntrySpec`: `resolveEntrySpec("rtk", reg, p)` -> `{ spec: "github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts", update: "line" }`; `resolveEntrySpec("github:o/r", reg, p)` -> `{ spec: "github:o/r", update: "off" }`.

- [ ] **Step 2: Run tests - expected FAIL** (`Cannot find module .../dist/registry.js`).
- [ ] **Step 3: Implement `src/registry.ts`** per the interfaces. Validation is strict and pure; every refusal carries the `[oc-bifrost]` prefix and sanitizes the offending value via `safe()`. Seed-on-absent writes through a temp file + `fs.renameSync` (mode `0o600`), creating the parent dir first; a write failure throws and removes the temp file.
- [ ] **Step 4: Run `npm run check` - PASS (all prior suites + new).**
- [ ] **Step 5: Commit** - `git add src/registry.ts vendor/registry.seed.json test/registry.test.js && git commit -m "feat(registry): alias registry with seeded short names and loud refusals"`.

### Task 2: Tip resolution engine (ls-remote + atom fallback + policy)

**Files:**
- Create: `src/update.ts`
- Test: `test/update.test.js`

**Interfaces:**
- Consumes: `UpdatePolicy` + `defaultUpdatePolicy` (Task 1, `src/registry.ts`), `parseGithubSpec`/`GithubSpec` + `safe` (existing, `src/github.ts`), `compareTags` (existing, `src/freshness.ts`).
- Produces:
  - `export interface GitRef { sha: string; ref: string }` - `sha` is the 40-hex peeled commit (lowercase); `ref` is the tag/branch name.
  - `export interface SpawnLike { (command: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): { status: number | null; stdout: string; stderr: string; error?: Error } }`
  - `export type TipResult = { kind: "ok"; sha: string; ref: string; endpoint: string } | { kind: "denied"; reason: string; endpoint: string }`
  - `export interface Baseline { ref: string; sha: string }`
  - `export interface UpdateDecision { status: "updated" | "up-to-date" | "denied" | "static"; oldSha: string; sha?: string; ref?: string; endpoint?: string; reason?: string }`
  - `export function parseLsRemote(stdout: string): GitRef[]` - maps `refs/tags/*` and `refs/heads/*` lines; prefers the peeled `^{}` sha for annotated tags.
  - `export function parseAtomFeed(xml: string, kind: "tags" | "commits"): { ref: string; sha?: string }[]` - commits: newest entry id's `/commit/<40-hex>`; tags: entry `<id>`/`<title>` tag name, `sha` absent.
  - `export function selectLineTag(tags: readonly GitRef[], pinned: string): GitRef | undefined` - newest tag on the pinned tag's major.minor line; excludes pre-releases.
  - `export async function resolveTip(spec: GithubSpec, opts: { policy: Exclude<UpdatePolicy, "off">; pinned?: string; branch?: string; spawnImpl?: SpawnLike; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<TipResult>` - `pinned` is the tag anchor for `"line"` (feeds `selectLineTag`); `branch` is the tracked branch for `"branch"`.
  - `export async function nextUpdate(spec: GithubSpec, entry: { update: UpdatePolicy; branch?: string }, baseline: Baseline, opts?: { spawnImpl?: SpawnLike; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<UpdateDecision>`
  - `export function updateEnabled(option: string | undefined, env?: NodeJS.ProcessEnv): boolean` - `false` only for `"off"` (option explicit-wins over env, mirroring `freshnessEnabled`); tested in Task 4.

- [ ] **Step 1: Write the failing tests** - `test/update.test.js`:
  - `parseLsRemote`: fixture stdout with an annotated tag (`abc...\trefs/tags/v0.50.1` + `def...\trefs/tags/v0.50.1^{}`) and a lightweight tag and a branch -> the annotated tag resolves to the peeled `^{}` sha, the branch ref surfaces under `refs/heads/main`, and empty stdout -> `[]`.
  - `selectLineTag`: pinned `"v0.50.0"` over tags `[v0.9.0, v0.10.0, v0.50.1, v0.50.9, 0.50.10, v0.51.0, v0.50.2-rc1]` -> `v0.50.9` chosen via `0.50.10` (no `v` prefix, numeric minor compare - `v0.9` ranks below `v0.10`, `0.50.10` above `v0.50.9`); the pre-release `v0.50.2-rc1` is excluded; a pinned with no same-line tag -> `undefined`.
  - `resolveTip` (fake `git` shim on a temp PATH - `.cmd` on win32, executable on POSIX, writing the fixture stdout): branch policy -> `{ kind: "ok", ref: "main", sha: "<40-hex>" }`; line policy with a tag-bearing repo -> the newest same-line tag sha.
  - `resolveTip` ls-remote failure -> atom fallback: `spawnImpl` returns `{ status: 1 }`, `fetchImpl` serves a `commits/<branch>.atom` fixture -> branch tip sha from the feed (Review Focus); a `tags.atom` fixture for a `line` policy -> `{ kind: "denied" }` (the feed carries no peeled sha).
  - `resolveTip` both-fail: failing spawn + `fetchImpl` that throws -> `{ kind: "denied", reason: /.../ }`.
  - `nextUpdate`: `{ update: "off" }` -> `static`; `{ update: "branch", branch: "main" }` baseline `{ ref: "5d57f5...", sha: "<old>" }` with a new tip -> `updated` with `oldSha` = baseline sha and a new `sha` (Review Focus 5); `{ update: "line" }` on a 40-hex baseline ref -> `static` (Review Focus 5); unchanged tip -> `up-to-date`; denied resolveTip -> `denied`.

- [ ] **Step 2: Run tests - expected FAIL** (`Cannot find module .../dist/update.js`).
- [ ] **Step 3: Implement `src/update.ts`** per the interfaces. `resolveTip` builds `https://github.com/<owner>/<repo>`, spawns `git ls-remote <url> refs/tags/* refs/heads/<branch>` via the injectable `spawnImpl` (default wraps `spawnSync` with `encoding: "utf8"`, `windowsHide: true`, an output byte cap, and a timeout), parses, and selects per policy (line: `selectLineTag` on the `pinned` anchor; branch: the `branch` ref); any failure falls back to the atom feed (branch: `/commits/<branch>.atom` sha; line: `/tags.atom` name -> denied, no peeled sha); both failing -> denied. `nextUpdate` maps `off` -> `static`; for `line`, a 40-hex `baseline.ref` -> `static`; otherwise runs `resolveTip` and compares the tip sha to `baseline.sha` (equal -> `up-to-date`, differs -> `updated`, deny -> `denied`). The effective branch is `entry.branch ?? (baseline.ref is a branch name ? baseline.ref : "main")`.
- [ ] **Step 4: Run `npm run check` - PASS.**
- [ ] **Step 5: Commit** - `git add src/update.ts test/update.test.js && git commit -m "feat(update): ls-remote tip resolution with atom fallback and denial classification"`.
- [ ] **Step 6: Live probe (evidence, not a unit test)** - from the repo root, run `git ls-remote https://github.com/<o>/<r> refs/tags/* refs/heads/main` for `rtk-ai/rtk`, `obra/superpowers`, `d3vv3/opencode-ascii`, `nathwn12/oc-flight-deck`; record each exit status and the peeled tip sha to `%TEMP%\opencode\bifrost-evidence\short-names-150\ls-remote-probe.md` (a reachability table). A repo that fails is noted, not faked - the dogfood task (Task 6) re-verifies live.

### Task 3: Wire the update check into the fetch path + alias glue in `index.ts`

**Files:**
- Modify: `src/github.ts` (options/result/meta types + the update check in the fetch path), `src/index.ts` (alias resolution + update-request construction + update report rows)
- Test: `test/github.test.js`, `test/resolve.test.js`

**Interfaces:**
- Consumes: `UpdatePolicy`/`RegistryEntry` (Task 1), `resolveEntrySpec`/`loadRegistry` (Task 1), `nextUpdate`/`UpdateDecision` (Task 2), `provisionTree` (Phase 1, `src/provision.ts` - lands before this task).
- Produces (additions to `src/github.ts`):
  - `export interface UpdateRequest { policy: UpdatePolicy; branch?: string }`
  - `export interface UpdateOutcome { status: "updated" | "up-to-date" | "denied" | "static"; oldSha?: string; newSha?: string; ref?: string; endpoint?: string; reason?: string }`
  - `GithubResolveOptions` gains `update?: UpdateRequest`.
  - `GithubResolveResult` gains `update?: UpdateOutcome`.
  - `GithubMeta` gains `updatedFrom?: { prevCommit: string; prevRef: string; updatedAt: string }`.
  - In `src/index.ts`: `loadRegistry` once per setup; per entry, `resolveEntrySpec` -> `{ spec, update, branch }`; when `update !== "off"` AND `updateEnabled(...)`, pass `{ policy: update, branch }` as `resolveGithubPlugin`'s `update`, and after the result emit rows: `updated <alias> -> <newSha> (was <oldSha>)` and `up-to-date <alias> @ <sha>` appended to the mount note; `denied` -> `reporter.warn("update denied for <alias>: <endpoint> <status/error>")` (the `<status/error>` text is `outcome.reason`) + `strict: true` throws. `static` adds no extra row.

- [ ] **Step 1: Write/extend the failing tests** in `test/github.test.js` (existing `fakeFetch`, `noNetwork()`):
  - float branch entry with a warm cache + a moved tip: inject a spawn/fetch seam reporting a new sha; `resolveGithubPlugin(spec, { ..., update: { policy: "branch", branch: "main" } })` performs exactly one new codeload fetch BY the new sha, returns `update: { status: "updated", oldSha, newSha }`, and `meta.updatedFrom.prevCommit === oldSha` (Review Focus 7).
  - unchanged tip: `resolveGithubPlugin` with the tip equal to the cached sha makes **zero** codeload fetches, returns `fetched: false` + `update: { status: "up-to-date" }`.
  - denied + stale-cache honesty: `noNetwork()` fetch + failing spawn -> returns the verified cache with `fetched: false` + `update: { status: "denied", endpoint, reason }` (Review Focus 6); with a cold cache the same failure throws (fail-closed).
  - `update: "off"` (or no `update`): zero tip-check calls (assert the spawn seam is never invoked) and the existing pinned-fetch behavior is byte-for-byte unchanged (existing test shape).
  - `test/resolve.test.js`: `resolveSpec("rtk", DIR)` still throws the bare-name refusal (unchanged - alias resolution is upstream of `resolveSpec` in the setup loop, not inside it); add an assertion that `resolveEntrySpec`-based substitution (imported from `dist/registry.js`) yields the full `github:` spec.
  - Provisioning order (Phase 1 seam): a float update whose new tree declares a dependency invokes the provisioner before import (assert the provision report row precedes the mount row in the returned warnings/notes).

- [ ] **Step 2: Run - expected FAIL.**
- [ ] **Step 3: Implement** - in `resolveGithubPlugin`, when `opts.update` is present with a float policy: if the cache is warm, run `nextUpdate` against the cached `meta.resolvedCommit`/`meta.ref`; on `updated`, fetch at the new sha (thread a pre-resolved commit through `fetchAndRecord`, recording `meta.ref` as the new tag/branch and `updatedFrom`); on `up-to-date`, serve the cache; on `denied`, serve the cache with the outcome. Cold cache + float: fetch at the pinned ref as today (consent unchanged), then run the tip check against that fresh baseline (a changed tip performs a second fetch). `static`/absent `update`: no tip check. Thread `update` through `GithubResolveOptions`; index.ts wires the registry + rows per the Produces block.
- [ ] **Step 4: Run `npm run check` - green (all prior suites + new).**
- [ ] **Step 5: Commit** - `git add src/github.ts src/index.ts test/github.test.js test/resolve.test.js && git commit -m "feat(github): float entries auto-update from upstream or deny loudly"`.

### Task 4: Options/env plumbing + docs

**Files:**
- Modify: `src/types.ts` (`BifrostOptions` gains `registry?: string`, `update?: "auto" | "off"`), `src/index.ts` (env: `OC_BIFROST_REGISTRY`, `OC_BIFROST_UPDATE`), `README.md` (options table + a "use short names + auto-update" example), `skills/oc-bifrost/SKILL.md` (registry/update keys), `test/update.test.js` (`updateEnabled`), `test/registry.test.js` (option/env precedence)

**Interfaces:**
- Consumes: `registryPath` (Task 1), `updateEnabled` (Task 2), `resolveEntrySpec`/`loadRegistry` (Task 1).
- Produces: `BifrostOptions.registry?: string` (wins over env), `BifrostOptions.update?: "auto" | "off"` (default `"auto"`; `"off"` = global static); env `OC_BIFROST_REGISTRY` (path), `OC_BIFROST_UPDATE=off` (kill-switch). Invalid registry-entry `update` values already refuse in `validateRegistry` (Task 1); invalid `options.update` values refuse loudly here.

- [ ] **Step 1: Failing tests** - `updateEnabled(undefined, {})` -> `true`; `updateEnabled("off", { OC_BIFROST_UPDATE: "" })` -> `false`; `updateEnabled("auto", { OC_BIFROST_UPDATE: "off" })` -> `true` (option wins); `updateEnabled(undefined, { OC_BIFROST_UPDATE: "off" })` -> `false`. Option/env precedence: `options.registry` beats `OC_BIFROST_REGISTRY` beats the default path (assert `registryPath` + the index-side selection helper). Invalid `options.update: "nope"` -> loud refusal.
- [ ] **Step 2: Run - FAIL.**
- [ ] **Step 3: Implement** - thread the options/env through `setup()`; add the README options-table rows (`registry`, `update`) and a short "short names + auto-update" example (`"plugins": ["rtk", "superpowers", "ascii", "flight-deck"]` with `"trustRemote": true`); add the registry/update keys to `SKILL.md`'s procedure (short names resolve through `registry.json`, `OC_BIFROST_UPDATE=off` for offline/CI).
- [ ] **Step 4: `npm run check` green; commit** - `git add src/types.ts src/index.ts README.md skills/oc-bifrost/SKILL.md test/update.test.js test/registry.test.js && git commit -m "feat(options): registry/update options, env kill-switch, and short-name docs"`.

### Task 5: Release ceremony 1.5.0

**Files:** `package.json`, `package-lock.json` (both root entries), `README.md` (version pins), `INSTALL.md` (version pins), `skills/oc-bifrost/SKILL.md` (version pins), `CHANGELOG.md`.

- [ ] **Step 1:** `npm run check` - green (assert).
- [ ] **Step 2:** Bump `1.3.3` -> `1.5.0` in every pin (the Phase 1 worktree owns `1.4.0`; this plan lands `1.5.0` on top); CHANGELOG `## 1.5.0 (2026-09-30)` entry: short-name alias registry (seeded, user-editable, loud refusals), `git ls-remote` tip resolution + atom fallback, `off`/`line`/`branch` update policies, `updated`/`up-to-date`/`denied` rows, `OC_BIFROST_UPDATE=off` kill-switch, the new tests' names.
- [ ] **Step 3:** Commit (`chore(release): bump to 1.5.0`), `npm pack` -> `%TEMP%\opencode\bifrost-pack\nathwn12-oc-bifrost-1.5.0.tgz`, verify version inside.
- [ ] **Step 4:** Reflight (packed artifact, sandbox): config with the four SHORT names -> registry resolution, update rows, mounts - evidence to `%TEMP%\opencode\bifrost-evidence\short-names-150\` (report.log + per-plugin rows). A denied float (offline sandbox) must show the denial row and still mount the last verified snapshot with `fetched: false`.
- [ ] **Step 5:** Add/refresh a VERIFIED-PLUGINS.md row for the short-name + auto-update verdict; commit.

### Task 6: Live dogfood + publication

- [ ] **Step 1:** Publish 1.5.0 (owner manual or mandate), pin the live config to `@1.5.0`, set `options.plugins` to the four short names (`rtk`, `superpowers`, `ascii`, `flight-deck`) with `trustRemote: true`; fresh client.
- [ ] **Step 2:** Assert from `report.log` + client log: registry resolution, one update row per entry (`updated` / `up-to-date` / `denied`), mounts with zero TUI failures; record evidence to `%TEMP%\opencode\bifrost-evidence\short-names-150\live\`.
- [ ] **Step 3:** Rotate the shared registry seed (the live `registry.json` is the seed's exact content; any user edits stay). Budget: 2-5 live loops. **Defeat line:** an honest refusal + revert to the long-form config (never fake a mount) - the orchestrator verifies and gates; the owner publishes manually.
- [ ] **Step 4:** Report landed commit shas + recovery paths per the publication mandate.

## Required sub-skill

Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
