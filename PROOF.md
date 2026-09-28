# PROOF — it works, once, in isolation

Verified end-to-end on an **isolated OpenCode V2 host**. Nothing in the operator's global OpenCode directory was read, written, or reconfigured.

| Field | Value |
|---|---|
| Date | 2026-09-28 |
| Host | OpenCode **2.0.18** (Windows, `opencode.exe`) |
| oc-bifrost | 0.1.0 (`main @ 9561606`) |
| Node | 24.21.0 |

## Isolation method

OpenCode exposes a real config-directory override (`packages/cli/src/index.ts:117`):

```pwsh
$env:OPENCODE_CONFIG_DIR = "<sandbox>\config"
$env:OPENCODE_DISABLE_PROJECT_CONFIG = "1"
```

Confirmed in-product:

```
$ opencode debug paths
config     C:\Users\nathan\AppData\Local\Temp\opencode\bifrost-sandbox\config
```

The global harness (`~/.config/opencode`) was never loaded. The override was set **per process only** — never persisted to User or Machine environment.

## Proof 1 — a V1 hook's mutation reaches real execution

A V1 plugin registered `tool.execute.before` and appended a marker to every shell command. The host's own log shows the **rewritten** command being spawned:

```
message="spawning process" command="pwsh.EXE"
  args=["-NoLogo","-NoProfile","-NonInteractive","-Command","echo hello && echo BIFROST_BRIDGED"]
```

The marker the agent never wrote was appended by the bridged V1 hook and appears in the command's real output:

```
BIFROST_BRIDGED
```

This proves the load-bearing write-back: V2 reads `event.input` and `event.tool` back after `execute.before` (`packages/core/src/tool.ts:271-280`), so an in-place mutation executed.

## Proof 2 — a real npm V1 plugin works through the bridge

Plugin: **`opencode-claude-hooks@0.1.0`** (unmodified, installed from npm). Its shape is textbook V1:

```js
var ClaudeCodeHooksPlugin = async (input) => ({
  event: async ({ event }) => { ... },
  "tool.execute.before": async (hookInput, output) => { ... },
  "tool.execute.after":  async (hookInput, output) => { ... },
  "permission.ask":      async (hookInput, output) => { ... },
})
export { ClaudeCodeHooksPlugin }
```

Configured in the sandbox only, via `.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [
  { "type": "command", "command": "node -e \"require('fs').appendFileSync('CLAUDE_HOOK_FIRED.txt','PreToolUse from real npm V1 plugin\\n')\"" }
] } ] } }
```

Result — the side effect the plugin's own V1 `tool.execute.before` hook produced:

```
marker file: PRESENT
  PreToolUse from real npm V1 plugin
```

Host log, same run:

```
msg="loading plugin" id=.../plugins/oc-bifrost entrypoint=file:///.../oc-bifrost/index.js
```

No `LoadError`. The V1 factory was discovered (`ClaudeCodeHooksPlugin`), called with the facaded `PluginInput`, and its hooks registered on the V2 runtime.

## Proof 3 — a real plugin fetched from GitHub loads

`rtk-ai/rtk` `hooks/opencode/rtk.ts` (verbatim from `develop`) — a V1 named export using `tool.execute.before` and the Bun `$` shell — was discovered and mounted by the bridge. It self-disables on this host because its own preflight (`which rtk`) does not pass on Windows and no `rtk` binary was installed. That is the plugin's behaviour, not the bridge's: discovery, context, and `$` facade all worked.

## Defect found by this test (now documented)

A configured local plugin entry **must be a directory** in the tested host, not a file:

```
level=WARN message="configured plugin path must be a directory" target=.../dist/index.js
```

The sandbox entry is therefore a directory (`plugins/oc-bifrost/` with `index.js` + `package.json`). See the README install section.

## Reproduce

```pwsh
# 1. directory entry
#    <sandbox>/plugins/oc-bifrost/index.js  ->  export { default } from "<repo>/dist/index.js"
#    <sandbox>/plugins/oc-bifrost/package.json  { "type": "module", "exports": { ".": "./index.js" } }

# 2. config, in the sandbox only
#    OPENCODE_CONFIG_DIR=<sandbox>/config
#    opencode.jsonc -> plugins: [{ package: "<sandbox>/plugins/oc-bifrost",
#                                  options: { plugins: [ "<abs path to a V1 plugin>" ] } }]

$env:OPENCODE_CONFIG_DIR = "<sandbox>\config"
$env:OPENCODE_DISABLE_PROJECT_CONFIG = "1"
opencode run --auto --standalone --print-logs "Run this exact shell command: echo hello"
```

## Cleanup

- Sandbox lived entirely under the OS temp directory and was deleted after testing.
- `OPENCODE_CONFIG_DIR` / `OPENCODE_DISABLE_PROJECT_CONFIG` verified **unset** at User and Machine scope afterwards.
- `~/.config/opencode` was never a target of any write (verified by directory listing before/after).

## Honest scope of this proof

- Proven: discovery, V1 context facade, `$` shell, `tool.execute.before` write-back to execution, `tool.execute.after`, and refusal reporting.
- Not proven here: the `partial` and `unsupported` rows of the matrix under load, and behaviour on Linux/macOS.
- One host, one version (2.0.18). Re-run on each OpenCode release before trusting it there.
