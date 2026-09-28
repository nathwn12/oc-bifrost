# INSTALL — agent-first

**You are the agent. This page is written for you to execute.** The human says *"set up oc-bifrost for my `<plugin>`"* — you do the rest and report.

Do not hand the human a wall of steps. Do them, then report: what you changed, what you verified, what you could not.

---

## 0. Preflight (always)

1. Confirm the host is OpenCode V2: `opencode --version` → expect `2.x`.
2. Locate the config in use: `opencode debug paths` → read the `config` line. **Never assume `~/.config/opencode`** — respect the reported path. If `OPENCODE_CONFIG_DIR` is set, that is the config root.
3. Confirm you may write there. The global config directory is often owned by a stricter writer agent. If your write is denied, **hand the edit to that writer; never reword the path or route it through a shell**.

## 1. Decide the route

| Route | Use when | Trade-off |
|---|---|---|
| **A — package** (recommended) | `@nathwn12/oc-bifrost` is published | one config line |
| **B — local** | unpublished, or pinned to a checkout | needs a directory entry (host rejects file paths) |

Ask nothing. Pick A if the package resolves (`npm view @nathwn12/oc-bifrost version`); otherwise B.

## 2. Route A — package

Add to the config's `plugins` array:

```jsonc
{
  "plugins": [
    {
      "package": "@nathwn12/oc-bifrost",
      "options": {
        "plugins": ["<specifier for each legacy plugin>"],
        "strict": false,
        "verbose": true
      }
    }
  ]
}
```

Then skip to step 4.

## 3. Route B — local

```pwsh
# 1. build the bridge
cd <oc-bifrost checkout>; npm install; npm run build

# 2. a configured local entry MUST be a directory (a file path is rejected)
#    <config>/plugins/oc-bifrost/index.js
#    <config>/plugins/oc-bifrost/package.json
```

`index.js`:

```js
export { default } from "<absolute path to oc-bifrost>/dist/index.js"
```

`package.json`:

```json
{ "type": "module", "exports": { ".": "./index.js" } }
```

Config entry:

```jsonc
{
  "plugins": [
    {
      "package": "<config>/plugins/oc-bifrost",
      "options": { "plugins": ["<specifier for each legacy plugin>"] }
    }
  ]
}
```

## 4. Park the legacy plugins correctly

**A V1 plugin left in `.opencode/plugins/` is hard-rejected by V2 before the bridge can see it:**

```
Plugin must export a default definition with an id and an effect or setup function
```

Move it out of discovery — `.opencode/legacy/<name>.ts` is the convention — and reference it from `options.plugins`:

- relative specifiers resolve against the **session directory**
- absolute paths and npm names work too

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

## 5. Verify (do not skip — this is the deliverable)

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

## 6. Rollback (always know it)

Remove the bridge entry from `plugins` and restart. Nothing else was modified: the bridge owns no files outside its own directory and writes nothing to the host's state.

## 7. Report to the human

State: route used · config path touched · legacy plugin path · hooks mounted and their levels · the side effect you verified · anything `unsupported` the plugin depends on. If a hook the plugin needs is `unsupported`, say so plainly and do not claim success.

---

## Guardrails for the agent

- One writer per config file. If denied, delegate — never retry by another name.
- Never leave a V1 file in a discovered plugin directory.
- Never edit the human's env permanently to make a test pass. Prefer a per-process scope.
- If the plugin needs an `unsupported` hook, report it as a **port candidate**, not a bridged success.
