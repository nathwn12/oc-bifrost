# Provisioning + TUI Wiring Implementation Plan (1.4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make oc-bifrost auto-provision a fetched `github:` snapshot's dependencies and, opt-in, wire the plugin's TUI entry into the client - turning today's manual junction+config surgery into one config option.

**Architecture:** After a snapshot materializes, a new provisioner resolves the tree's declared deps (host-store junction first - the proven live mechanism - then `npm install --no-save` fallback). An opt-in TUI-wiring layer then writes an idempotent wrapper + a jsonc-preserving `cli.json` entry. All actions are report rows, consent-gated, and reversible.

**Tech Stack:** Node/Bun, zero new runtime deps, Node test runner (`test/*.test.js` against `dist/`), `fetchImpl` seam (existing), Windows junction semantics (`fs.symlinkSync(dir, "junction")`).

**Spec:** `docs/superpowers/specs/2026-09-30-accommodating-bridge-design.md` (Phase 1 + the proven "TUI-side wiring mechanics (2026-09-30)" subsection). Source forms (Phase 2) and shape acceptance (Phase 3) are separate future plans - NOT in scope here.

## Global Constraints

- Zero runtime dependencies (`package.json` has `"dependencies": {}`; CONTRIBUTING.md:30) - provisioning shells out to npm, never imports it.
- `npm run check` (typecheck + build + test) must be green after every task; repo rule: one logical change per PR.
- Refusal classes stay loud (report.ts pattern): nothing silently dropped; `strict: true` turns any failure into a setup abort.
- Provenance invariants unchanged: sha256 pins the tarball + entry file only (verified practice - junctions in the tree are invisible to warm-cache verification); caps (16 MiB / 64 MiB / 5000 files) unchanged.
- `trustRemote` (or `OC_BIFROST_TRUST=github`) is the single consent gate; provisioning and TUI wiring are covered by the same consent - the report must say so.
- The server bridge still cannot mount a TUI entry (`packages/core/src/plugin/module.ts:98` vs `packages/tui/src/plugin/context.tsx:670`) - the TUI-wiring layer only writes the client-side entry; it never renders.

## Review Focus

1. **Provisioned tree + warm-cache reload** - junctions/node_modules added to the tree must not trip the entry sha256 verification or the "tree present without provenance" guard. Test in Task 2: warm reload of a provisioned tree loads zero-network with `fetched === false`.
2. **Offline npm fallback** - `npm install` failing (offline/registry 403) must produce a loud `provision` refusal row naming the package, never a silent unprovisioned mount. Test in Task 1 with a failing fake npm.
3. **cli.json concurrent writer** - the user's client rewrites verbosity/settings (observed live 2026-09-30 17:22:59); the wiring write must never clobber unrelated keys, and an mtime movement between read and write forces a re-read. Test in Task 3 with a fake concurrent rewrite.
4. **Entry without package.json** - single-file fallback trees have no manifest; provisioning must skip loudly (report row `provision skipped: no manifest`) and mount proceeds as today. Test in Task 2.
5. **Windows junction/reparse safety** - host-store junctions must be created as junctions (never copies of huge stores), and housekeeper/sweep tooling must not follow them; the provisioner never follows an existing reparse point when resolving a source. Test in Task 1 asserting `lstat` reports junction/symlink type.

---

### Task 1: Provisioner engine

**Files:**
- Create: `src/provision.ts`
- Test: `test/provision.test.js`

**Interfaces:**
- Consumes: nothing (pure module; the existing `sha256Hex`/path helpers may be imported from `src/github.ts`).
- Produces:
  - `export interface ProvisionAction { package: string; source: "host" | "npm" | "skip"; target: string; bytes?: number }`
  - `export interface ProvisionReport { actions: ProvisionAction[]; refused: string[] }`
  - `export async function provisionTree(treeDir: string, opts: { hostStores?: readonly string[]; npm?: boolean; dryRun?: boolean }): Promise<ProvisionReport>`
  - `export function missingDeps(treeDir: string): string[]` - bare specifiers the entry graph imports that the tree cannot resolve (reads the entry's `package.json` `dependencies` + the entry file's static `import "..."` bare specifiers, top-level only).

- [ ] **Step 1: Write the failing tests** - `test/provision.test.js` (Node test runner, temp dirs like `test/github.test.js`'s `tmpRoot`):
  - host-store junction: tree with `package.json` `dependencies: {"@acme/peer": "1.0.0"}`, host store `store/node_modules/@acme/peer`, `provisionTree(tree, {hostStores: [store]})` -> one action `{package:"@acme/peer", source:"host"}`, `tree/node_modules/@acme/peer/package.json` exists via the junction (assert `lstat` linkType junction) - and with `dryRun: true` nothing is created.
  - npm fallback: `{npm: true}` with no host store hit -> fake `npm` (`.cmd` shim on PATH writing a marker) is invoked with `install --no-save --prefix <tree>`; action `source:"npm"`.
  - npm failure: fake npm exits 1 -> `refused` contains the package and no throw (report semantics; `strict` is Task 2's concern).
  - `missingDeps`: entry imports `@acme/missing` (not in tree, not in stores) -> listed.
- [ ] **Step 2: Run tests - expected FAIL** (`Cannot find module .../src/provision.js`).
- [ ] **Step 3: Implement `src/provision.ts`** - read-manifest; resolve each dep against every `hostStores` root (`<store>/<name>` for scoped/unscoped, `lstat` skip if an existing reparse point), junction-or-copy on first hit; else npm fallback via `spawnSync` of `npm` (no shell trust issues; cwd = a temp dir, `--prefix` the tree); dryRun records without writing; all failures gathered into `refused`, never thrown.
- [ ] **Step 4: Run tests - PASS.**
- [ ] **Step 5: Commit** - `git add src/provision.ts test/provision.test.js && git commit -m "feat(provision): provision snapshot deps from host stores or npm"`.

### Task 2: Wire provisioning into the github: fetch path

**Files:**
- Modify: `src/github.ts` (fetchAndRecord/materialize tail), `src/index.ts` (options pass-through)
- Modify: `test/github.test.js`, `test/resolve.test.js`

**Interfaces:**
- Consumes: `provisionTree` (Task 1); `BifrostOptions.provision: "host" | "npm" | "off"` (new, default `"host"`; env `OC_BIFROST_PROVISION`).
- Produces: mount report rows - after the snapshot materializes, before entry import, when `provision !== "off"`: `provision <pkg> - host:<path>` / `npm install --no-save` / `provision refused <pkg> - <reason>`; a refused row under `strict: true` aborts setup (existing `createReporter` pattern). No manifest -> row `provision skipped: no package.json` (report row, still mounts).

- [ ] **Step 1: Write/extend the failing tests** in `test/github.test.js` (existing `fakeFetch`):
  - cold fetch of a spec whose tree's dependency resolves from a fake host store -> entry now imports successfully (mirror of the 2026-09-30 run-B sandbox outcome, automated); report contains the provision row.
  - `provision: "off"` -> no provision row, as-fetched refusal preserved (existing test shape).
  - warm reload (`noNetwork()`) of the provisioned cache: `fetched === false`, zero API/network calls, entry still imports (Review Focus 1).
  - single-file fallback (no package.json in fetch): `provision skipped: no package.json` row; mount proceeds (Review Focus 4).
  - strict: npm failure with `strict: true` -> setup aborts with the refusal text.
- [ ] **Step 2: Run - expected FAIL.**
- [ ] **Step 3: Implement** - call `provisionTree` in `fetchAndRecord` after materialization (before the entry probe/import), feeding `hostStores: [<XDG_CACHE_HOME or ~/.cache>/opencode/npm]` (the shared OpenCode npm cache root - the `npm` sibling of the bridge's own `oc-bifrost` cache dir; NOT `githubCacheRoot`'s parent, which is the `oc-bifrost` dir itself - corrected per controller ruling R-2; live layout verified `C:\Users\you\.cache\opencode\npm\<name>@<version>\<cacheId>\node_modules\<name>`), npm fallback per option; thread `provision` through `GithubResolveOptions` + `BifrostOptions` + env.
- [ ] **Step 4: Run `npm run check` - green (all prior suites + new).**
- [ ] **Step 5: Commit.**

### Task 3: Opt-in TUI wiring (wrapper + cli.json entry)

**Files:**
- Create: `src/wire-tui.ts`
- Test: `test/wire-tui.test.js`

**Interfaces:**
- Consumes: a provisioned tree path + the harness config path (`cli.json` location from `~/.config/opencode` - path provided by the caller; the module never guesses).
- Produces:
  - `export async function wireTui(treeDir: string, cliJsonPath: string): Promise<{ wrapper: string | null; entry: string }>`
  - `export async function unwireTui(cliJsonPath: string): Promise<boolean>` - removes only our entry (marker comment), byte-preserving everything else.
  - Wrapper: `tui.tsx` at tree root, `export { default } from "./src/tui/index.tsx";` - created only when the tree lacks a loadable `tui.{ts,tsx}` (idempotent).
  - cli.json merge: read -> parse -> append `plugins: [<file:// tree dir>]` merged with existing plugins (dedupe by exact string) -> write; if file mtime changed between read and write, re-read and merge again (up to 3 attempts, then refuse loudly) (Review Focus 3). Never touches other keys.

- [ ] **Step 1: Failing tests** - wrapper creation/idempotence; cli.json merge preserves unrelated keys byte-for-byte (golden file compare); dedupe; concurrent-writer simulation (touch mtime + change a setting between our read and write via a hook) -> re-read path, settings preserved; `unwireTui` removes only our entry.
- [ ] **Step 2: Run - FAIL.**
- [ ] **Step 3: Implement `src/wire-tui.ts`** per interfaces; jsonc-preserving write via regex-free read-modify-write (JSON5-lite: keep comments by splicing the plugins key only - read as text, locate key boundaries; refuse loudly on ambiguous formatting).
- [ ] **Step 4: Run - PASS; `npm run check` green.**
- [ ] **Step 5: Commit.**

### Task 4: Options plumbing + docs

**Files:**
- Modify: `src/types.ts` (`BifrostOptions`: `provision?: "host"|"npm"|"off"`, `wireTui?: boolean`), `src/index.ts` (env: `OC_BIFROST_PROVISION`, `OC_BIFROST_WIRE_TUI`), `README.md` (options table + one "wire a TUI plugin from github:" example), `skills/oc-bifrost/SKILL.md`, `test/resolve.test.js`, `test/multi-plugin.test.js` (option passthrough assertions).

- [ ] **Step 1: Failing tests** - options/env parsing: `OC_BIFROST_PROVISION=npm` -> npm fallback used; `wireTui: true` + provisioned tree -> `wireTui` invoked (fake cli.json path via option `cliJsonPath` test hook); invalid `provision` value -> loud refusal, default `host`.
- [ ] **Step 2: Run - FAIL.**
- [ ] **Step 3: Implement** plumbing + README/SKILL documentation (two short sections; the SKILL.md gains the provisioning/wiring keys).
- [ ] **Step 4: `npm run check` green; commit.**

### Task 5: Release ceremony 1.4.0

**Files:** `package.json`, `package-lock.json` (both root entries), `README.md` (3 pins), `INSTALL.md` (3 pins), `skills/oc-bifrost/SKILL.md` (2 pins), `CHANGELOG.md`.

- [ ] **Step 1:** `npm run check` - green (assert).
- [ ] **Step 2:** Bump 1.3.3 -> 1.4.0 in all pin files; CHANGELOG `## 1.4.0 (2026-09-30)` entry: provisioning (host-store junction -> npm fallback, consent-gated, loud refusals), opt-in TUI wiring, the two new tests' names.
- [ ] **Step 3:** Commit (`chore(release): bump to 1.4.0`), `npm pack` -> `%TEMP%\opencode\bifrost-pack\nathwn12-oc-bifrost-1.4.0.tgz`, verify version inside.
- [ ] **Step 4:** Reflight (packed artifact, sandbox): `github:nathwn12/oc-flight-deck@5d57f545...#src/index.ts` with `provision: "host"` as-fetched -> provision rows + `mounted v2:flight-deck.host` WITHOUT manual junction (the automation proof); evidence to `%TEMP%\opencode\bifrost-evidence\flight-deck-140\`.
- [ ] **Step 5:** Flip the oc-flight-deck row in VERIFIED-PLUGINS.md's Result cell from "junctioned manually" to "auto-provisioned (1.4.0)"; commit.

### Task 6: Live dogfood + publication

- [ ] **Step 1:** Publish 1.4.0 (owner manual or mandate), pin live config to `@1.3.3 -> @1.4.0`, set `wireTui: true` in the present, remove the hand-made npm-layout junction and cli.json file: entry (the automation now owns them).
- [ ] **Step 2:** Fresh client; assert server mount + TUI load from report.log + client log (zero plugin-operation failures); panel observed.
- [ ] **Step 3:** Report landed commit shas + recovery paths per the publication mandate.