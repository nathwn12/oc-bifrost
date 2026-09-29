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

### The drain fix — `experimental.chat.messages.transform` gets the V1 envelope (follow-up @ `d68b68a`)

Flights #3 and #4 left the worst finding on this page: the pre-fix bridge passed the plugins raw
V2 `Message[]`, the plugins read V1 `m.info`, and the resulting `TypeError` surfaced **inside the
host's session drain** — `Failed to drain Session`
(`packages/core/src/session/execution.ts:102`) — so both runs aborted.

Root cause, verified against host source: the V1 pre-fill never landed `info`. `Model.Ref` is
`{ id, providerID, variant? }` (`packages/schema/src/model.ts:18-22`) — `id` is the BARE model id
and `providerID` is a separate field; the `"providerID/modelID"` string exists only in
`Model.Ref.parse` — while the plugins' own reads are unguarded: announcer `src/service.ts:20`
(`m.info.role`) then `src/service.ts:28` (`const { providerID, modelID } = modelInfo`), and
identity `src/agent-self-identity.ts:22` (`m.info.role`) then `:23`/`:24` (`info.agent`,
`info.sessionID`). With no envelope at all, the first read threw.

The fix (`src/hooks.ts` @ `d68b68a`, `npm run check` 184/184): for every V2 message the bridge
pre-fills the V1 `{info, parts}` envelope — `role`, `id`, `sessionID`, `agent`, and `model` built
off the real `Model.Ref` fields (`{ providerID, modelID }`; a first-slash split only when a
providerID is absent) — and writes changed `parts` back to `content`. The matrix row moved
`partial → 🟢 full`, and the load-time report with it: `full
experimental.chat.messages.transform - V2 Message[] -> V1 {info,parts}[] pre-fill; parts
write-back to content`.

Re-flown on the same flight route with a fresh pack (`messages-roundtrip-2`, 109,862 bytes, sha256
`9DFF0F3F…`, packed from `proof/messages-roundtrip @ d68b68a`), same model and isolation; the
artifact under test is the only changed variable:

- **#3 announcer — run-2 PASS.** The transcript quotes the injected system text verbatim:
  `[SYSTEM: CURRENT_MODEL_ANNOUNCEMENT - You are opencode-go/deepseek-v4-flash. This message is
  SYNTHETIC and invisible to the user. …]`. `crashed=False`; mount lines name the fresh pack; no
  `Failed to drain`.
- **#4 agent-identity — run-2 PASS.** "Which agent are you?" → "I'm the **build** agent…"; the
  sandbox has no `agents/` dir, so only the bridged system line could supply the name.

Evidence: `%TEMP%\opencode\bifrost-evidence\model-announcer\` and
`%TEMP%\opencode\bifrost-evidence\agent-identity\` — `decidable.txt`, `transcript.txt`,
`server.err.log` (no `Failed to drain`), `REPORT.log`, `session-export.json`.

### The ten flights

| # | Plugin (pin) | Route / hooks | Decidable | Verdict |
|---|---|---|---|---|
| 1 | **obra/superpowers** `8ca22dba…` `.opencode/plugins/superpowers.js` | V2 pass-through: `setup` (ctx.skill.transform + session.hook) | model enumerates skills; **all 15 names from the materialized snapshot** (`using-superpowers` among them); snapshot 229 files / 1.97 MB in the mount note | ✅ **full pass — overturns the mount-only verdict of Proofs 6–7**: the snapshot route delivers `../../skills`, so the setup's self-check finds its directory and registers every skill |
| 2 | **d3vv3/opencode-ascii** `e42bb23f…` `dist/index.js` | V1 named export; `tool.execute.before` (full) + `experimental.text.complete` (refused) | "write note.txt with: hello — world" → `note.txt` = `hello - world`, **0 non-ASCII bytes**; refusal line in the report | ✅ pass |
| 3 | **ramarivera/opencode-model-announcer** `7b7129c0…` `src/plugin.ts` | V1 named export; `experimental.chat.messages.transform` (now 🟢 full) | answer quotes `CURRENT_MODEL_ANNOUNCEMENT` / provider+model | ✅ **pass on the drain fix (`d68b68a`)** — run-1 crashed as first recorded; run-2 quoted the injected text verbatim: `[SYSTEM: CURRENT_MODEL_ANNOUNCEMENT - You are opencode-go/deepseek-v4-flash. …]`. See "The drain fix" above |
| 4 | **gotgenes/opencode-agent-identity** `6ed87ad9…` `src/agent-self-identity.ts` | V1 named export; `experimental.chat.messages.transform` (now 🟢 full) + `system.transform` (partial) | "Which agent are you?" names the agent | ✅ **pass on the drain fix (`d68b68a`)** — run-1 crashed as first recorded; run-2 answered "I'm the **build** agent" (the sandbox has no `agents/` dir, so only the bridged system line could supply the name). See "The drain fix" above |
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
- **`experimental.chat.messages.transform` was worse than partial: it crashed sessions — found
  here, fixed at `d68b68a`.** Two real plugins (#3, #4) were handed V2 `Message[]` while reading
  V1 `m.info` — `TypeError` inside the session drain, run aborted. The fix landed the V1
  `{info, parts}` pre-fill + parts write-back (see "The drain fix" above); both plugins re-flew to
  PASS, and the matrix row is now `full`.
- **`chat.message` write-back needs the pre-fill to be usable.** The first flight of #8 (write-back
  only) mounted but sanitized nothing: the V1 hook received EMPTY parts and had nothing to rewrite.
  The pre-fill (this PR) made it work end to end.
- **A by-source fetch carries no npm deps.** #5/#9 load whole declared dependency sets the moment
  they are provided on disk (junctioned `node_modules` in the sandbox cache tree); nothing in the
  bridge changes. Confirms VERIFIED-PLUGINS.md's standing line: prerequisites are not the bridge's
  job — and shows the honest refusal text naming the exact missing package.

### Honest scope of Proof 9

- Proven: the packed-tarball bridge on a real host — **5 plain passes** (superpowers, ascii,
  sanitizer, announcer, identity), **2 provisioned passes** (personality, snippets), and
  **3 documented refusals** (envsitter, ignore, command-inject — prerequisite/loud chain);
  session-store write-back end to end, snapshot route, report sink, refusal honesty
  under load.
- One model (opencode-go/deepseek-v4-flash#max), one host version (2.0.18), Windows. No Linux/macOS.
- Evidence lives in `%TEMP%\opencode\bifrost-evidence\<plugin>\` — `REPORT.log`, transcripts,
  artifacts, `decidable.txt` summaries; the flight harness in `%TEMP%\opencode\bifrost-verdict\`.

## Proof 10 — the token tracker: mounted live, verdict partial, and the toast the plugin swallows

Date 2026-09-29. Build: `main @ 239c9bc` — the facade work merged as squash `239c9bc` (PR #13,
"feat(facade): bridge client.session.messages; refuse children and tui.showToast with evidence").
Live-mount evidence: OpenCode **2.0.18** (Windows), the operator's harness and its durable sink.
The mechanism is decidable in the suite, which drives the **real cached plugin file**.

### What the matrix says (this proof keeps the matrix's wording, not a paraphrase)

Three facade rows and one event row were added or sharpened by this change:

- `client.session.messages` — 🟡 **partial**. Destination `ctx.session.context`
  (`src/compat-matrix.ts:85-90`): the facade returns the V1 `{ data: [{ info, parts }] }` envelope
  with `tokens`, `time`, `cost`, `finish` and the `providerID`/`modelID` pair preserved
  (`src/context.ts:56-78`), but it is the **active context only — messages after the last
  compaction**. The full transcript is the HTTP route, unreachable from the plugin context: the V1
  facade's `serverUrl` is a placeholder (`src/context.ts:137`) because V2 hands a plugin no real
  server address.
- `client.session.children` — 🔴 **refused** (`src/compat-matrix.ts:91-96`): V2 exposes no
  plugin-scoped child-session listing; `session.list?parentID` is HTTP-only. Refused loudly at load
  (`src/context.ts:54`) and on call (the session proxy, `src/context.ts:79-85`).
- `client.tui.showToast` — 🔴 **refused** (`src/compat-matrix.ts:97-102`): no sanctioned
  server-plugin publish surface; `tui.toast.show` is a **TUI-process event**. Refused loudly at load
  (`src/context.ts:51-53`) and on call (`src/context.ts:113-122`).
- `event` — 🟡 **partial**, and this is the trigger the tracker needs: a V2 `session.status` whose
  `status.type` is `"idle"` is synthesised to the V1
  `{ type: "session.idle", properties: { sessionID } }` envelope, and the deprecated `session.idle`
  event gets its `properties` alias (`src/hooks.ts:32-42`).

### The live mount (durable sink, operator's harness)

`~/.cache/opencode/oc-bifrost/report.log` records the tracker mounting through the bridge — a fresh
snapshot fetch, then cache loads on later starts:

```
[oc-bifrost:github:eserete/opencode-token-tracker@main#token-tracker.js] partial bridge for "event" — V2 event names/payloads differ from V1
[oc-bifrost] github:eserete/opencode-token-tracker@main#token-tracker.js
  mounted     v1:TokenTracker — V1 named export (TokenTrackerPlugin)
  mounted     github:eserete/opencode-token-tracker — fetched github:eserete/opencode-token-tracker@main#token-tracker.js at commit 6a634805a65ae2b86f2dec9ec4d9905f113f0c03 as a repository snapshot (8 files, 53682 bytes materialized; tarball sha256 af6bc7429956…) (entry sha256 635c2a818794…, 7999 bytes; trust-on-first-use); executes with the host process's full user rights
  partial     event — V2 event names/payloads differ from V1
```

The cache's own provenance record agrees (`meta.json`): `resolvedCommit` `6a634805…`,
`token-tracker.js`, 7999 bytes, sha256 `635c2a8187942807492ee995643a6722dde87a8c23d577d9b9d55a6174384f40`,
fetched `2026-09-29T07:34:33Z`.

**Mounted is the whole of the live claim here.** The mount predates the #13 merge and ran the
released bridge, so the live log cannot show the facade behaviour this proof is about; it does show
the tracker's trigger never fired against that build — the log carries no tracker-caused refusal
line anywhere (compare the announcer's repeated `client.provider.list is not provided…` lines), so
no `session.messages`/`children`/`showToast` call ever escaped the plugin's guard. Post-#13, the
synthesis above is what gives the tracker its trigger.

### The mechanism of the silence (decidable, test-driven)

`test/token-tracker.test.js` imports the real cached `token-tracker.js` (skipped only when the cache
tree is absent, `:94-96`), discovers it as a V1 factory (`:102-105`), builds the V1 context and
registers its hooks on the same bridge code this page documents (`:107-109`), then pushes a V2
`session.status` idle event (`:111-116`). What the test proves, in the tracker's own source terms:

- The synthesised idle event **reaches the tracker**: it calls `client.session.messages` with the
  session id (`:121-125`; the tracker's `event` hook is `token-tracker.js:110-113`).
- The tracker then calls `client.session.children` (`token-tracker.js:125`) — the **loud refusal
  fires** and is recorded (`test/token-tracker.test.js:119`, `:130-133`:
  `client.session.children is not provided by the V1 compatibility layer`; `:126-129` for the
  load-time toast refusal).
- The toast call (`token-tracker.js:187-189`) is **never reached** (`:134-138`), because the refusal
  aborted the same `try` block the call sits in.
- The refusal **never escapes the bridge**: the bridge's event loop reports `event hook threw` if a
  handler throws (`src/hooks.ts:312-318`), and the test asserts that line is absent (`:139-143`).
  The tracker's own blanket catch is what makes that silence: it swallows every error by design
  (`token-tracker.js:190-192`; the comment in it reads "Silently ignore errors to avoid disrupting the session").

So the verdict is exactly the matrix's, no more: **the tracker mounts live and its token read
works; it still cannot toast — the plugin swallows the refusal.** The bridge's refusal is loud in
the report (the durable sink carries it); the user-visible result is silence, and that choice
belongs to the plugin.

### The decision point

A sanctioned toast equivalent does not exist in V2 for a server plugin: `tui.toast.show` is a
TUI-process event (`packages/plugin/src/promise/plugin.ts:26-54`, `packages/tui/src/app.tsx:1265`),
not a callable surface. Whether the bridge should grow one — a companion TUI entrypoint or an RPC
design — is an **open design question for a separate PR**. Until then `client.tui.showToast` stays
refused: never faked. (The facade already bridges `client.app.log` for plugins that can log instead —
`src/context.ts:87-97` — but that substitution is a plugin-side change the tracker has not made.)

### Honest scope of Proof 10

- Proven: the live mount of the tracker through the bridge (durable sink + cache provenance); and
  the facade behaviours above, test-driven **against the real cached plugin file** on this build.
- Not proven here: any live host run of the post-#13 build with the tracker, and any user-visible
  toast observation either way — the silence is proven as a code path, not filmed in a UI.
- The end-to-end test **skips** when the cache tree is absent (`test/token-tracker.test.js:96`); the
  suite proves the mechanism, this page records the provenance. One host (2.0.18), Windows.

## Proof 11 — Flight 2: the second sampling, ten more plugins on the packed 1.3.0 tarball

Date 2026-09-29. Host: OpenCode **2.0.18** (Windows, pinned `opencode.exe`), Node 24.21.0.

**Purpose — owner peace-of-mind re-run.** Proof 9 flew ten awesome-opencode plugins on the packed
1.2.0 tarball. Flight 2 repeats the exact exercise on a **disjoint roster** — ten plugins, none of
them in `VERIFIED-PLUGINS.md` or any prior flight — through the **packed** 1.3.0 artifact, never
the source tree. Nothing in the operator's live config or harness cache was read or written.

**Artifact under test:** `nathwn12-oc-bifrost-1.3.0.tgz` — 117,159 bytes, sha256
`56C529A48651ACB33BDD19CE402F600A6A72BD04D97EDA46CDEE9B8FAD12DF3B` — the 1.3.0 release merge
`ea57ba7`. `npm run check` was 191/191 alongside the flight.

### Method (the flight's own header notes, quoted)

Every flight ran a real, isolated host: every opencode process spawned hidden through the
windowless wrapper (`run-host-hidden.ps1`), each sandbox with its own `XDG_*` roots and its own
copy of the credential DB — a consistent `sqlite3 .backup` snapshot, taken once and copied in by
pointer:

> All ten were flown on a real, isolated **OpenCode 2.0.18** host (Windows, pinned `opencode.exe`),
> through the **packed** bridge artifact — never the source tree. Nothing in the operator's live
> config or harness cache was read or written; every sandbox carried its own `XDG_*` roots and its
> own copy of the credential DB (a consistent `sqlite3 .backup` snapshot, taken once and copied in
> by pointer). Every opencode process was spawned hidden, via the windowless wrapper.

**Route note (adaptation, stated):** the wrapper implements `serve` + `run --server`; this flight
used that route rather than `run --standalone`, because under `--standalone` the host serves
JSON-RPC on stdio and plugin `console.log`/report output is dropped, while the serve route writes
plugin stdout to a captured log. Both processes were still spawned windowless through the wrapper.

Verdict vocabulary was the Proof 9 bar: `full` needs a live write-back proof, not a mount line;
`partial` names a loss; `refused` means refused out loud. A prerequisite the plugin declares is
not the bridge's job.

### The verdicts — 1 full · 5 partial · 3 refused · 1 provisioned

| # | Plugin (pinned spec) | Verdict | Decidable evidence |
|---|---|---|---|
| 1 | romain325/opencode-hooks-plugin `55d5cfa1…` `src/index.ts` | 🟢 **full** | PreToolUse returned `updatedInput`; host spawn log shows the mutated `echo BIFROST_HOOK_REWRITTEN` executed (asked: `echo ORIGINAL_COMMAND`); Pre/PostToolUse markers ordered around real execution |
| 2 | VincentHardouin/opencode-snip `1cc9b020…` `src/index.ts` | 🟡 **partial** | mounts with a `full` row, but gates on `input.tool === "bash"` vs V2 `shell`; `git status --porcelain` ran unrewritten |
| 3 | tlinhart/opencode-system-prompt-logger `66999afe…` `index.ts` | 🔴 **refused** | `no V1 factory... export found` — factory named `SystemPromptLogger`, missed by the `/Plugin$/` heuristic |
| 4 | simonwjackson/opencode-direnv `f257fa7f…` `src/index.ts` | 🔴 **refused** | same discovery skip (`DirenvLoader`); `$env:DIRENV_FLIGHT2` unset proves it never ran |
| 5 | arttttt/opencode-pr-signature `44a44b3f…` `src/entry/legacy.ts` | 🟡 **partial** | mounted, both hooks registered, but the commit ran **unsigned** (`git-log.txt` empty body) — `SHELL_TOOL = "bash"` gate again |
| 6 | Zaradacht/opencode-host-notify-bridge `7f841fa6…` `index.js` `{"enabled":true}` | 🟡 **partial** | V1-module route mounted; local listener on `127.0.0.1:8765` captured **zero** POSTs — no `session.idle` in the 2.0.18 plugin feed |
| 7 | pawelma/opencode-autotitle `40430fbc…` `src/index.ts` | 🟡 **partial** | own debug log proves the live V2 feed (25+ event types), but zero `message.part.updated` / `session.idle` — inert on 2.0.18 |
| 8 | Octane0411/opencode-plugin-openspec `54864428…` `src/index.ts` | 🔴 **refused** | OpenSpec detection satisfied; its single `config` hook refused out loud — matrix row working as designed |
| 9 | sun-praise/opencode-review `e8ecabe3…` `src/index.ts` | 🟡 **provisioned** | run 1 refused (`Cannot find package '@opencode-ai/plugin'`); with that package junctioned inside the sandbox, run 2's `tools.toggle_auto_review({enabled:false})` → 「Auto-review is now OFF.」 |
| 10 | RoderickQiu/opencode-workaholic `767d23bb…` `src/index.ts` | 🔴 **refused** | snapshot guard refused the archive before materialization — `.mise/tasks/lint:fix` carries a Windows ADS colon; nothing cached, nothing executed |

### Evidence inventory — 11 dirs under `%TEMP%\opencode\bifrost-evidence-2\`

`hooks-plugin\`, `hooks-plugin-mutation\`, `snip\`, `system-prompt-logger\`, `direnv\`,
`pr-signature\`, `host-notify-bridge\`, `autotitle\`, `openspec\`, `opencode-review\`,
`workaholic\` — each with the flight's standard set: `REPORT.log` (durable sink mount block),
`decidable.txt` (the verdict argument), `mount-lines.txt`, `transcript.txt`(+err), `server.*.log`,
`run-status.txt`, `launcher-serve.txt`, `db-tables.txt`; plugin-specific artifacts per row
(`hooks-plugin-mutation\work\HOOK_PRETOOLUSE.txt`, `pr-signature\git-log.txt`,
`host-notify-bridge\notify-posts.log`, `autotitle\autotitle.log`, `direnv\work\`), plus the flight
verdict table itself at `%TEMP%\opencode\bifrost-evidence-2\VERDICTS.md`. The row-by-row record
(with the `1 full · 5 partial · 3 refused · 1 provisioned` counts) is in `VERIFIED-PLUGINS.md`,
Flight 2.

### Cleanup — confirmed at record time

The flight's working area (`fly2` sandbox + harness) and the credential-DB snapshot are **deleted**:
no `fly2` directory and no `.backup`/snapshot DB file remain under `%TEMP%` (checked to depth 3
when this proof was written). The `bifrost-evidence-2` dirs above are kept as the evidence record —
the same policy Flight 1's `bifrost-evidence` follows. Nothing outside the sandboxes was read
except the one `sqlite3 .backup` read, and it was a copy-by-pointer provisioning step.

### Findings for the bridge — deferred, deliberately (findings, not fixes)

These came out of Flight 2 and are recorded for the bridge's next PRs. **They are findings, not
fixes**: nothing in the bridge changed for this flight, and each fix below belongs in a separate,
scoped PR with its own test.

1. **Discovery heuristic misses legitimate V1 factories** — `src/discover.ts:34` accepts named
   exports only when the name matches `/Plugin$|plugin$|^plugin$|^Plugin$/`. Two first-class V1
   factories (`SystemPromptLogger`, `DirenvLoader`) were skipped loudly. A shape check (function
   export) rather than a name check would widen the gate without guessing.
2. **Tool-name fidelity for V1-era plugins** — the bridge passes the V2 tool id verbatim
   (`src/hooks.ts`: `tool: event.tool`). V2 names its shell tool **`shell`**
   (`packages/core/src/tool/plugin/shell.ts:22`; V1 migration `bash` -> `shell` at
   `packages/core/src/v1/config/migrate.ts:120`), while V1-era plugins gate on `"bash"`
   (snip, pr-signature, workaholic). Those plugins mount and register, then silently no-op.
   RTK works only because its vendor accepts both names.
3. **Event vocabulary** — V2 2.0.18's plugin feed carried `session.execution.*`, `session.step.*`,
   `session.text.*`, `session.usage.updated`, `session.renamed`, `model/provider/plugin.updated`
   (autotitle debug log) with **no** `session.status`/`session.idle` observable, so the matrix's
   documented `session.status[idle] -> session.idle` synthesis never fired for the two plugins that
   rely on it (autotitle, host-notify-bridge). The `partial` event row is accurate; the mapping
   may be stale for this host version.
4. **Working as designed, worth knowing** — the snapshot guard refused `RoderickQiu/opencode-workaholic`
   because of an archive entry with `:`. On Windows, repos containing such names (e.g. `.mise/tasks/lint:fix`)
   cannot be materialized; the refusal is loud and nothing executes. Not a defect to fix blindly.

### Honest scope of Proof 11

- Proven: ten **new** plugins (disjoint from every prior roster) through the **packed 1.3.0**
  tarball on a real 2.0.18 host — 1 full write-back, 5 partial with named losses, 3 refused out
  loud with named mechanisms, 1 provisioned pass; each with a decidable artifact.
- One host (`2.0.18`), one OS (Windows), one model (`opencode-go/deepseek-v4-flash`), one artifact
  (the packed 1.3.0 tarball). Linux/macOS untested; re-run on each OpenCode release.
- No repository was changed by the flight; nothing was published; the credential snapshot existed
  only for provisioning and is deleted.
