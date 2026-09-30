# oc-bifrost — agent guide

A compatibility bridge that runs OpenCode **V1-era plugin hooks** on the **V2** runtime.

## What this repo is

One OpenCode V2 plugin (`src/index.ts`) that imports plugin modules of any era and mounts them:

- V1 factory / V1 module → `src/hooks.ts` translates V1 hook keys to V2 registration calls.
- V2 definition `{ id, setup }` → mounted with the host context.

## The contract

[`src/compat-matrix.ts`](src/compat-matrix.ts) is the single source of truth. Every row carries a `level` and the **name of the test that proves it**. README, the load-time report, and the test suite all derive from it.

- `full` — bridged, with a test proving the write-back.
- `partial` — bridged with a stated loss.
- `unsupported` — refused out loud. Never faked.

## Rules

- **Never claim `full` without a write-back test.** The load-bearing case is `tool.execute.before`: V2 reads back the mutated `event.input` and `event.tool` after the hook (`packages/core/src/tool.ts`), so an in-place mutation reaches execution.
- **A refusal is a feature.** Three V1 hooks have no V2 destination. Do not invent one.
- **Fail loud, never silent.** Anything unmapped warns at load; `strict: true` aborts.
- **Verify against source, cite by file:line.** The V2 checkout is the authority, not the docs site.
- **One logical change per PR.** `npm run check` must be green.

## Layout

| Path | Job |
|---|---|
| `src/index.ts` | Plugin entry; loads and mounts each entry |
| `src/discover.ts` | Recognises V1 factory / V1 module / V2 definition |
| `src/hooks.ts` | V1 hook → V2 registration translation |
| `src/context.ts` | V1 `PluginInput` facade (`client`, `project`, `$`) |
| `src/shell.ts` | BunShell facade (Bun's `$` when present, portable shim otherwise) |
| `src/report.ts` | The honesty layer — full/partial/refused reporting |
| `src/sink.ts` | Durable report mirror — the file that survives discarded stdout |
| `src/compat-matrix.ts` | The contract |
| `test/` | Node test runner; imports from `dist/` |

## Dev loop

```sh
npm run check     # typecheck + build + tests
```

## Workflow standard (owner directive, 2026-09-30)

- Work in this checkout on `main`. No worktrees for this repo; a paused feature branch is kept as a branch, not a working copy.
- The agent owns the whole git ceremony: commits, pushes, PRs, merges, approvals, version bumps, CHANGELOG, VERIFIED-PLUGINS rows, and live-config edits (always via `scripts/backup-config.ps1` backups).
- The owner's only manual step is `npm publish`.
- Keep the checkout current: `git fetch origin --prune` and `--ff-only` sync `main` with `origin/main` before and after work; never leave it stale.
- Release flow: land the fix on `main` -> `npm run check` green -> bump the version in `package.json`/`package-lock.json` + CHANGELOG + pins -> push to `main` -> owner runs `npm publish` -> update the live pin -> verify live from logs.
- No local glue: never hand-create junctions, hand-edit `cli.json`, or point configs at cache copies to work around a product gap; fix the product instead.
