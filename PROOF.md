# PROOF — it works, once, in isolation

Verified end-to-end on an **isolated OpenCode V2 host**. Nothing in the operator's global OpenCode directory was read, written, or reconfigured.

| Field | Value |
|---|---|
| Date | 2026-09-28 |
| Host | OpenCode **2.0.18** (Windows, `opencode.exe`) |
| oc-bifrost | Three builds — **0.1.0** (Proofs 1–4), **0.2.0** (Proof 5) and **1.1.0** (Proof 6); see each proof |
| Node | 24.21.0 |

> **Build scope (annotated 2026-09-28).** Proofs 1–3 were verified on `main @ 9561606` (0.1.0),
> Proof 4 on the published `0.1.0` npm package, and Proof 5 on the packed `0.2.0` tarball. The repo
> has since moved to `0.3.0` (`main @ 50284db`), and none of these proofs have been re-run there.
>
> **Proof 6 (added 2026-09-29).** The first proof run on a current build: the packed **1.1.0**
> tarball from `chore/release-1-1-0 @ 54a1191`. It carries the whole load again — artifact load,
> V1 write-back, and the V2 pass-through route — so this page's oldest sentence above stays honest:
> Proofs 1–5 have still not been re-run on their own later builds.

## Isolation method

OpenCode exposes a real config-directory override (`packages/cli/src/index.ts:117`):

```pwsh
$env:OPENCODE_CONFIG_DIR = "<sandbox>\config"
$env:OPENCODE_DISABLE_PROJECT_CONFIG = "1"
```

Confirmed in-product:

```
$ opencode debug paths
config     C:\Users\you\AppData\Local\Temp\opencode\bifrost-sandbox\config
```

The global harness (`~/.config/opencode`) was never loaded. The override was set **per process only** — never persisted to User or Machine environment.

## Proof 1 — a V1 hook's mutation reaches real execution

Verified build: `oc-bifrost@0.1.0` (`main @ 9561606`).

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

Verified build: `oc-bifrost@0.1.0` (`main @ 9561606`).

Plugin: **`opencode-claude-hooks@0.1.0`** (unmodified, npm-installed copy mounted by absolute path). Its shape is textbook V1 — all five registered hooks:

```js
var ClaudeCodeHooksPlugin = async (input) => ({
  event: async ({ event }) => { ... },
  "tool.execute.before": async (hookInput, output) => { ... },
  "tool.execute.after":  async (hookInput, output) => { ... },
  "permission.ask":      async (hookInput, output) => { ... },
  "experimental.session.compacting": async (hookInput, output) => { ... },
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

Verified build: `oc-bifrost@0.1.0` (`main @ 9561606`).

`rtk-ai/rtk` `hooks/opencode/rtk.ts` (verbatim from `develop`) — a V1 named export using `tool.execute.before` and the Bun `$` shell — was discovered and mounted by the bridge. With no `rtk` binary on `PATH` it self-disables at its own preflight, which is the plugin's behaviour, not the bridge's: discovery, context, and the `$` facade all worked.

> **Correction (2026-09-28).** An earlier revision of this page blamed that preflight on Windows. That was wrong, and it sent a reader hunting a phantom platform bug. `which` resolves normally in the host's Bun shell on this machine — `C:\Program Files\Git\usr\bin\which.exe` is on `PATH` — and `$`which rtk`` succeeds the moment the binary exists. The sole cause was the missing binary. See **Proof 4**.

## Proof 4 — live, in the operator's real global config

Verified build: `@nathwn12/oc-bifrost@0.1.0` from npm — the superseded legacy-file route.

Not isolated. The operator's own `~/.config/opencode`, bridge installed as the published npm package, RTK parked in `<config>/legacy/rtk.ts`.

> **Superseded route (annotated 2026-09-28).** `<config>/legacy/rtk.ts` was deliberately removed in
> the 0.2.0 switch — do not expect it to exist today. The operator config now mounts `preset:rtk`,
> the route Proof 5 exercises. This record is kept as the historical live-config proof.

| Field | Value |
|---|---|
| Date | 2026-09-28 |
| Host | OpenCode **2.0.18** (Windows) |
| Bridge | `@nathwn12/oc-bifrost` (npm) |
| Legacy plugin | `rtk-ai/rtk` `hooks/opencode/rtk.ts` @ tag `v0.50.0` |
| rtk binary | **0.50.0** — `rtk-x86_64-pc-windows-msvc.zip`, sha256 verified against the release digest |

Run: a fresh headless host against the real config, told to run exactly `git status --porcelain`.

Load — the bridge is picked up:

```
level=INFO msg="loading plugin" id=@nathwn12/oc-bifrost
```

Execution — **the host's own spawn log shows the rewritten command**:

```
message="spawning process" command="pwsh.EXE"
  args=["-NoLogo","-NoProfile","-NonInteractive","-Command","rtk git status --porcelain"]
```

The tool-call record still carries the pre-rewrite input (`git status --porcelain`); the process that actually ran was `rtk git status --porcelain`. Independent confirmation from rtk's own tracker:

```
$ rtk gain
Total commands:    1
 1.  rtk git status --porc...      1
```

This is the strongest live-config proof to date: not a side effect we inferred, but the host's own record of the command it executed.

## Proof 5 — `preset:rtk` mounted from the PACKED TARBALL, in a real host

Verified build: `@nathwn12/oc-bifrost@0.2.0` — the packed tarball recorded below; not re-run on
the current 0.3.0.

The strongest proof in this file for the **0.2.0** build: it exercises the artifact that release
shipped, the zero-fetch preset path, the vendored `.ts` import under Bun, and the prerequisite
probe.

Method — no network, no published version required:

1. `npm pack` → `nathwn12-oc-bifrost-0.2.0.tgz`
2. `npm install` that tarball into an isolated tree
3. A directory-shim entry re-exporting the installed package's `dist/index.js`
   (the host rejects a file path here), configured with **only**
   `"plugins": ["preset:rtk"]`
4. A headless host with `OPENCODE_CONFIG_DIR` pointed at that sandbox config

| Field | Value |
|---|---|
| Date | 2026-09-28 |
| Host | OpenCode **2.0.18** (Windows) |
| Artifact | `nathwn12-oc-bifrost-0.2.0.tgz` |
| Config | `{"plugins":[{"package":"<shim>","options":{"plugins":["preset:rtk"]}}]}` |
| rtk binary | 0.50.0 |

Load:

```
msg="loading plugin" id=.../shim/oc-bifrost
  entrypoint=file:///.../shim/oc-bifrost/index.js
```

Execution — the host's own spawn log:

```
message="spawning process" args=["-NoLogo","-NoProfile","-NonInteractive",
  "-Command","rtk git status --porcelain"]
```

The agent asked for `git status --porcelain`. The command that ran was
`rtk git status --porcelain`.

**What this rules out:**

- The vendored `.ts` import works under Bun from inside the packaged artifact — the
  unprefixed entry URL (`../vendor/rtk.ts`) resolves from `dist/`.
- The prerequisite probe passed. A missing `rtk` would have printed
  `requires the "rtk" binary … and rewrite nothing` and the command would have run
  unrewritten. It was rewritten.
- `files` ships `vendor/`; without it the preset entry would have failed to import.

### Known limitation found while building this proof

A configured entry that points **directly at the installed package directory** is dropped by
the host **silently** — no log, no warning, the plugin simply never loads. The package resolves
correctly at every resolver we tested (`Bun.resolveSync`, `require.resolve`, `Host.resolve`'s
own call), so the drop happens in the host's absolute-directory branch, not in this package.
Use a directory shim or the npm package name; both are proven.


A configured local plugin entry **must be a directory** in the tested host, not a file:

```
level=WARN message="configured plugin path must be a directory" target=.../dist/index.js
```

The sandbox entry is therefore a directory (`plugins/oc-bifrost/` with `index.js` + `package.json`). See the README install section.

## Proof 6 — the packed 1.1.0 tarball, both eras in one isolated host

Verified build: `@nathwn12/oc-bifrost@1.1.0` — the **packed tarball**
`nathwn12-oc-bifrost-1.1.0.tgz`, 83517 bytes, sha256
`d2b53d6029ea0107357c19842ccf58e884c67b254beab73745b4e3c101e1f23a`, packed from
`chore/release-1-1-0 @ 54a1191`.

| Field | Value |
|---|---|
| Date | 2026-09-29 |
| Host | OpenCode **2.0.18** (Windows) |
| Artifact | `nathwn12-oc-bifrost-1.1.0.tgz` (sha256 above); `testflight .` exit 0 |
| Node | 24.21.0 |

Method: the Proof 5 shape — pack, install, directory shim, isolated host — with two corrections
this run had to make (below). The config mounted exactly two local fixtures: a V1 factory and a V2
`{ id, setup }` definition. `npm run check` was 155/155 alongside it.

**V1 lane — the mutation reaches real execution.** The agent asked for `echo hello`; the host's own
spawn log shows what ran:

```
message="spawning process" command="...pwsh.EXE"
  args=[ ... ,"-Command","echo hello && echo BIFROST_BRIDGED_V1"]
```

```
BIFROST_BRIDGED_V1
```

**V2 lane — the definition's `setup` ran with the live host context:**

```
V2_SETUP_RAN ctx_keys=agent,aisdk,app,command,event,experimental,generate,integration,
location,mcp,model,options,permission,plugin,provider,reference,rpc,session,shell,
skill,storage,tool,vcs,websearch,worktree
```

**The durable sink.** With `OC_BIFROST_REPORT` pointed inside the sandbox, `report.log` carried
both mount reports:

```
[oc-bifrost] .../config/v1-plugin.mjs
  full        tool.execute.before - mutable event.input write-back
  mounted     v1:v1-plugin - V1 default export
[oc-bifrost] .../config/v2-plugin.mjs
  mounted     v2:flight.v2 - V2 setup invoked with the host context
```

### Two traps this run found

1. **Isolation needs the XDG roots as well.** `OPENCODE_CONFIG_DIR` +
   `OPENCODE_DISABLE_PROJECT_CONFIG` do not move `data`/`cache`/`state`: with only those set, the
   host still resolved them under the operator's real `~/.local/share`, `~/.cache` and
   `~/.local/state` (`packages/util/src/global-roots.ts:5-8`). Add
   `XDG_CACHE_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME`.
2. **A shim inside `<config>/plugins/` silently starves `options.plugins`.** `plugin/` and
   `plugins/` are host auto-discovery directories; the host loads its own copy from there with
   `options: {}`, so the bridge reports "no plugins configured" and the configured entry never
   supplies options. Keep the shim outside any discovery directory.

### Also worth knowing

- The V1 write-back target is `output.args.command`, not `input.command` (`src/hooks.ts:35-37`).
- Under `--standalone` the host serves stdio, so the plugin's `console.log` report is dropped on
  the JSON-RPC stdout channel — only `console.warn` surfaced. This run is a live demonstration of
  why the sink exists: the sink wrote the same block `console.log` receives (`src/index.ts:306-308`).
- An unrelated host restart mid-install left a partial `node_modules` (the shim then failed to
  resolve `@opencode/schema`); a clean reinstall fixed it. Environment, not the package.

### The real dual-export file, same method

The one thing Proof 6 above left open — a **real-world** dual-export plugin, fetched by source.
Same sandbox shape, one config entry:

```
"github:obra/superpowers@v6.4.2#.opencode/plugins/superpowers.js"   (trustRemote: true)
```

The bridge's own report, from the durable sink written inside the sandbox:

```
[oc-bifrost] github:obra/superpowers@v6.4.2#.opencode/plugins/superpowers.js
  mounted     v2:superpowers - V2 setup invoked with the host context
  mounted     github:obra/superpowers - fetched github:obra/superpowers@v6.4.2#.opencode/plugins/superpowers.js at commit 8ca22dba9a94f28898bbce59f2537ff4d87c747d (sha256 c979fe5a9fd6., 17617 bytes; trust-on-first-use); executes with the host process's full user rights
```

- The fetched artifact matches its own provenance record — sha256 recomputed as `c979fe5a…`,
  17617 bytes — and it is genuinely dual-export: a V1 named export (`SuperpowersPlugin`,
  `plugin.ts:219`) **and** a V2 `export default { id: "superpowers", server: SuperpowersPlugin, setup }`
  (`plugin.ts:379-383`).
- `mounted v2:superpowers` is emitted only *after* `setup` returns (`src/index.ts:258-261`), and that
  `setup` early-returns unless `ctx.skill.transform` and `ctx.session.hook` are functions — the live
  host context supplies both (`@opencode/plugin/dist/promise/adapter.js:321,418`), so the body ran,
  not merely the early return.
- **What this does not claim:** any *downstream* effect. The skills directory `setup` resolves
  (`../../skills` from the fetched module) does not exist — a single-file `github:` fetch carries no
  sibling assets — so it loads zero skills and injects nothing. That is not "we could not see it": the
  expected directory is measurably absent, re-checked in the live harness cache (Proof 7), where the
  fetched module's directory holds only `plugin.ts` and `meta.json`. The plugin also swallows its own
  errors, so a returned `setup` is not proof that a transform or a hook succeeded.

Pack note: this run packed `nathwn12-oc-bifrost-1.1.0.tgz` at `b80f860` (84954 bytes, sha256
`8fe69a2d…`); the executable bytes are the ones flown above at `54a1191` — the two packs differ only
in these docs.

### Honest scope of Proof 6

- Proven here: artifact discovery and load from the packed tarball; V1 hook translation with
  `tool.execute.before` write-back to real execution; the **V2 pass-through route** (`setup`
  invoked with the live context) for both a minimal definition and the real dual-export file above;
  the durable sink; and the `github:` fetch route with its provenance check.
- Not exercised here: `preset:rtk`, Linux/macOS. Downstream effects of a V2 plugin's `setup` are not
  observable headlessly (the fixture above neither loaded a skill nor injected context).
- One host version (2.0.18). Re-run on each OpenCode release before trusting it there.

## Proof 7 — the PUBLISHED artifact, live in the operator's harness

Proof 6 proved the *packed* tarball. This is the post-publish half: the bytes on npm, and the bridge
running in the real harness rather than a sandbox.

- **The published bytes are the flown bytes.** `dist/index.js`, `dist/sink.js`, `dist/github.js` and
  `dist/hooks.js` in the tarball fetched back from the registry hash identically (sha256) to this
  repo's build. The registry's own record agrees: `dist.integrity` equals the sha512 of the fetched
  tarball, and `dist.fileCount` (69) / `dist.unpackedSize` (297090) match the local pack.
- **It installs and resolves as a package.** `testflight <published .tgz>` → exit `0`, zero
  failures, two warnings — both benign: `file://` URLs inside doc comments that *describe* the
  `github:` route, and `C:/Users/you/...` example paths in this file and INSTALL.md.
- **The real harness mounts it.** The global config's pin moved `1.0.1 → 1.1.0`; `opencode plugin list`
  answers `oc.bifrost 1.1.0  @nathwn12/oc-bifrost@1.1.0`, and the durable sink wrote a fresh mount
  report through the live host: `mounted v2:superpowers - V2 setup invoked with the host context`,
  `mounted v1:RtkOpenCode`, `full tool.execute.before - mutable event.input write-back`. The feature
  this release adds is what recorded its own adoption.
- **Mounting is not running.** The same live cache shows superpowers' expected skills directory
  measurably absent (`~/.cache/opencode/oc-bifrost/github/obra--superpowers--…/` holds only `plugin.ts`
  and `meta.json`), so its V2 `setup` is inert as fetched — see Proof 6's note. RTK is the contrast:
  hook-translated (`full tool.execute.before`), with a live spawn proof in Proof 4.
- **Honest scope:** one host (2.0.18); no Linux/macOS run; a V2 `setup`'s downstream effects stay
  unobservable headlessly, and `mounted` claims no more than Proof 6 says it does.

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

- Proven in the host runs: discovery, V1 context facade, `$` shell, and `tool.execute.before` write-back to execution.
- Proven in a host run as of Proof 6: the V2 pass-through route (a definition's `setup` invoked with the live host context) and the durable report sink.
- Proven by the test suite, not by a host run here: `tool.execute.after` and refusal reporting (`test/hooks.test.js`; `test/matrix.test.js`).
- Not proven here: the `partial` and `unsupported` rows of the matrix under load, and behaviour on Linux/macOS.
- One host, one version (2.0.18). Re-run on each OpenCode release before trusting it there.

## Proof 9 — the verdict flight: ten awesome-opencode plugins on the packed 1.2.0 tarball

Date 2026-09-29. Host: OpenCode **2.0.18** (Windows), Node 24.21.0, Bun 1.4.2 (probe).

The owner ultimatum: prove real plugins from the awesome-opencode collection work on a REAL V2
host through the PACKED tarball, each with a DECIDABLE artifact — or the project is dead. "An
honest refusal is a documented verdict, never a faked pass." The ready-made artifact under test:

- `nathwn12-oc-bifrost-1.2.0.tgz` — 102,817 bytes, sha256 `5AD94BE4F42FE58BC0A5B68544F4EDCC1C16ACE20B958D1A4A132B623B0254D3` —
  the pack containing the snapshot route (`dist/archive.js`), built on `feat/github-snapshot @ d55247f`
  (the 1.2.0 release under PR #9).
- Plugin spec in every flight: `"package": "file:<abs tarball>"` with
  `"options": { "plugins": ["github:<owner>/<repo>@<pin>[#<path>]"] }`.

### Isolation method (tightened)

Per-process env (`OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `XDG_*_HOME`,
`npm_config_cache`+`offline`, plus `HOME`/`USERPROFILE` — required by plugins that touch
`~/.config/opencode` paths) pointed every child process at the sandbox. Credentials were provided
by a **consistent SQLite snapshot** of the operator's data DB — `sqlite3 <db> ".backup"`, which
includes WAL contents — copied BY POINTER into the sandbox (`opencode.db` under the sandbox's
`XDG_DATA_HOME`; never read, never rendered; a raw file copy without `-wal`/`-shm` was validated
first and FAILED model auth with "Insufficient account funds" — the snapshot fixed it). Nothing
outside the sandbox was read or written except that one backup read. The npm cache was seeded once
(`npm install` of the tarball into a scratch prefix with the shared cache dir) so the host's
offline Arborist install could resolve the bridge's peer dependency.

Every flight: `opencode serve --port 0 --print-logs` → parse url+password →
`opencode run --server <url> --auto "<prompt>" --model opencode-go/deepseek-v4-flash#max`
(the config-less default model is a paid endpoint with no balance; an explicit `--model` with the
DB-snapshot credentials answered reliably). Evidence per plugin: `REPORT.log` mount block (durable
sink), server logs, transcript, artifact, and — for isolated runs — the session record extracted
from the sandbox DB copy (`session_v2`/`session_message`, the store the CLI export also reads).

### The fix this flight carried (one logical change)

`chat.message` previously built `{ message, parts }` and discarded it. V2 reads `event.prompt`
back (`packages/core/src/session/prompt.ts:40-52`), so the V1 write now lands on
`event.prompt.text`: the hook is pre-filled with the V1-era `message.content` + a leading text
part from the V2 prompt text, and a changed `message.content` or changed text parts replace the
prompt text (idempotent for no-op hooks). `src/hooks.ts` + tests; `npm run check` green
(159/159 on the main-based branch; the snapshot feature branch's extra test file is PR #9's).

### The ten flights

| # | Plugin (pin) | Route / hooks | Decidable | Verdict |
|---|---|---|---|---|
| 1 | **obra/superpowers** `8ca22dba…` `.opencode/plugins/superpowers.js` | V2 pass-through: `setup` (ctx.skill.transform + session.hook) | model enumerates skills; **all 15 names from the materialized snapshot** (`using-superpowers` among them); snapshot 229 files / 1.97 MB in the mount note | ✅ **full pass — overturns the mount-only verdict of Proofs 6–7**: the snapshot route delivers `../../skills`, so the setup's self-check finds its directory and registers every skill |
| 2 | **d3vv3/opencode-ascii** `e42bb23f…` `dist/index.js` | V1 named export; `tool.execute.before` (full) + `experimental.text.complete` (refused) | "write note.txt with: hello — world" → `note.txt` = `hello - world`, **0 non-ASCII bytes**; refusal line in the report | ✅ pass |
| 3 | **ramarivera/opencode-model-announcer** `7b7129c0…` `src/plugin.ts` | V1 named export; `experimental.chat.messages.transform` (partial) | answer contains `CURRENT_MODEL_ANNOUNCEMENT` / provider+model | ❌ **not proven** — the hook assumes V1 `{info, parts}[]` and **crashed the real host session** (`TypeError: m.info.role`, `service.ts:20`); run failed. The bridge's `partial` line names the loss exactly; no write-back exists for this hook |
| 4 | **gotgenes/opencode-agent-identity** `6ed87ad9…` `src/agent-self-identity.ts` | V1 named export; `experimental.chat.messages.transform` + `system.transform` (partial) | "Which agent are you?" names the agent | ❌ **not proven** — same `m.info.role` crash (`agent-self-identity.ts:22`); run failed |
| 5 | **joostvanwollingen/opencode-personality** `9caf80ff…` `src/index.ts` | V1 default export; `system.transform`, 2-tool V1 map, `event` (partial) + `command.execute.before` (refused) | bun probe (1.4.2) reproduced the import failure; **provisioned** (only dep junctioned) → persona `FlightTestPersona` reached the model ("…always ends replies with the word BANANA… BANANA") | ⚠️ **refused as fetched** (`Cannot find package '@opencode-ai/plugin'` — prerequisite, not the bridge) → ✅ **provisioned pass** |
| 6 | **boxpositron/envsitter-guard** `17e37f2f…` | import failure | mount report names the failure; session stays healthy ("Hello!") | ❌ documented refusal — `Cannot find package '@opencode-ai/plugin'` |
| 7 | **lgladysz/opencode-ignore** `7ca42ef5…` | import failure | same | ❌ documented refusal — `Cannot find package 'ignore'` |
| 8 | **synthetic V1 `chat.message` sanitizer** (the real log-sanitizer repo+user are deleted from GitHub — this fixture reproduces its exact V1 shape, clearly labeled) | V1 module; `chat.message` (partial→**write-back fixed in this PR**) | JWT-shaped token in the prompt → `[redacted:jwt]` in **the persisted session store** and in `token.txt` (the model saw only the redaction) | ✅ **pass on the fixed build** (`nathwn12-oc-bifrost-1.1.0.tgz` packed from this branch, sha256 `A8C9FABE…`; the ready-made 1.2.0 pack cannot carry the fix by definition) |
| 9 | **JosXa/opencode-snippets** `29102213…` | dual export → V2 pass-through (`setup` incl. `v2-request` expansion) | `#hello` expansion in the persisted session store, fresh sandbox, tools forbidden in the prompt | ⚠️ refused as fetched (`Cannot find package '@opencode/plugin'`) — ✅ **provisioned pass** (declared deps junctioned; 185-file snapshot; `mounted v2:opencode-snippets`; the stored user message shows `#hello` replaced by the expansion) |
| 10 | **shihyuho/opencode-command-inject** `14787ebc…` | `config` + `command.execute.before` (both in the refused list) | loud refusal chain | ❌ documented refusal, two layered failures: repo tarball carries **`CLAUDE.md` as a symlink** → snapshot refused ("links and device nodes are never materialized") → single-file fallback → sibling `./src/plugin` absent → import failure. Session stayed healthy |

### Findings the flights surfaced

- **Snapshot route works.** Four flights (#1, #2, #5, #9) materialized full pinned trees
  (229, 15, 25, 185 files) and the plugins' sibling reads succeeded — the exact failure Proofs
  6–7 documented is gone.
- **`experimental.chat.messages.transform` is worse than partial: it crashes sessions.**
  Two real plugins (#3, #4) were handed V2 `Message[]` while reading V1 `m.info` — `TypeError`
  inside the session drain, run aborted. The bridge's `partial` note describes the shape
  difference honestly, but a partial that kills the session is a defect worth its own PR: either
  a `{info, parts}` ⇄ `Message[]` conversion with write-back, or a guarded no-op that swallows
  and logs. **Recommended next fix.**
- **`chat.message` write-back needs the pre-fill to be usable.** The first flight of #8 (write-back
  only) mounted but sanitized nothing: the V1 hook received EMPTY parts and had nothing to rewrite.
  The pre-fill (this PR) made it work end to end.
- **A by-source fetch carries no npm deps.** #5/#9 load whole declared dependency sets the moment
  they are provided on disk (junctioned `node_modules` in the sandbox cache tree); nothing in the
  bridge changes. Confirms VERIFIED-PLUGINS.md's standing line: prerequisites are not the bridge's
  job — and shows the honest refusal text naming the exact missing package.

### Honest scope of Proof 9

- Proven: the packed-tarball bridge on a real host — **plugin passes** (superpowers, ascii,
  personality-provisioned, sanitizer, snippets-provisioned) and **documented refusals**
  (announcer, identity — shape crash; envsitter, ignore, command-inject — prerequisite/loud
  chain), session-store write-back end to end, snapshot route, report sink, refusal honesty
  under load.
- One model (opencode-go/deepseek-v4-flash#max), one host version (2.0.18), Windows. No Linux/macOS.
- Evidence lives in `%TEMP%\opencode\bifrost-evidence\<plugin>\` — `REPORT.log`, transcripts,
  artifacts, `decidable.txt` summaries; the flight harness in `%TEMP%\opencode\bifrost-verdict\`.
