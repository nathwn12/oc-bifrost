# INSTALL — agent-first

**You are the agent. This page is written for you to execute.** The human says *"set up oc-bifrost for my `<plugin>`"* — you do the rest and report.

Do not hand the human a wall of steps. Do them, then report: what you changed, what you verified, what you could not.

---

## 0. Preflight (always)

1. Confirm the host is OpenCode V2: `opencode --version` → expect `2.x`.
2. Locate the config in use: `opencode debug paths` → read the `config` line. **Never assume `~/.config/opencode`** — respect the reported path. If `OPENCODE_CONFIG_DIR` is set, that is the config root.
3. Confirm you may write there. The global config directory is often owned by a stricter writer agent. If your write is denied, **hand the edit to that writer; never reword the path or route it through a shell**.

## 1. Add the bridge entry

The bridge is one entry in the config's `plugins` array. OpenCode resolves and installs the npm
package itself — there is no separate `npm i` step:

```jsonc
{
  "plugins": [
    {
      "package": "@nathwn12/oc-bifrost@1.6.1",
      "options": {
        "plugins": ["<exactly one specifier — one of the three paths below>"],
        "strict": false,
        "verbose": true
      }
    }
  ]
}
```

### 1a. Choose the version form — then verify what resolved

**Pin an exact version:** `"@nathwn12/oc-bifrost@1.6.1"` - the default and the version this page
describes. `@^1.0.0` tracks 1.x and never adopts a new major silently. A bare `@nathwn12/oc-bifrost` or
`@latest` may be unstable while OpenCode's plugin cache settles. State the form you used in your report.

After adding the entry, **verify the resolved version — do not assume it**:

```sh
opencode plugin check     # re-resolves online
opencode plugin list      # shows what is actually loaded
```

If the resolved version is wrong or stale, delete
`~/.cache/opencode/npm/@nathwn12/oc-bifrost@latest` and reload — or pin an exact version.

## 2. Mount the legacy plugin — one of three paths

| # | Path | Use when |
|---|---|---|
| 1 | `github:` (advertised / default) | the plugin's source lives in a GitHub repo — online fetch |
| 2 | `preset:rtk` (offline fallback, optional) | no network — GitHub unreachable, or an air-gapped host |
| 3 | local file (fallback) | the plugin is a file on disk |

Pick exactly one per plugin. Npm/bare package specifiers are not supported yet — the bridge refuses
them out loud.

### Path 1 — `github:` (advertised / default, online)

`github:<owner>/<repo>[@<ref>][#<path>]` — e.g. `github:obra/superpowers`.

**Snapshot-first.** The ref resolves to a commit once, at first fetch (the repository's
default branch when no `@<ref>`), then the **repository tarball** is downloaded from
codeload **at that resolved commit** and materialized as a whole tree — sibling files
exist beside the entry file, so `github:obra/superpowers` reads its own `skills/`.

- **Caps:** 16 MiB compressed · 64 MiB uncompressed · 5000 files. A breach never
  truncates — it degrades (below) loudly.
- **Hostile archives are refused outright, never materialized:** path-traversal,
  absolute/`..` escapes, NUL/backslash names, duplicate paths. A link or device entry
  refuses the snapshot too. Nothing hostile is cached and nothing is executed.
- **Loud single-file fallback.** An over-cap, malformed, or candidate-less snapshot
  mounts via the old one-file fetch — the mount note says loudly that sibling files are
  **NOT** available and a plugin that reads them by relative path is inert. The
  downgrade is never silent.
- No `#<path>` → `hooks/opencode/<repo>.ts`, `hooks/opencode/index.ts`, `plugin.ts`, and
  `index.ts` are probed in order inside the materialized tree. Pass `#<path>` when the
  plugin lives elsewhere; a failed probe lists every path it tried.
- First load fetches once into the shared user cache at
  `$XDG_CACHE_HOME/opencode/oc-bifrost/github/v2/<id>/` (default:
  `~/.cache/opencode/oc-bifrost/github/v2/<id>/`; the tree sits at `…/v2/<id>/tree/`)
  and records the sha256 of the tarball **and** the entry file — trust on first use.
  Later loads from any project verify the cached bytes against that record with zero
  network; a mismatch refuses loudly. A flat pre-snapshot cache at `…/github/<id>/` is
  ignored with a warning (it cannot provide sibling files) and re-fetched with the same
  one-time consent.

**Consent gate — the first fetch is an explicit, informed opt-in.** The first fetch
downloads a repository snapshot from GitHub and executes its entry file with the host
process's full user rights. Mounting by source is trusting the publisher; the recorded
sha256 pins those bytes afterwards, it does not vouch for them. A cold cache refuses by
default, before anything is fetched or executed, and names exactly what would be
downloaded and both opt-ins:

```text
[oc-bifrost] refusing to fetch "github:obra/superpowers" (cold cache, first use): the first fetch would download the repository snapshot at the resolved commit (up to 16777216 compressed bytes), including one of, in order: hooks/opencode/superpowers.ts, hooks/opencode/index.ts, plugin.ts, index.ts from https://github.com/obra/superpowers at the repository's default branch (resolved at fetch time) and EXECUTE its entry file with this host process's full user rights. First-use fetching is opt-in, per oc-bifrost entry: set options.trustRemote: true, or set the environment variable OC_BIFROST_TRUST=github. Nothing was fetched and nothing was executed. A warm (hash-verified) cache never needs this consent.
```

- Opt in on the bridge entry, or via the environment:

  ```jsonc
  { "package": "@nathwn12/oc-bifrost@1.6.1", "options": { "trustRemote": true, "plugins": ["github:obra/superpowers"] } }
  ```

  `OC_BIFROST_TRUST=github` does the same from the environment; an explicit `trustRemote: false`
  wins over it.
- A warm, hash-verified cache needs no re-consent and no network.
- The mount report always prints the resolved commit, the digest, and the host-rights line
  (`…; executes with the host process's full user rights`) — the consent stays informed on every
  load.
- Offline or air-gapped: the cold-cache fetch fails closed —
  `Cold-cache fetching is fail-closed — oc-bifrost never falls back to another source. If this machine
  is offline or air-gapped, pre-warm the cache on a networked machine (run oc-bifrost once with
  opt-in) and copy its shared `oc-bifrost/github` cache directory across.`

> **Version gate.** `github:` requires **oc-bifrost 0.4.0 or later**; releases **0.3.0 and below**
> cannot mount it — on those, use path 2 (offline fallback) or path 3.

### Path 2 — `preset:rtk` (offline fallback, optional, bundled, zero-fetch)

`"plugins": ["preset:rtk"]` mounts the vendored `rtk-ai/rtk` plugin (`v0.50.0`, Apache-2.0).
Nothing is fetched and nothing is parked.

Prerequisite: the `rtk` binary (`>= 0.23.0`) on `PATH`. The preset probes before mounting and warns
loudly if it is missing (`strict: true` aborts). Install the binary once:

```sh
winget install rtk-ai.rtk        # Windows
brew install rtk                 # macOS / Linux
```

or take the release asset from [`rtk-ai/rtk`](https://github.com/rtk-ai/rtk/releases). Do **not**
`cargo install rtk` — the crates.io crate of that name is a different project.

Do **not** run `rtk init -g --opencode`: it writes `rtk.ts` into `<config>/plugins/`, a discovery
directory (see step 3).

### Path 3 — local file (fallback)

- Project install: `"plugins": ["./.opencode/legacy/<name>.ts"]` — a relative specifier resolves
  against the **session directory**, so it works only in the project that owns the file.
- Global install: park the file in `<config>/legacy/<name>.ts` and reference it by **absolute path**
  — e.g. `C:/Users/you/.config/opencode/legacy/rtk.ts`, or `/home/you/.config/opencode/legacy/rtk.ts`
  on macOS/Linux.

## 3. Park the legacy plugins correctly

**A V1 plugin left in `.opencode/plugins/` is hard-rejected by V2 before the bridge can see it:**

```
Plugin must export a default definition with an id and an effect or setup function
```

Move it out of discovery — `legacy/` is the convention — and reference it from `options.plugins`:

- relative specifiers resolve against the **session directory** (project-local only)
- absolute paths work everywhere; npm/bare names are refused (not supported yet)
- the bridge warns at load when it finds a stranded V1 file in a discovery directory

### Global install (all projects)

The same rule applies with a sharper edge at the global config:

- Park the legacy plugin in `<config>/legacy/<name>.ts` — **never** in `<config>/plugin/`
  or `<config>/plugins/`. Those two are discovery directories: a bare `.ts` file there is
  loaded directly and hard-rejected before the bridge can see it.
- Reference it by **absolute path**. The bridge resolves relative specifiers against the
  session directory, so `./legacy/rtk.ts` only works in the one project that owns that file.

> **Known landmine.** Some plugins ship their own installer — `rtk init -g --opencode` writes
> the plugin straight into `<config>/plugins/`. Because that directory is scanned, the
> installer *breaks* the host instead of wiring the bridge. Park the file in `legacy/` and
> reference it from `options.plugins` instead.

## 4. Verify (do not skip — this is the deliverable)

1. Restart the host so the config reloads.
2. Trigger one real tool call (any shell command is enough).
3. Confirm:
   - the load log contains `loading plugin` for the bridge entrypoint, and **no** `LoadError`;
   - the bridge printed a per-plugin report: `mounted v1:<id>`, then a row per hook.
4. If the plugin's behaviour is observable (a rewritten command, a marker file, a toast), assert on the **side effect**, not on the report. The report says what was registered; only the side effect says it executed.
5. **Strongest check — read the host's spawn log.** Run a host with `--print-logs` and grep for `spawning process`. The logged `args` are the command that *actually executed*, after every `tool.execute.before` rewrite — the host's own record, not an inference:

   ```pwsh
   opencode run --standalone --print-logs --format json "run exactly: git status --porcelain"
   # then:
   Select-String -Path <captured output> -Pattern 'spawning process'
   ```

   A bridged rewrite shows up as e.g. `rtk git status --porcelain`. Note the tool-call record
   still shows the *pre-rewrite* input, so the spawn log is the only place the real command is
   visible.

**Legend:** `full` = bridged with write-back · `partial` = bridged with a stated loss · `unsupported` = refused out loud (set `strict: true` to abort instead).

## 5. Rollback (always know it)

Remove the bridge entry from `plugins` and restart. Delete the corresponding entry under
`$XDG_CACHE_HOME/opencode/oc-bifrost/github/` (default `~/.cache/opencode/oc-bifrost/github/`)
if you want to remove a downloaded `github:` plugin. Nothing else was modified: the bridge writes
no state to the project.

## 6. Report to the human

State: path used (1, 2, or 3) · config path touched · legacy plugin path · hooks mounted and their levels · the side effect you verified · anything `unsupported` the plugin depends on. If a hook the plugin needs is `unsupported`, say so plainly and do not claim success.

---

## Guardrails for the agent

- One writer per config file. If denied, delegate — never retry by another name.
- Never leave a V1 file in a discovered plugin directory.
- Never edit the human's env permanently to make a test pass. Prefer a per-process scope.
- If the plugin needs an `unsupported` hook, report it as a **port candidate**, not a bridged success.
