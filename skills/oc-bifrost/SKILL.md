---
name: oc-bifrost
description: Wire a V1-era OpenCode plugin to run on the OpenCode V2 runtime using oc-bifrost. Use when a legacy plugin fails to load with "Plugin must export a default definition with an id and an effect or setup function", when migrating plugins from OpenCode V1 to V2, or when the user asks to bridge/adapt an old plugin.
---

# oc-bifrost — bridge a V1 plugin onto OpenCode V2

Read `INSTALL.md` in the oc-bifrost repo and execute it. Summary of the contract:

## The failure this fixes

V2 hard-rejects V1 plugin modules:

```
Plugin must export a default definition with an id and an effect or setup function
```

## Procedure

1. `opencode --version` → must be `2.x`.
2. `opencode debug paths` → read the `config` line. **Use that path.** Never assume `~/.config/opencode`.
3. Move the legacy plugin out of any discovered plugin directory — `.opencode/legacy/<name>.ts`. A V1 file left in `.opencode/plugins/` is rejected before the bridge can see it.
4. Add the bridge to the config's `plugins` array — one entry; OpenCode resolves the package, no `npm i`:
   `{ "package": "@nathwn12/oc-bifrost@1.3.3", "options": { "plugins": ["<one specifier>"] } }`
   The specifier is exactly one of three paths:
   - `github:<owner>/<repo>[@<ref>][#<path>]` — **the advertised, default route**, by source (requires oc-bifrost 0.4.0 or later; releases 0.3.0 and below cannot mount it).
     The first fetch downloads a plugin from GitHub and EXECUTES it with the host process's full user
     rights — by source means trusting the publisher. A cold cache refuses by default and names both
     opt-ins: `"trustRemote": true` on the bridge entry, or `OC_BIFROST_TRUST=github` in the
     environment. A warm, hash-verified cache then loads with no re-consent and no network; the mount
     report always prints the resolved commit, the digest, and the host-rights line. An offline cold
     cache fails closed and names the pre-warm path.
   - `preset:rtk` - optional offline / no-fetch fallback, for air-gapped hosts (needs the `rtk` binary on `PATH`)
   - a local path - `./.opencode/legacy/<name>.ts` (project) or an absolute path (global)
   Option keys: `provision` - `"host"` (default) junctions a fetched snapshot's declared
   dependencies from the shared OpenCode npm cache (zero network), `"npm"` adds an
   `npm install --no-save` fallback, `"off"` disables provisioning (`OC_BIFROST_PROVISION`
   sets the mode when the option is omitted; an explicit option wins). `wireTui` (default
   `false`) adds a `tui.tsx` wrapper and a `file://` plugins entry in cli.json after a
   `github:` snapshot mounts (`OC_BIFROST_WIRE_TUI=1` opts in; snapshot layouts only).
5. Restart. Confirm `loading plugin` with no `LoadError`, and read the printed report.
6. Verify with a **side effect**, not the report: trigger one real tool call and assert the plugin's observable behaviour actually happened.

## Matrix levels

- `full` — bridged, write-back proven (`tool.execute.before`, `shell.env`, `chat.headers`, `permission.ask`, `dispose`).
- `partial` — bridged with a stated loss (`tool.execute.after`, `chat.params`, `chat.message`, `tool.definition`, `tool`, `event`, the `experimental.*` session hooks).
- `unsupported` — refused out loud: `config`, `auth`, `provider`, `command.execute.before`, `experimental.provider.small_model`, `experimental.compaction.autocontinue`, `experimental.text.complete`.

If the plugin depends on an `unsupported` hook, report it as a **port candidate** — never as a bridged success.

## Guardrails

- Config edits may be owned by another writer agent — delegate on the first denial; never route around it.
- Never silently enable `trustRemote` for a `github:` plugin: it executes publisher code with the
  host process's full user rights. Surface that decision to the human.
- Never permanently change the host environment to make a test pass.
- Pin the bridge version explicitly — `"@nathwn12/oc-bifrost@1.3.3"` by default, `@^1.0.0` to track 1.x; a
  bare or `@latest` specifier may be unstable while OpenCode's plugin cache settles — run
  `opencode plugin check`, or delete `~/.cache/opencode/npm/@nathwn12/oc-bifrost@latest` and reload.
- For any read of the OpenCode source, cite `file:line`.
