# Short names + upstream auto-update - oc-bifrost 1.5.0

- **Date:** 2026-09-30
- **Type:** design document only - no implementation ships with this PR
- **Motto:** "short names, always fresh, or refused"
- **Targets:** one 1.5.0 release, two phases total. Phase 1 (dependency provisioning, 1.4.0) executes first in its own worktree; this spec is Phase 2 and its update flow CALLS Phase 1's `provisionTree`.

## Locked assumptions (owner-approved; do not re-litigate)

1. **Phase order:** 1. dependency provisioning (1.4.0) -> 2. short names + upstream auto-update (this spec, 1.5.0). Phase 1 lands before Phase 2 and is not touched here; Phase 2's update flow reuses Phase 1's provisioner by calling `provisionTree`.
2. **Honesty contract survives:** loudly refused hooks stay refused; refusals must name mechanisms; nothing is ever silently dropped or faked; **a stale snapshot is never presented as fresh**.
3. `trustRemote` stays **the single consent gate**; update + provisioning are covered by it and the report says so.
4. **sha256 provenance stays authoritative** (tarball + entry digest; verified on every later load AND re-verified on every float update - the trust anchor never weakens when a ref floats).
5. **Hostile archives stay refused with no fallback** (traversal/symlink/ADS attempts are never materialized).

## 1. Purpose & success criteria

**Purpose:** replace the long `github:` spec strings in the live config with short registry aliases that float to upstream - or deny loudly when updating from upstream is impossible - so the config reads `"rtk"` instead of `"github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts"`, and each entry stays current without manual pin surgery.

**Success criteria**

- The live `options.plugins` becomes the four short names (`rtk`, `superpowers`, `ascii`, `flight-deck`), each resolving through the registry and reporting exactly one update row: `updated <alias> -> <newSha> (was <oldSha>)` | `up-to-date <alias> @ <sha>` | `update denied for <alias>: <endpoint> <status/error>`.
- Every cold setup performs the cheap upstream tip check for float entries; a full 40-hex pin with `update: "off"` stays static with **zero API and zero `git ls-remote` calls**.
- **Zero `api.github.com` traffic anywhere in Phase 2.** The 1.3.2 pinning exists because that endpoint rate-limits this environment (HTTP 403s); this is the hard lesson Phase 2 is built around.
- `npm run check` green; a packed 1.5.0 artifact reflight with short names; at least one new VERIFIED-PLUGINS.md row in the current vocabulary.

## 2. Current-state inventory

| Concern | Location |
|---|---|
| Specifier resolution - accepted today `github:` / `preset:` / `~` / `./` / `../` / absolute / `file://`; bare names refused | `src/index.ts:100-125` (`resolveSpec`) |
| The refusal text Phase 2 narrows (bare non-scope names become registry aliases instead of "npm not supported") | `src/index.ts:69-74` (`unsupportedSpecifierMessage`) |
| `github:` pipeline - parse -> cache id -> boundary -> consent -> resolve -> fetch -> caps -> verify -> mount note | `src/github.ts` |
| 40-hex refs skip resolution entirely (shipped 1.3.2 - 0 API calls) | `src/github.ts` `resolveCommit` (the `COMMIT_PATTERN` short-circuit) |
| Shared user cache root - `github/` artifacts and `report.log` both live under `<XDG_CACHE_HOME or ~/.cache>/opencode/oc-bifrost/` | `src/index.ts:50-56` (`githubCacheRoot`), `src/sink.ts:82-87` (`reportPath`) |
| Semver-ish tag comparison precedent (`v`-prefix strip, numeric segments, prerelease ordering) | `src/freshness.ts:79` (`compareTags`) |
| Zero runtime deps - `"dependencies": {}`; shell-outs are spawned, never imported | `package.json:54`, `CONTRIBUTING.md:30` |
| Test seams - injected `fetchImpl`, temp dirs, tests run against `dist/` (`node --test test/*.test.js`) | `test/*.test.js`, `test/helpers/tar.js` |

## 3. The problem (verbatim requirement)

The live config uses long plugin spec strings:

```jsonc
"plugins": [
  "github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts",
  "github:obra/superpowers@v6.4.2#.opencode/plugins/superpowers.js",
  "github:d3vv3/opencode-ascii@e42bb23f690d99f29578183bb02e0be270256b03#dist/index.js",
  "github:nathwn12/oc-flight-deck@5d57f545d296ef905047efc70bb75ba45bdaf1b1#src/index.ts"
]
```

Owner demands: (a) "simplify or shorten plugin name requirement" - config entries should be short names; (b) "my plan was for it to auto-update, always from upstream (deny if impossible.)" - entries should float to upstream; when updating from upstream is impossible, deny loudly; (c) 2-5 loops budget for live verification phases, no questions, decisions made and recorded. Full auto.

## 4. Rulings (authoritative decisions)

### Ruling U-1 - alias registry

`options.plugins` entries that are NOT a resolvable spec form are treated as **REGISTRY ALIASES**. A spec is a *resolvable form* (and therefore NOT an alias) when it starts with `github:`, `npm:`, `file:`, or `preset:`, starts with `~`, `./`, or `../`, is an absolute path, or is an `@scope/name` npm name. Everything else - the four short names, any bare non-scope name - is an alias lookup.

**Registry default path (decided):** `<XDG_CACHE_HOME or ~/.cache>/opencode/oc-bifrost/registry.json` - derived under the existing shared OpenCode user cache dir the bridge already uses (the same dir that holds `report.log` and `github/`), mirroring `reportPath` (`src/sink.ts:82-87`). It is **seeded from a bundled default registry when absent** (the bundled seed is `vendor/registry.seed.json`, shipped via the existing `files` entry `vendor`), and it is **user-editable** thereafter. An explicit `options.registry` path or `OC_BIFROST_REGISTRY` env overrides the default.

Registry entry format (the seed ships these four, verbatim):

```jsonc
{
  "aliases": {
    "rtk":          { "source": "github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts",   "update": "line" },
    "superpowers":  { "source": "github:obra/superpowers@v6.4.2#.opencode/plugins/superpowers.js", "update": "line" },
    "ascii":        { "source": "github:d3vv3/opencode-ascii@e42bb23f690d99f29578183bb02e0be270256b03#dist/index.js", "update": "off" },
    "flight-deck":  { "source": "github:nathwn12/oc-flight-deck@5d57f545d296ef905047efc70bb75ba45bdaf1b1#src/index.ts", "update": "branch", "branch": "main" }
  }
}
```

- **Unknown alias** -> loud refusal row naming the alias AND the registry path (existing refusal-class pattern; sanitized via `safe()`).
- **Corrupt, or missing-when-expected registry** -> loud refusal (never a silent empty registry; never a silent pass-through).
- **Full spec strings continue to pass through unchanged** - the currently wired long strings keep working exactly as today (backward compat; they are effectively static pins).

### Ruling U-2 - update policy enum

Per entry: `"update": "off" | "line" | "branch"`.

- **`off`** = immutable pin (40-hex or any ref; never floats). This is also the default behavior for every full long spec today - nothing floats unless a registry entry opts in.
- **`line`** = track the newest SAME-major.minor tag on the pinned tag's semver line (`v0.50.0` -> newest `v0.50.x` tag).
- **`branch`** = track the tip of the entry's named branch (default `main`).

**Default for a new registry entry whose `update` is omitted** (decided): `line` for tag refs (a ref matching `^v?\d+\.\d+\.\d+`), `branch` for branch refs (any other non-hex ref), `off` for full-40-hex refs.

**Full-40-hex baseline float transition (decided):** a full 40-hex ref with `update: "branch"` is a one-time baseline - the first update resolves the branch tip and floats away from the sha (`updated <alias> -> <branchTipSha> (was <fullSha>)`). A full 40-hex ref with `update: "line"` has **no tag line to anchor**, so it is **not an error** but is treated as static: a loud report row states that a `line` policy needs a tag ref and the entry stays pinned. The `branch` transition is the documented float-away case.

**Pre-release tags (decided):** pre-release tags (`v0.50.0-rc1`) are **excluded** from `line` selection - auto-updating to a pre-release is surprising and never silently chosen.

### Ruling U-3 - zero-API upstream resolution (the hard lesson)

Phase 2 MUST NOT use the GitHub API (`api.github.com` rate-limits this environment - the reason 1.3.2 pins 40-hex refs to skip resolution).

- **Primary tip resolution:** shell out to `git ls-remote https://github.com/<o>/<r> refs/tags/* refs/heads/<branch>` (spawned, zero runtime deps - the same shell-out discipline as the Phase 1 npm precedent; args-array spawn, no shell interpolation). `ls-remote` returns exact peeled commit shas for tags (`^{}` lines) and the branch tip - no API.
- **Fallback:** atom feeds (`https://github.com/<o>/<r>/tags.atom` and `/commits/<branch>.atom`) parsed for tip shas. **Sha availability (decided):** `commits/<branch>.atom` yields the branch tip sha directly (each entry id ends in `/commit/<40-hex>`), so it is a usable branch fallback. `tags.atom` yields the newest tag **name** only (its entries carry no peeled sha), so a `line` entry whose `ls-remote` fails AND whose `tags.atom` is reachable still **denies** - a tag name alone cannot anchor an immutable-identity fetch. The fallback never weakens the trust model.
- **If BOTH fail** (offline / parse failure / 403) -> denial (Ruling U-4). The plan includes a **live probe task** that actually runs `git ls-remote` against all four upstream repos and records reachability as evidence.

### Ruling U-4 - "deny if impossible" semantics

Every cold setup performs the cheap upstream tip check for float entries.

- **Changed tip** -> fetch the new tarball via the existing codeload path (BY the new sha), sha256-verify (existing invariant), provision it (Phase 1's `provisionTree` - the update flow calls it, which is why Phase 2 executes after Phase 1 lands), mount, and report `updated <alias> -> <newSha> (was <oldSha>)`.
- **Unchanged** -> `up-to-date <alias> @ <sha>` row; the verified cache is served with `fetched: false`.
- **Upstream unreachable** -> loud denial row `update denied for <alias>: <endpoint> <status/error>`; the **last verified cached snapshot remains servable with `fetched: false`** (honesty contract: never present stale as fresh - the report row says so); with `strict: true` the denial **aborts setup**.

This satisfies "auto-update always from upstream, deny if impossible."

## 5. Security posture

Floating refs trade immutability for freshness, so the trust anchor is re-earned on every update, never assumed:

- **Every update re-verifies the tarball sha256** (unchanged invariant) before the tree is trusted; a float never silently weakens the digest chain.
- **The report records old -> new sha + the endpoint used** - `updated <alias> -> <newSha> (was <oldSha>)` names exactly what moved, so a rollback target is always stated.
- **`update: "off"` remains available per plugin** - immutability is one config value away for any entry that needs it.
- **The registry file is user-owned**; the bundled seed is a first-run convenience only. The bridge writes the registry exactly once (seed-on-absent, atomically - temp + rename, never a partial user file) and otherwise only reads it. A user's edits are never clobbered.
- **`git ls-remote` / atom output is untrusted input:** parsed strictly, sha/ref values validated against existing charset rules (`isValidRef`, `COMMIT_PATTERN`), and sanitized via `safe()` before any message. Spawn uses an args array (no shell), a timeout, and an output byte cap.
- **`trustRemote` remains the single consent gate**; update + provisioning are covered by it, and the report says so (the mount note continues to name host-rights reality).

**Explicit non-goals:** no `api.github.com` anywhere; no changes to the plugin-facing mount API; Phase 3 shape acceptance still out of scope; npm specifiers remain refused.

## 6. Options & environment

| Surface | Value | Meaning |
|---|---|---|
| `options.registry` | path | Registry path override (wins over env) |
| `OC_BIFROST_REGISTRY` | path | Registry path override (wins over default) |
| `options.update` | `"auto"` (default) \| `"off"` | `"auto"` lets float entries follow per-entry policy; `"off"` forces all entries static |
| `OC_BIFROST_UPDATE` | `"off"` | Global kill-switch - forces all entries static (offline/CI); explicit option wins |

- `trustRemote` (or `OC_BIFROST_TRUST=github`) still gates the first fetch and, by extension, the first float update; the report names it.
- Invalid registry-entry `update` values -> loud refusal at registry load (never a silent default).
- Full long specs without a registry entry are static and unchanged in behavior.

## 7. Out of scope (stays refused; not re-designed)

- **The seven refused V1 hooks** and **facade refusals** - unchanged (see the Phase 1 spec §6).
- **npm / bare `@scope/name` mounting** - `npm:` and `@scope/name` remain refused ("npm not supported"); only non-scope bare names gain the alias route.
- **`api.github.com`** - absent by design, everywhere in Phase 2.
- **Phase 3 shape acceptance** (effect-only V2, dual-export routing) - a later release.
- **The mount API** - `resolveGithubPlugin`'s returned shape is extended, not broken; the plugin-facing surface (spec -> importable URL -> mount) is unchanged.

## 8. Risks & open questions

- **`git ls-remote` availability.** Unauthenticated `git ls-remote` against GitHub is IP-rate-limited and requires a `git` binary on PATH; a host behind shared NAT, or without git, will deny float entries even where REST would not. Mitigation: 40-hex/`off` pins never resolve (0 calls); a denied float still serves the last verified snapshot with `fetched: false`; the atom fallback covers branch entries where reachable.
- **Float = moving supply chain.** A `line`/`branch` entry can adopt a malicious upstream commit the moment upstream publishes it. Mitigation: sha256 re-verification does not vouch for the publisher - it pins "these are the bytes upstream served"; `update: "off"` is the explicit escape hatch; the report always names the sha, so nothing moves silently.
- **`line` on a full-sha baseline is static (Ruling U-2).** Decided, not open; recorded here for the record: the seed's `flight-deck` (full sha + `branch`) floats, `ascii` (full sha + `off`) does not - no line-on-sha case exists in the seed.
