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
4. Add the bridge to the config's `plugins` array:
   - published package: `{ "package": "@nathwn12/oc-bifrost", "options": { "plugins": ["<specifier>"] } }`
   - local: a **directory** entry (`index.js` + `package.json`) — the host rejects file paths with `configured plugin path must be a directory`.
5. Restart. Confirm `loading plugin` with no `LoadError`, and read the printed report.
6. Verify with a **side effect**, not the report: trigger one real tool call and assert the plugin's observable behaviour actually happened.

## Matrix levels

- `full` — bridged, write-back proven (`tool.execute.before`, `shell.env`, `chat.headers`, `permission.ask`, `dispose`).
- `partial` — bridged with a stated loss (`tool.execute.after`, `chat.params`, `chat.message`, `tool.definition`, `tool`, `event`, the `experimental.*` session hooks).
- `unsupported` — refused out loud: `config`, `auth`, `provider`, `command.execute.before`, `experimental.provider.small_model`, `experimental.compaction.autocontinue`, `experimental.text.complete`.

If the plugin depends on an `unsupported` hook, report it as a **port candidate** — never as a bridged success.

## Guardrails

- Config edits may be owned by another writer agent — delegate on the first denial; never route around it.
- Never permanently change the host environment to make a test pass.
- For any read of the OpenCode source, cite `file:line`.
