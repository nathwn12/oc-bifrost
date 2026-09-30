# Accommodating bridge design - oc-bifrost 1.4.x

- **Date:** 2026-09-30
- **Type:** design document only - no implementation ships with this PR
- **Motto:** "v1-v2 agnostic, wires it anyway - works, as if magic"
- **Targets:** three 1.4.x minor releases, one phase each, in the locked order below

## Locked assumptions (owner-approved; do not re-litigate)

1. **Phase order:** 1. dependency provisioning -> 2. source forms -> 3. shape acceptance. Each phase lands in its own 1.4.x release **with tests + a VERIFIED-PLUGINS.md flight row**.
2. **Honesty contract survives:** loudly refused hooks stay refused (config, auth, provider, command.execute.before, experimental.\*, facade children + showToast); refusals must name mechanisms; nothing is ever silently dropped or faked.
3. `trustRemote` stays **the single consent gate**.
4. **sha256-on-first-use provenance stays authoritative** (tarball + entry digest; verified on every later load).
5. **Hostile archives stay refused with no fallback** (traversal/symlink/ADS attempts are never materialized).

## 1. Purpose & success criteria

**Purpose:** accept and mount any V1 or V2 plugin from any practical source - local path, `github:`, npm package, git URL, tarball URL, or raw file URL - with the fetched tree's declared dependencies provisioned, so the only remaining refusals are (a) hooks with no faithful V2 destination and (b) forms the honesty contract refuses by design.

**Success criteria**

- **Verdict vocabulary** (from VERIFIED-PLUGINS.md): `full` (live write-back proof), `partial` (bridged with a stated loss), `refused` (refused out loud, mechanism named), `provisioned` (refused as fetched -> dependencies provided -> mounted with evidence).
- Per phase: all tests green via the injected-`fetchImpl` seam, a flight on the **packed artifact**, and at least one new VERIFIED-PLUGINS.md row in the current vocabulary.
- Overall: the "Cannot find package" class of failure disappears from flights; every unresolved input resolves to a loud, mechanism-naming refusal.

## 2. Current-state inventory

| Concern | Location |
|---|---|
| Specifier resolution - accepted today: `preset:`, `github:`, `~/`, `./`, `../`, absolute, `file://`; everything else refused | `src/index.ts:100-125` (`resolveSpec`) |
| The refusal text that Phase 2 rewrites | `src/index.ts:69-74` (`unsupportedSpecifierMessage`; "npm and bare package names are not yet supported") |
| Per-entry `{ spec, options }` normalisation - the extension point Phase 3 uses | `src/index.ts:42-47` (`normalizeEntries`) |
| `github:` pipeline - parse (287-316), cache id (359-364), cache boundary `validateCachePath` (416-450), consent message (478-490), default-branch via REST API (713-743), ref->commit via REST (746-783), **40-hex refs skip resolution entirely (752-757, shipped 1.3.2 - 0 API calls)**, snapshot tarball (927-993), single-file fallback (1030-1083), provenance `meta.json` (87-119), hash-verified cache load (678-710), atomic write + rollback (1163-1212) | `src/github.ts` |
| Snapshot caps re-verified per source by Phase 2 | `src/github.ts:217-219` (16 MiB tarball / 64 MiB tree / 5000 files), `MAX_RESPONSE_BYTES` 209 |
| Injectable test seams: `fetchImpl` (146, used at 1096), clock (149), limits (151); origin pinning (543-560); sanitized messages `safe()` (239-244) | `src/github.ts` |
| Discovery - V2 default checked first (39-41), then V1 module `server` (44-47), V1 default factory (49-51), named exports by name preference (60-64) **and by shape (66-70)**. The discovery gap (SystemPromptLogger/DirenvLoader) was **already closed in 1.3.1** by the shape-based pass - not re-designed here | `src/discover.ts` |
| Mount dispatch - `v2.setup` mounted with the host context (261-264); **effect-only V2 refused** (266-270); V1 via `buildV1Context` + `registerV1Hooks` (273-278) | `src/index.ts` |
| V1 hook bridge - 17 bridged/approximated rows + 7 refused (355-363) | `src/hooks.ts` |
| The contract - 24 rows; unsupported rows name the V2 boundary they cannot cross | `src/compat-matrix.ts` (config 128-132, auth 134-138, provider 140-144, command.execute.before 146-150, experimental.\* 152-168, client.session.children 92-96, client.tui.showToast 98-102) |
| Facade - `client.session.messages` bridged (66-78); `tui.*` and `session.children` refused loudly at load (41-54) | `src/context.ts` |
| Zero runtime deps - `"dependencies": {}` (`package.json:54`), peer `@opencode/plugin >=2.0.0` (51-53); CONTRIBUTING.md:30 ("no new runtime dependencies without a reason"); `src/github.ts:70` | `package.json`, CONTRIBUTING.md |
| Test seams - `test/github.test.js` drives everything offline with an injected `fetchImpl` + `noNetwork` sentinel; `test/resolve.test.js` pins `resolveSpec` forms; `test/discover.test.js` pins shape discovery | `test/` |
| **Flight-proven provisioning seed** - junctioning a package into the materialized tree made each mount work: personality (`@opencode-ai/plugin`), snippets (five declared deps), opencode-review | VERIFIED-PLUGINS.md rows 16, 22, 44; refusal-mechanism rows 19-20 (envsitter-guard, ignore) |

## 3. Phase 1 - dependency provisioning (target 1.4.0)

**Goal:** kill the "Cannot find package" refusal class. Flight roster it must clear: personality (`@opencode-ai/plugin`), envsitter-guard, ignore, snippets (`@opencode/plugin` + effect + gray-matter + handlebars + jsonc-parser), review (`@opencode-ai/plugin`), plus the flight-deck demo wall.

**Trigger:** after a fetched tree materializes and **before** the entry import, read `<tree>/package.json`. If it declares `dependencies` (or `peerDependencies` the host can satisfy), provision `node_modules` inside the cache tree. Only fetched trees are provisioned; local-path and preset entries are untouched.

**Mechanics - host-store-first:**

1. **Junction from the host's own plugin store** - for each declared dep, locate the package in the host's shared store (the store the host's plugin installs land in), then directory-junction (`fs.symlink`; junction on Windows, symlink elsewhere) it into `<tree>/node_modules/<name>`. Zero network. Re-resolve junctions at every load via a cheap realpath check (a store that moves leaves them stale). This is exactly the flight-proven pattern from VERIFIED-PLUGINS.md rows 16/22/44.
2. **Fallback for packages the host lacks:** `npm install --no-save --prefix <tree>` inside the verified tree. The npm client is **spawned**, never imported - CONTRIBUTING.md:30 holds; oc-bifrost's own package keeps zero runtime deps.
3. **Both fail -> loud refusal** naming the missing package and the mechanism that failed.

**Where it runs:** new `src/provision.ts`, called from `src/index.ts` after the snapshot resolve (today `resolveGithubPlugin` at 222-225; Phase 2's `fetchSource`) and before `import(specifier)` (244).

**Failure semantics:** a documented refusal class with the same loudness as consent refusals - sanitized via `safe()` (`src/github.ts:239-244`), `strict` throws / warn+skip otherwise (mirror `src/index.ts:226-230`). Provisioning never silently degrades a mount.

**Cache / re-verification interaction - provenance stays authoritative:** `meta.json`'s tarball sha256 + entry sha256 pin the **fetched tree**; `node_modules` is a **derived layer** - never digested, never trusted for identity, and never able to change the bytes the entry digest pins. After a successful provision, write a marker (`<tree>/node_modules/.bifrost-provision.json`: dep list + resolved versions + junction targets) so warm loads re-verify cheaply and re-provision only on declared-dep drift. Deleting the cache directory (the documented refresh) discards provisioning with it.

**Consent wording:** `trustRemote` already consents to "downloads ... and EXECUTE its entry file with this host process's full user rights" (`src/github.ts:478-490`). `consentMessage` is amended to name provisioning explicitly: the first fetch **resolves and provisions the entry's declared dependencies** (from the local host store, or downloaded by npm on the fly), all executed with the host's rights. Same gate, stated more completely - no second consent, no silent widening.

**Trust & security:** junction targets validated as real host-store directories, never followed through symlinks (reuse the `validateCachePath` discipline, `src/github.ts:416-450`); npm fallback only ever runs `--no-save --prefix` inside the verified tree; npm output is capped/sanitized like every remote response.

**Verification plan:** unit tests in `test/provision.test.js` - synthetic `github:` tree with `package.json` deps, fake host store, fake `npm` executable on PATH; branches: host-store junction, npm fallback, both-fail loud refusal, stale-junction re-resolution, marker round-trip, cache-delete -> clean reprovision. Flight: packed 1.4.0 artifact on the isolated host; the full Phase-1 roster mounts with **no manual junctioning**; each row upgrades to `provisioned` in VERIFIED-PLUGINS.md.

## 4. Phase 2 - source forms (target 1.4.1)

**Goal:** widen `resolveSpec` (`src/index.ts:100-125`) from `github:` to every practical source, all routed through **one source-agnostic core**.

**Accepted forms** (refusal text `src/index.ts:69-74` rewritten):

- `npm:<pkg>[@<version>]` and bare package names (documented alias of `npm:`) - **safe only BECAUSE Phase 1 lands first or together; the phase order is load-bearing.**
- `git+https://...` / `git+ssh://...` - snapshot at pinned/tagged ref. ssh uses the user's SSH agent; the consent message says that.
- Tarball URLs (`https://.../*.tgz`) - same semantics as the codeload snapshot.
- Raw file URLs (`https://.../plugin.ts`) - single-file semantics, same caps.
- All existing forms unchanged.

**One core:** refactor the `github:` pipeline (parse -> cache id -> boundary -> consent -> resolve -> fetch -> caps -> verify) into `fetchSource(spec, opts)` in a new `src/fetch.ts`, with per-source adapters (github, npm, git, tarball, raw-file) implementing one contract. `github:` keeps its exact behavior - it is the flight-proven reference. Caps are **re-verified per source** (16 MiB / 64 MiB / 5000 files, `src/github.ts:217-219`), never assumed. Origin pinning (`assertSameOrigin`, 543-560) generalizes to a per-adapter allowed-origin/URL-scheme set. Cache layout: per-source namespaces under the same root (`.../oc-bifrost/<source>/v2/<id>/`) so no cache can be misread across sources.

**API-bypass (the HTTP 403 pain):**

- Fully-pinned 40-hex refs already skip resolution (1.3.2, `src/github.ts:752-757`) - 0 API calls; keep, extend to all git sources.
- Tags/branches: when the REST API is refused, resolve via **`git ls-remote --tags/--heads <repo>` over HTTPS** - no `api.github.com`. This is git-protocol, available to every git source, so `github:` gains a fallback that also serves `git+https/ssh:`.

**npm registry trust class:** identical to `github:` snapshots. Registry metadata is the resolution step (like `resolveCommit`); the resolved version's tarball is fetched from the pinned URL; **tarball + entry sha256 both recorded in meta.json**; later loads hash-verify the tree (with its Phase-1 `node_modules`) before use. Metadata responses cap at `MAX_RESPONSE_BYTES` (209).

**Error/refusal semantics:** unchanged shape - loud, mechanism-naming, sanitized; cold + unconsented refuses exactly like today; `strict` throws. **No cross-source fallback ever**: the single-file fallback stays inside a source (`github:` tarball -> `github:` raw), never `github:` -> npm.

**Consent:** `trustRemote` wording generalizes from "GitHub" to the named source; `OC_BIFROST_TRUST` accepts per-source values (`github`, `npm`, `git`, `tarball`, `file`, `all`).

**Verification plan:** unit - forms parse, per-form refusal text, caps re-checked per source, ls-remote fallback fires on REST 403 and is skipped for 40-hex, npm metadata + tarball + entry digest round-trip, cache namespaces never cross (extend `test/resolve.test.js` + `test/github.test.js`; new `test/fetch.test.js`, `test/git-ls-remote.test.js`). Flight: packed 1.4.1 artifact - a plugin that previously required an npm-installed absolute path, mounted via both `npm:` and its bare name; one `git+https:` mount; one tarball-URL mount; new VERIFIED-PLUGINS.md rows in the `provisioned` vocabulary.

## 5. Phase 3 - shape acceptance (target 1.4.2)

**Effect-only V2 definitions** (refused today at `src/index.ts:266-270`): investigate a **faithful host-context mount** - does the host context expose the Effect runtime a `definition.effect(ctx)` needs (V2 checkout is the authority)? If a faithful mount exists (runtime resolvable, semantics equivalent to `setup`), implement it; **if none exists, the loud refusal STAYS (honesty contract) and this spec records that decision**. Either outcome lands with a test and a flight row.

**Dual-export files** (V1 named + V2 default; V2 currently wins because `discover` checks `module.default` first - `src/discover.ts:39-41`): add an optional per-entry flag - `{ spec, options, routes }` with `routes: "v2" | "v1" | "both"` (default `"v2"`, today's behavior) - to mount BOTH routes under distinct ids. `{ spec, options }` already exists (`src/index.ts:42-47`); **extend, do not replace**. Side-effect risk sits with the user: both routes run in the same host (two setups, two registrations); the flag is off by default and the mount note names both mounted routes.

**Verification plan:** unit tests for both-routes mounting (two ids, both registrations, both cleanups) and for whichever effect-only verdict lands; flight on the packed 1.4.2 artifact; VERIFIED-PLUGINS.md rows in the current vocabulary.

## 6. Out of scope (stays refused; not re-designed)

- **The seven refused hooks** - config, auth, provider, command.execute.before, experimental.provider.small_model, experimental.compaction.autocontinue, experimental.text.complete (`src/hooks.ts:355-363`; matrix rows `src/compat-matrix.ts:128-168`).
- **Facade refusals** - `client.tui.showToast`, `client.session.children` (`src/context.ts:41-54`; matrix rows 92-102).
- **TUI/CLI-plugin mounting via the server bridge** - documented boundary: `packages/core/src/plugin/module.ts` loads server entrypoints; the TUI plugin context is a separate process surface; **a server bridge cannot mount a TUI entry / render `ui.slot` sidebars**. Anything needing a TUI-process surface stays out. The proven wiring below circumscribes this boundary; it does not cross it.
- **The discovery shape pass** - closed in 1.3.1 (`src/discover.ts:66-70`); no redesign.

### TUI-side wiring mechanics (proven 2026-09-30)

> Amendment record: recorded from the flight-deck sidebar challenge (wire `oc-flight-deck`'s sidebar from a `github:`-fetched snapshot); proven live 2026-09-30, with the VERIFIED-PLUGINS.md row, at commit `3aa7c3d`. The 1.4.x TUI-wiring phase is designed from these facts, not from static analysis.

- **Bun's specifier-rewrite remap is NOT reliable for external directory entries.** Static analysis suggested `@opencode/plugin/tui`, `@opentui/core`, `@opentui/solid`, `solid-js` all remap to host modules for non-node_modules files. In practice the 2.0.20 TUI (Bun binary) loaded a `file:` directory entry into `src/tui` but failed with `Cannot find package '@opentui/core'` regardless of a tree-local node_modules junction - the loader's native resolution path did not honor the tree's node_modules for the TUI-side load. Physical provisioning is required.
- **The proven wiring (live, mounted, zero plugin-operation failures): the npm-cache package layout is the reliable resolution mechanism.** The `oc-flight-deck@0.8.1` npm cache package dir was replaced by a junction to the materialized snapshot tree (which carries package.json + src/ + a provisioned node_modules junction to the npm peer generation: `@opencode/plugin` 2.0.19, `@opentui/core` 0.5.12, `@opentui/solid` 0.5.12, `solid-js` 1.9.15 + transitives). The TUI inventory (`features.tui`) + npm resolver then load the `./tui` entrypoint from the tree with all peers physically resolvable; the server-side mount also flipped from refused to `mounted v2:flight-deck.host` (the tree's node_modules provisioned `@opencode/plugin` for the stub too).
- **Companion mechanism for the Phase 1/2 work, not a server-bridge escape:** the npm-layout junction makes a `github:`-fetched snapshot look like a cached npm package the TUI resolver already knows how to load - the TUI-side counterpart of Phase 1's junction provisioning (§3) and of Phase 2's `npm:`/bare-name sources (§4). VERIFIED-PLUGINS.md documents the row: as-fetched refused (`Cannot find package '@opencode/plugin'`), provisioned server pass-through mounted, TUI panel from the same snapshot tree via the npm-layout junction.
- **Boundary (unchanged):** the server bridge still cannot mount a TUI entry; the panel renders through the TUI's **own** npm resolver pointed at the same verified snapshot tree. The core boundary (`packages/core/src/plugin/module.ts:98` vs `packages/tui/src/plugin/context.tsx:670`) stands.

## 7. Risks & open questions

- **npm supply-chain consent:** the npm fallback installs arbitrary transitive deps into the cache tree. Mitigation: it runs under the same `trustRemote` gate with wording that names it; registry metadata pins resolved versions. Open: should provisioning **refuse unpinned ranges by default** (full-pinning as the safe default)?
- **Effect runtime availability:** the effect-only verdict lives or dies on whether the host context exposes the Effect runtime; resolved in Phase 3 against the checkout.
- **Cache-tree integrity with junctions:** `node_modules` junctions make the verified tree no longer purely bridge-owned bytes. Control: per-load realpath re-validation + the provisioning marker. Open: should `meta.layout` gain a field stating `node_modules` is junctioned (derived layer), so the provenance record stays honest about the tree's composition?
- **ls-remote rate limits:** unauthenticated `git ls-remote` against GitHub is IP-rate-limited; a host behind a shared NAT could hit refusals where REST would not. Mitigation: 40-hex refs never resolve (0 calls); resolution results are cached as `resolvedCommit` in meta (as today), so any ref resolves at most once per cache entry.