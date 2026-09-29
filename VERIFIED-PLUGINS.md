# Verified plugins

Plugins smoke-tested against `oc-bifrost` on OpenCode V2. "Verified" means a run was performed — not an assumption.

There are **two mounting routes**, and a row says which one it exercised:

- **V1 hook translation** — a V1 factory/module; its hooks are bridged per the compatibility matrix.
- **V2 pass-through** — an `export default` `{ id, setup | effect }`; it is mounted as-is with the host context. A **dual-export** file (V1 named export + V2 default) takes this route for its V2 default; the V1 named export is left untouched.

| Plugin | Hooks used | Matrix level | OpenCode | Result | By |
|---|---|---|---|---|---|
| [opencode-claude-hooks](https://www.npmjs.com/package/opencode-claude-hooks) `0.1.0` | `event`, `tool.execute.before`, `tool.execute.after`, `permission.ask`, `experimental.session.compacting` | 🟢 / 🟡 | 2.0.18 | ✅ **npm-installed copy mounted by absolute path — the bridge refuses `npm:` specifiers (`src/index.ts`); its PreToolUse hook fired and wrote its marker file** | nathwn12 |
| [rtk-ai/rtk](https://github.com/rtk-ai/rtk) `hooks/opencode/rtk.ts` @ `v0.50.0` | `tool.execute.before` | 🟢 full | 2.0.18 | ✅ **live global install — `git status --porcelain` executed as `rtk git status --porcelain`** (host spawn log); binary prerequisite met (rtk `0.50.0`, sha256-verified) | nathwn12 |
| [obra/superpowers](https://github.com/obra/superpowers) `v6.4.2` | *(dual export)* V1 `SuperpowersPlugin` factory **and** V2 `{ id, setup }` default | V2 pass-through | 2.0.18 | ✅ **host-run through the `github:` route — the bridge reported `mounted v2:superpowers` (its `setup` invoked with the live context) at commit `8ca22dba…`, sha256 `c979fe5a…`; the V1 named export was not hook-translated.** No downstream effect was observable headlessly — see `PROOF.md`, Proof 6 | nathwn12 |

The first two rows are V1 hook translation, from the isolated runs in [`PROOF.md`](PROOF.md) (the RTK row also has a **live** global install recorded there as Proof 4). The third is the V2 pass-through route — now exercised in a real host as well as by the discovery test (`PROOF.md`, Proof 6). Add yours with a PR: copy a row, state the plugin version, which route it exercised, the hooks it registers, and the command you ran to prove it.

**A plugin's external prerequisites are not the bridge's job.** RTK shells out to a `rtk` binary; without it on `PATH` the plugin disables itself — correctly, and quietly. When you add a row, say whether a binary, daemon, or credential had to exist first, so the next reader isn't debugging a plugin that is simply unmet.
