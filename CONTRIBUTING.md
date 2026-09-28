# Contributing

Two doors. Both gated on proof.

## 1. Add hook coverage

1. Open [`src/compat-matrix.ts`](src/compat-matrix.ts).
2. Add or change the row: `hook`, `level` (`full` / `partial` / `unsupported`), `v2` destination, and `test` — the **name of the test that proves it**.
3. Implement the bridge in [`src/hooks.ts`](src/hooks.ts) (or the refusal entry, if it has no V2 destination).
4. Add the test with that exact name in `test/hooks.test.js`.
5. `npm run check` must be green.

**Rules:**

- Never claim `full` without a test that exercises the write-back.
- A `partial` row must state what is lost in its `v2` or note field.
- Refusing a hook is a valid contribution. Faking one is not.
- If the V2 destination documented in `compat-matrix.ts` leaves an assumption open, cite the file and line in the PR that closes it.

## 2. Add a verified plugin

1. Load it through `oc-bifrost` on OpenCode V2.
2. Add a row to [`VERIFIED-PLUGINS.md`](VERIFIED-PLUGINS.md): plugin, version, hooks used, matrix level, OpenCode version, result, and **the command you ran**.
3. If it needs a hook that is not bridged yet, open a "Hook coverage" issue instead.

## Ground rules

- One logical change per PR.
- `npm run check` green.
- No new runtime dependencies without a reason in the PR body.
- The matrix is the contract. If the README and the matrix disagree, the matrix wins.

## Requests

Plugins you want supported but cannot add yourself: open the **Plugin request** issue template. Hook gaps: **Hook coverage**. Something that used to work and stopped: **Compatibility bug**.
