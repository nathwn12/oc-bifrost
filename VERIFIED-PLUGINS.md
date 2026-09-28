# Verified plugins

Plugins smoke-tested against `oc-bifrost` on OpenCode V2. "Verified" means a run was performed — not an assumption.

| Plugin | Hooks used | Matrix level | OpenCode | Result | By |
|---|---|---|---|---|---|
| [rtk-ai/rtk](https://github.com/rtk-ai/rtk) `hooks/opencode/rtk.ts` | `tool.execute.before` | 🟢 full | 2.0.18 | ✅ rewrite write-back proven in unit test | nathwn12 |
| [Graphify](https://github.com/Graphify-Labs/graphify) | `AGENTS.md` guidance + nudge hook | 🟢 / 🟡 | 2.0.18 | ✅ `AGENTS.md` path is V2-native | nathwn12 |

Add yours with a PR: copy a row, state the plugin version, the hooks it registers, and the command you ran to prove it.
