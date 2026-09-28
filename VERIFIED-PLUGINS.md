# Verified plugins

Plugins smoke-tested against `oc-bifrost` on OpenCode V2. "Verified" means a run was performed — not an assumption.

| Plugin | Hooks used | Matrix level | OpenCode | Result | By |
|---|---|---|---|---|---|
| [opencode-claude-hooks](https://www.npmjs.com/package/opencode-claude-hooks) `0.1.0` | `event`, `tool.execute.before`, `tool.execute.after`, `permission.ask` | 🟢 / 🟡 | 2.0.18 | ✅ **mounted from npm; its PreToolUse hook fired and wrote its marker file** | nathwn12 |
| [rtk-ai/rtk](https://github.com/rtk-ai/rtk) `hooks/opencode/rtk.ts` @ `v0.50.0` | `tool.execute.before` | 🟢 full | 2.0.18 | ✅ **live global install — `git status --porcelain` executed as `rtk git status --porcelain`** (host spawn log); binary prerequisite met (rtk `0.50.0`, sha256-verified) | nathwn12 |
| [Graphify](https://github.com/Graphify-Labs/graphify) | `AGENTS.md` guidance + nudge hook | 🟢 / 🟡 | 2.0.18 | ✅ `AGENTS.md` path is V2-native | nathwn12 |

The first two rows come from the isolated runs in [`PROOF.md`](PROOF.md); the RTK row also has a **live** global install recorded there as Proof 4. Add yours with a PR: copy a row, state the plugin version, the hooks it registers, and the command you ran to prove it.

**A plugin's external prerequisites are not the bridge's job.** RTK shells out to a `rtk` binary; without it on `PATH` the plugin disables itself — correctly, and quietly. When you add a row, say whether a binary, daemon, or credential had to exist first, so the next reader isn't debugging a plugin that is simply unmet.
