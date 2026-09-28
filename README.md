# oc-bifrost

[![npm](https://img.shields.io/npm/v/@nathwn12/oc-bifrost?label=npm&color=205EA6)](https://www.npmjs.com/package/@nathwn12/oc-bifrost)
[![check](https://github.com/nathwn12/oc-bifrost/actions/workflows/ci.yml/badge.svg)](https://github.com/nathwn12/oc-bifrost/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-66800B.svg)](LICENSE)

**The rainbow bridge for OpenCode plugins.** Run V1-era plugin hooks on the OpenCode **V2** runtime.

**[Install](#install)** — one config entry; name each legacy plugin one of three ways: `github:` source, the bundled `preset:rtk`, or a local file.

OpenCode V2 intentionally broke the plugin API — a V1 plugin module is now hard-rejected at load:

> `Plugin must export a default definition with an id and an effect or setup function.`
> — `packages/core/src/plugin/module.ts`

Most plugins never got ported. `oc-bifrost` is one small plugin that loads them anyway, translates their V1 hooks onto V2 registration calls, and tells you exactly what it could not bridge.

## Install

The bridge is one entry in the `plugins` array of your OpenCode config — OpenCode resolves the package itself, so there is no separate install step. Then name each legacy plugin with **exactly one** of these three specifiers:

### 1. Official / universal — mount by source (`github:`)

Point the bridge at the plugin's GitHub source — and consent to the first fetch in the same entry:

```jsonc
{
  "package": "@nathwn12/oc-bifrost",
  "options": {
    "trustRemote": true, // consent: the first `github:` fetch downloads and executes a remote plugin
    "plugins": ["github:obra/superpowers"]
  }
}
```

Form: `github:<owner>/<repo>[@<ref>][#<path>]`

- No `@<ref>` → the repository's default branch, resolved once at first fetch.
- No `#<path>` → `hooks/opencode/<repo>.ts`, `hooks/opencode/index.ts`, `plugin.ts`, and `index.ts` are probed in order; if none exists, the refusal lists every path it tried.
- The first load fetches the file once into `legacy/cache/<id>/` (under the session directory) and records its sha256 — trust on first use. Every later load verifies the cached bytes against that record: zero network, and a mismatch refuses loudly instead of running unverified bytes.

**Trust model — the first fetch is an explicit, informed opt-in.** The first fetch downloads a plugin file from GitHub and **executes it in the host process, with the same rights you have**. Mounting a plugin by source is trusting its publisher: the sha256 recorded on first use pins those exact bytes afterwards — it does not vouch for them. A cold cache therefore refuses by default, before anything is fetched or executed, naming exactly what would be downloaded and both opt-ins:

```text
[oc-bifrost] refusing to fetch "github:obra/superpowers" (cold cache, first use): the first fetch would download one of, in order: hooks/opencode/superpowers.ts, hooks/opencode/index.ts, plugin.ts, index.ts from https://github.com/obra/superpowers at the repository's default branch (resolved at fetch time) and EXECUTE it with this host process's full user rights. First-use fetching is opt-in, per oc-bifrost entry: set options.trustRemote: true, or set the environment variable OC_BIFROST_TRUST=github. Nothing was fetched and nothing was executed. A warm (hash-verified) cache never needs this consent.
```

- **Consent once** — `"trustRemote": true` on the bridge entry, or `OC_BIFROST_TRUST=github` in the environment (an explicit `trustRemote: false` wins over the environment variable). It governs the first fetch only: a warm, hash-verified cache loads with **no re-consent and no network**.
- **The mount report keeps the consent informed** — it always prints the resolved commit, the digest, and the host-rights line: `fetched github:obra/superpowers@<ref>#<path> at commit <commit-sha> (sha256 <digest>…, <bytes> bytes; trust-on-first-use); executes with the host process's full user rights` on a first fetch, and `loaded from cache (commit <commit-sha>, sha256 <digest>… verified; fetched <time>); executes with the host process's full user rights` afterwards.
- **Offline or air-gapped** — the cold-cache fetch fails closed: `Cold-cache fetching is fail-closed — oc-bifrost never falls back to another source. If this machine is offline or air-gapped, pre-warm the cache on a networked machine (run oc-bifrost once with opt-in) and copy its legacy/cache directory across.`

> **Version gate.** `github:` ships in **0.4.0** (this release). Earlier published releases (0.3.0 and below) cannot mount `github:` specifiers - on those, use one of the two samples below.

### 2. Sample — `preset:rtk` (bundled, zero-fetch)

```jsonc
{ "package": "@nathwn12/oc-bifrost", "options": { "plugins": ["preset:rtk"] } }
```

RTK is the showcase: a real, unmodified V1 plugin whose effect you can watch. The plugin file is **bundled** — `vendor/rtk.ts`, verbatim `rtk-ai/rtk` `v0.50.0` (Apache-2.0) — so nothing is fetched at install time. It is opt-in: nothing from RTK runs unless you ask for `preset:rtk`.

**Prerequisite: the `rtk` binary (`>= 0.23.0`) must be on `PATH`.** `preset:rtk` probes before mounting and names this command if it is missing:

```sh
winget install rtk-ai.rtk        # Windows
brew install rtk                 # macOS / Linux
```

No winget? Take the release asset from [`rtk-ai/rtk`](https://github.com/rtk-ai/rtk/releases) instead. Not from crates.io: `cargo install rtk` installs a different project.

Then a shell command like `git status` executes as `rtk git status`. Live evidence: [`PROOF.md`](PROOF.md) Proof 4 and [`VERIFIED-PLUGINS.md`](VERIFIED-PLUGINS.md).

> ⚠️ **Do not run `rtk init -g --opencode`.** Upstream writes `rtk.ts` into `~/.config/opencode/plugins/` — a discovery directory where V2 hard-rejects V1 modules. `preset:rtk` exists precisely so you never touch that path.

### 3. Sample — a local file

For a plugin you have on disk. A relative specifier resolves against the **session directory**, so it works only in the one project that owns the file:

```jsonc
{ "package": "@nathwn12/oc-bifrost", "options": { "plugins": ["./.opencode/legacy/my-plugin.ts"] } }
```

A global install (all projects) parks the file outside every discovery directory and uses an absolute path:

```jsonc
{ "package": "@nathwn12/oc-bifrost", "options": { "plugins": ["C:/Users/you/.config/opencode/legacy/my-plugin.ts"] } }
```

> **Never leave a V1 plugin inside a discovery directory** — `.opencode/plugin/`, `.opencode/plugins/`, and the global `<config>/plugin/`, `<config>/plugins/`. V2 loads those directly and hard-rejects the module before oc-bifrost can see it (`Plugin must export a default definition with an id and an effect or setup function`). Park legacy files in `legacy/`; the bridge also warns at load if it finds one stranded.

oc-bifrost bridges **hooks**, not a plugin's external dependencies. If a plugin shells out to a binary, that binary must exist on `PATH` or the plugin disables itself — correctly, and usually quietly. RTK above is the worked example.

## Staying fresh

The bundled `preset:rtk` is **pinned** to a specific upstream tag (`vendor/rtk.ts` is byte-identical
to `rtk-ai/rtk`; its sha256, git blob, and license are recorded in `vendor/README.md` and
`vendor/rtk.meta.json`). The mount report always names the pinned version — with **zero network
access**.

Optionally, you can ask the bridge to compare that pin against upstream's latest release:

```jsonc
{ "package": "@nathwn12/oc-bifrost", "options": { "freshness": "online" } }
```

- **The check is off by default.** Enable it with `freshness: "online"` or the environment
  variable `OC_BIFROST_FRESHNESS=online`. An explicit option wins over the environment variable.
- **It never downloads or executes plugin code.** It only reads the upstream releases API, is
  timeboxed, and never throws. It is fired **off the plugin-load path** — not awaited during `setup` — so a slow
  network cannot delay or break a mount; the notice may appear shortly after the mount report.
  Being offline, rate-limited, or otherwise unable to check reports `unknown` (informational), not
  an error, so an offline machine stays quiet.
- When it reports **behind**, the vendored copy is older than upstream's latest release:
  - an OpenCode-installed bridge: OpenCode tracks plugin package versions and offers the update in
    its `Plugins` list (`update available`).
  - a source checkout: `npm run vendor:update` (preview with `--dry-run`; offline: `--from-file`).
    The updater rewrites every copy of the pin and runs the full check; if the check fails it prints
    the exact revert.

## Let your agent set it up

This is an **agent-first** repo. You do not have to read the install steps — tell your agent:

> *"Set up oc-bifrost for my legacy plugin at `.opencode/legacy/rtk.ts`."*

Your agent follows [`INSTALL.md`](INSTALL.md), picks one of the three paths, parks the legacy plugin
where V2 will not reject it, and proves it with a side effect before reporting. A drop-in skill is
included at [`skills/oc-bifrost/SKILL.md`](skills/oc-bifrost/SKILL.md).

Prefer to do it yourself? Read [`INSTALL.md`](INSTALL.md).

## What it does

- **V1 factory** `async (input) => Hooks` → hook translation
- **V1 module** `{ id, server }` → hook translation
- **V2 definition** `{ id, setup }` → mounted with the same context

It hands V1 plugins a faithful-enough `PluginInput`: `directory`, `project`, a `$` shell (Bun's when present, a portable shim otherwise), and a `client` facade that **throws loudly** on anything it cannot provide rather than returning a plausible lie.

## Compatibility matrix

The unit of compatibility is the **V1 hook**, not the plugin. Once a hook is bridged, every plugin that uses it works untouched.

**5 🟢 full · 9 🟡 partial · 7 🔴 refused** — all 21 V1 hooks:

| V1 hook | Level | V2 destination |
|---|---|---|
| `tool.execute.before` | 🟢 full | `ctx.tool.hook("execute.before")` — mutation write-back verified |
| `shell.env` | 🟢 full | `ctx.shell.hook("create.before")` |
| `chat.headers` | 🟢 full | `ctx.session.hook("model.request")` |
| `permission.ask` | 🟢 full | `ctx.permission.hook("evaluate")` |
| `dispose` | 🟢 full | `setup` cleanup return |
| `tool.execute.after` | 🟡 partial | `ctx.tool.hook("execute.after")` — `title` ignored |
| `chat.params` | 🟡 partial | `ctx.session.hook("context")` |
| `chat.message` | 🟡 partial | `ctx.session.hook("prompt")` |
| `tool.definition` | 🟡 partial | `ctx.tool.transform` (apply-time snapshot) |
| `tool` | 🟡 partial | `ctx.tool.transform` editor.add |
| `event` | 🟡 partial | `ctx.event.subscribe()` — V2 event names differ |
| `experimental.chat.system.transform` | 🟡 partial | `ctx.session.hook("context")` |
| `experimental.chat.messages.transform` | 🟡 partial | `ctx.session.hook("context")` |
| `experimental.session.compacting` | 🟡 partial | `ctx.session.hook("compaction")` |
| `config` | 🔴 refused | per-domain transforms, different semantics |
| `auth` | 🔴 refused | `ctx.integration.transform` |
| `provider` | 🔴 refused | `ctx.provider.transform` / `ctx.model.transform` |
| `command.execute.before` | 🔴 refused | no one-to-one global V2 hook |
| `experimental.provider.small_model` | 🔴 refused | no V2 equivalent |
| `experimental.compaction.autocontinue` | 🔴 refused | no V2 equivalent |
| `experimental.text.complete` | 🔴 refused | no V2 equivalent |

**No hook is ever dropped silently.** Refused hooks warn at load (or abort under `strict: true`). The single source of truth is [`src/compat-matrix.ts`](src/compat-matrix.ts), and every row names the test that proves it.

## Honest bounds

This bridges **the mappable subset**, not "any plugin, seamlessly." Seven of the twenty-one V1 hooks
are refused out loud: no faithful V2 destination exists for their semantics, and no compatibility
layer can invent one. Plugins that depend on those need a real port. The refusal list is the product
being honest, and it is the contract.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `plugins` | `Array<string \| { spec, options }>` | `[]` | Plugin specifiers to bridge — `github:`, `preset:`, or a local path |
| `trustRemote` | `boolean` | `false` | Consent to fetch + execute a `github:` plugin on a cold cache — see the trust model above |
| `strict` | `boolean` | `false` | Abort setup on an unsupported hook |
| `verbose` | `boolean` | `true` | Print the per-plugin compatibility report |
| `freshness` | `"off" \| "online"` | `"off"` | Check the bundled pin against upstream's latest release after mounting |

## Develop

```sh
npm install
npm run check      # typecheck + build + tests
```

## Contributing

Two doors, both gated on proof:
- **Add hook coverage** — edit `compat-matrix.ts`, implement the bridge, and add the test its row names.
- **Add a verified plugin** — smoke-test it and add a row to [`VERIFIED-PLUGINS.md`](VERIFIED-PLUGINS.md).

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
