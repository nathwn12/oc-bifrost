# Verified plugins

Plugins smoke-tested against `oc-bifrost` on OpenCode V2. "Verified" means a run was performed — not an assumption.

| Plugin | Hooks used | Matrix level | OpenCode | Result | By |
|---|---|---|---|---|---|
| [opencode-claude-hooks](https://www.npmjs.com/package/opencode-claude-hooks) `0.1.0` | `event`, `tool.execute.before`, `tool.execute.after`, `permission.ask` | 🟢 / 🟡 | 2.0.18 | ✅ **mounted from npm; its PreToolUse hook fired and wrote its marker file** | nathwn12 |
| [rtk-ai/rtk](https://github.com/rtk-ai/rtk) `hooks/opencode/rtk.ts` | `tool.execute.before` | 🟢 full | 2.0.18 | ✅ discovered + mounted; self-disables without its binary (plugin's own preflight) | nathwn12 |
| [Graphify](https://github.com/Graphify-Labs/graphify) | `AGENTS.md` guidance + nudge hook | 🟢 / 🟡 | 2.0.18 | ✅ `AGENTS.md` path is V2-native | nathwn12 |

The first two rows are the isolated, end-to-end runs recorded in [`PROOF.md`](PROOF.md). Add yours with a PR: copy a row, state the plugin version, the hooks it registers, and the command you ran to prove it.
