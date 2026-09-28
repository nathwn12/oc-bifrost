# oc-bifrost

[![npm](https://img.shields.io/npm/v/@nathwn12/oc-bifrost?label=npm&color=205EA6)](https://www.npmjs.com/package/@nathwn12/oc-bifrost)
[![check](https://github.com/nathwn12/oc-bifrost/actions/workflows/ci.yml/badge.svg)](https://github.com/nathwn12/oc-bifrost/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-66800B.svg)](LICENSE)

**The rainbow bridge for OpenCode plugins.** Run V1-era plugin hooks on the OpenCode **V2** runtime.

```sh
npm i @nathwn12/oc-bifrost
```

OpenCode V2 intentionally broke the plugin API — a V1 plugin module is now hard-rejected at load:

> `Plugin must export a default definition with an id and an effect or setup function.`
> — `packages/core/src/plugin/module.ts`

Most plugins never got ported. `oc-bifrost` is one small plugin that loads them anyway, translates their V1 hooks onto V2 registration calls, and tells you exactly what it could not bridge.

## Install

### Package (recommended)

```sh
npm i @nathwn12/oc-bifrost
```

```jsonc
{
  "plugins": [
    {
      "package": "@nathwn12/oc-bifrost",
      "options": {
        "plugins": ["./.opencode/legacy/rtk.ts"],
        "strict": false,
        "verbose": true
      }
    }
  ]
}
```

> **Never leave a V1 plugin inside `.opencode/plugins/`.** V2 rejects it there with
> `Plugin must export a default definition with an id and an effect or setup function` before
> oc-bifrost can see it. Park legacy files in `.opencode/legacy/`.

### Local (pinned checkout, or offline)

A configured local plugin entry **must be a directory**, not a file — the host rejects a file with
`configured plugin path must be a directory`. Use a directory containing an `index.js` that
re-exports the built plugin:

```text
<config>/plugins/oc-bifrost/
├── index.js        export { default } from "<repo>/dist/index.js"
└── package.json    { "type": "module", "exports": { ".": "./index.js" } }
```

```jsonc
{
  "plugins": [
    {
      "package": "<config>/plugins/oc-bifrost",
      "options": {
        "plugins": ["./.opencode/legacy/rtk.ts"],
        "strict": false,
        "verbose": true
      }
    }
  ]
}
```

See [`PROOF.md`](PROOF.md) for a verified isolated run — and Proof 4 there for a **live** global install.

### Global install (all projects)

Installing into `~/.config/opencode` adds two rules, and both bite **silently**:

- **Use an absolute path.** oc-bifrost resolves a relative specifier against the *session*
  directory, so `./.opencode/legacy/rtk.ts` works only in the one project that owns that file.
  Anywhere else the import fails and the plugin is skipped with a warning.
- **Never park the legacy file in `<config>/plugin/` or `<config>/plugins/`.** Both are
  auto-discovery directories; a bare `.ts` there is loaded directly and hard-rejected before
  oc-bifrost can see it. Use `<config>/legacy/`.

```jsonc
{
  "plugins": [
    {
      "package": "@nathwn12/oc-bifrost",
      "options": { "plugins": ["C:/Users/you/.config/opencode/legacy/rtk.ts"] }
    }
  ]
}
```

> **Known landmine.** Some plugins ship an installer that writes straight into a discovery
> directory: `rtk init -g --opencode` targets `~/.config/opencode/plugins/rtk.ts`, which
> *breaks* the host instead of wiring the bridge. Park the file in `legacy/` yourself and
> reference it from `options.plugins`.

### The plugin's own prerequisites are still yours

oc-bifrost bridges **hooks**, not a plugin's external dependencies. If a plugin shells out to a
binary, that binary must exist on `PATH` or the plugin will disable itself — correctly, and
usually quietly.

RTK is the worked example; it needs `rtk >= 0.23.0`:

```sh
winget install rtk-ai.rtk        # Windows
brew install rtk                 # macOS / Linux
```

No winget? Take the `rtk-x86_64-pc-windows-msvc.zip` asset from
[`rtk-ai/rtk` releases](https://github.com/rtk-ai/rtk/releases) and check it against the
published digest.

> ⚠️ **Name collision.** The crates.io crate `rtk` is a *different project* ("Rust Type Kit"),
> and so is `rtk-cli`. `cargo install rtk` gives you the wrong binary. Install from
> `rtk-ai/rtk` only.

### First proof: mount RTK with one line

RTK is the bridge's showcase — a real, unmodified V1 plugin whose effect you can *watch*.

```jsonc
{
  "plugins": [
    { "package": "@nathwn12/oc-bifrost", "options": { "plugins": ["preset:rtk"] } }
  ]
}
```

The plugin file is **bundled** — `vendor/rtk.ts`, verbatim `rtk-ai/rtk` `v0.50.0` (Apache-2.0) — so
nothing is fetched at install time. Two things make it an honest demo:

- **The prerequisite is checked, loudly.** RTK's plugin self-disables when the `rtk` binary is
  absent. `preset:rtk` probes for it *before* mounting and names the exact install command if it is
  missing, instead of mounting and silently rewriting nothing.
- **It is opt-in.** Nothing from RTK runs unless you ask for `preset:rtk`.

You still need the binary — the bridge bridges **hooks**, not binaries:

```sh
winget install rtk-ai.rtk        # Windows
brew install rtk                 # macOS / Linux
```

Then a shell command like `git status` executes as `rtk git status`. Live evidence:
[`PROOF.md`](PROOF.md) Proof 4 and [`VERIFIED-PLUGINS.md`](VERIFIED-PLUGINS.md).

> ⚠️ **Do not run `rtk init -g --opencode`.** Upstream installs to
> `~/.config/opencode/plugins/rtk.ts` — a discovery directory where V2 hard-rejects V1 modules.
> `preset:rtk` exists precisely so you never touch that path.

> ⚠️ **A directory entry must be the documented shim, not the installed package directory.**
> Pointing `package` straight at `node_modules/@nathwn12/oc-bifrost` is dropped by the host
> **silently** — no error, the plugin just never loads. Use the npm package name (Route A above)
> or the shim directory shown in Route B. Both are proven in [`PROOF.md`](PROOF.md).

## Let your agent set it up

This is an **agent-first** repo. You do not have to read the install steps — tell your agent:

> *"Set up oc-bifrost for my legacy plugin at `.opencode/legacy/rtk.ts`."*

Your agent follows [`INSTALL.md`](INSTALL.md), picks the npm or local route, parks the legacy plugin
where V2 will not reject it, and proves it with a side effect before reporting. A drop-in skill is
included at [`skills/oc-bifrost/SKILL.md`](skills/oc-bifrost/SKILL.md).

Prefer to do it yourself? Read [`INSTALL.md`](INSTALL.md) — Route B is the local route.

## What it does

- **V1 factory** `async (input) => Hooks` → hook translation
- **V1 module** `{ id, server }` → hook translation
- **V2 definition** `{ id, setup }` → mounted with the same context

It hands V1 plugins a faithful-enough `PluginInput`: `directory`, `project`, a `$` shell (Bun's when present, a portable shim otherwise), and a `client` facade that **throws loudly** on anything it cannot provide rather than returning a plausible lie.

## Compatibility matrix

The unit of compatibility is the **V1 hook**, not the plugin. Once a hook is bridged, every plugin that uses it works untouched.

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

This bridges **the mappable subset**, not "any plugin, seamlessly." Three V1 hooks have no V2 destination — no compatibility layer can invent one. Plugins that depend on those need a real port. The refusal list is the product being honest, and it is the contract.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `plugins` | `Array<string \| { spec, options }>` | `[]` | Modules to bridge |
| `strict` | `boolean` | `false` | Abort setup on an unsupported hook |
| `verbose` | `boolean` | `true` | Print the per-plugin compatibility report |

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
