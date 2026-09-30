import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { wireTui, unwireTui, __setWireTuiSeamForTests } from "../dist/wire-tui.js"

/**
 * wire-tui: the opt-in TUI wiring step of oc-bifrost provisioning -
 *
 *   - wrapper: a `tui.tsx` re-export at the tree root, created ONLY when the
 *     tree lacks a loadable `tui.{ts,tsx}` (a directory does not count);
 *     idempotent - a loadable file means no write, ever
 *   - cli.json: a TEXT merge that splices ONLY the `plugins` key. The exact
 *     entry string is `url.pathToFileURL(treeDir).href` (forward slashes,
 *     matching the live, load-verified entry form) and dedupe is by that
 *     exact string. Every unrelated byte - `$schema`, comments, other keys -
 *     survives byte-for-byte (golden compares below)
 *   - concurrency: the live client rewrites cli.json itself, so every write
 *     is guarded by an mtime check with re-read/re-merge, up to 3 attempts,
 *     then a loud refusal. The seam hook (`__setWireTuiSeamForTests`)
 *     simulates that concurrent writer
 *   - unwireTui removes ONLY what wireTui added (its inline-marked entries /
 *     the whole key it auto-created), byte-preserving everything else, and
 *     returns false when there is nothing to do
 *
 * All paths live in tmp dirs; no real machine paths appear anywhere.
 */

const WRAPPER_CONTENT = 'export { default } from "./src/tui/index.tsx";\n'

// The exact marker comments wire-tui writes (the byte-level ownership
// contract unwireTui relies on; keep these in lockstep with src/wire-tui.ts).
const CREATED_KEY_MARKER = "// oc-bifrost: managed TUI entry (key auto-created; safe to remove with it)"
const ENTRY_MARKER = "// oc-bifrost: managed TUI entry"

const IND = "  "
const IND2 = IND + "  "

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-wire-test-"))
}

function writeTree(root) {
  const tree = path.join(root, "tree")
  fs.mkdirSync(tree, { recursive: true })
  return tree
}

function writeCli(root, content) {
  const cli = path.join(root, "cli.json")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(cli, content)
  return cli
}

/* ---- wrapper ---- */

test("wireTui: creates the tui.tsx wrapper when the tree lacks a loadable tui.{ts,tsx}", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const cli = writeCli(root, '{\n  "verbosity": 2\n}\n')
    const out = await wireTui(tree, cli)
    assert.equal(out.wrapper, path.join(tree, "tui.tsx"))
    assert.equal(out.entry, pathToFileURL(tree).href, "the entry must be exactly pathToFileURL(treeDir).href")
    assert.ok(out.entry.startsWith("file:///"), "the entry must be a file URL with forward slashes")
    assert.equal(fs.readFileSync(path.join(tree, "tui.tsx"), "utf8"), WRAPPER_CONTENT)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: wrapper is idempotent - an existing loadable tui.tsx is never touched", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const cli = writeCli(root, '{\n  "verbosity": 2\n}\n')
    const first = await wireTui(tree, cli)
    const wrapperPath = path.join(tree, "tui.tsx")
    const before = fs.readFileSync(wrapperPath, "utf8")
    const second = await wireTui(tree, cli)
    assert.equal(first.wrapper, wrapperPath)
    assert.equal(second.wrapper, null, "a second pass must not report a wrapper")
    assert.equal(fs.readFileSync(wrapperPath, "utf8"), before, "the wrapper file must not be rewritten")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: an existing tui.ts or tui.tsx file means no wrapper is written", async () => {
  const root = tmpRoot()
  try {
    const cli = writeCli(root, "{}")
    const treeTs = writeTree(root)
    fs.mkdirSync(path.join(root, "tree-tsx"))
    const treeTsx = path.join(root, "tree-tsx")
    fs.writeFileSync(path.join(treeTs, "tui.ts"), "export default {}\n")
    fs.writeFileSync(path.join(treeTsx, "tui.tsx"), "export default {}\n")
    assert.equal((await wireTui(treeTs, cli)).wrapper, null)
    assert.equal((await wireTui(treeTsx, cli)).wrapper, null)
    assert.equal(fs.existsSync(path.join(treeTs, "tui.tsx")), false)
    assert.equal(fs.readFileSync(path.join(treeTsx, "tui.tsx"), "utf8"), "export default {}\n", "the existing entry must be untouched")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a tui.ts that is a DIRECTORY does not count as loadable; a tui.tsx directory refuses loudly", async () => {
  const root = tmpRoot()
  try {
    const cli = writeCli(root, "{}")
    const treeDir = writeTree(root)
    fs.mkdirSync(path.join(treeDir, "tui.ts"), { recursive: true })
    const out = await wireTui(treeDir, cli)
    assert.equal(out.wrapper, path.join(treeDir, "tui.tsx"), "a tui.ts directory must not block the wrapper")

    const blocked = writeTree(path.join(root, "tree-blocked"))
    fs.mkdirSync(path.join(blocked, "tui.tsx"), { recursive: true })
    await assert.rejects(
      () => wireTui(blocked, cli),
      (e) => e instanceof Error && e.message.includes("[oc-bifrost]") && e.message.includes("tui.tsx"),
      "the refusal must be loud, prefixed, and name the failing path",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- cli.json merge: golden byte-preservation ---- */

test("wireTui: inserts the plugins key after $schema with every unrelated byte preserved (golden)", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const entry = pathToFileURL(tree).href
    const before = [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "verbosity": 2,',
      "  // keep me exactly",
      '  "theme": "dark"',
      "}",
      "",
    ].join("\n")
    const cli = writeCli(root, before)

    await wireTui(tree, cli)

    const expected = [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      `  "plugins": [`,
      `    ${CREATED_KEY_MARKER}`,
      `    "${entry}"`,
      `  ],`,
      '  "verbosity": 2,',
      "  // keep me exactly",
      '  "theme": "dark"',
      "}",
      "",
    ].join("\n")
    assert.equal(fs.readFileSync(cli, "utf8"), expected)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: dedupes by exact entry string - a second pass rewrites nothing", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const cli = writeCli(root, '{\n  "verbosity": 2\n}\n')
    await wireTui(tree, cli)
    const once = fs.readFileSync(cli, "utf8")
    const again = await wireTui(tree, cli)
    assert.equal(again.entry, pathToFileURL(tree).href)
    assert.equal(fs.readFileSync(cli, "utf8"), once, "the second pass must not touch the file")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: merges into an existing plugins array, preserving user entries and their layout (golden)", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const entry = pathToFileURL(tree).href
    const before = '{\n  "plugins": ["keep-me", "keep-me-2"]\n}\n'
    const cli = writeCli(root, before)

    await wireTui(tree, cli)

    const expected = `{\n  "plugins": ["keep-me", "keep-me-2",\n    ${ENTRY_MARKER}\n    "${entry}"]\n}\n`
    assert.equal(fs.readFileSync(cli, "utf8"), expected)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: appends after a trailing comma and into an empty array without breaking either", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const entry = pathToFileURL(tree).href
    const cliTrailing = writeCli(path.join(root, "a"), '{\n  "plugins": ["keep-me",]\n}\n')
    const cliEmpty = writeCli(path.join(root, "b"), '{\n  "plugins": []\n}\n')

    await wireTui(tree, cliTrailing)
    assert.equal(
      fs.readFileSync(cliTrailing, "utf8"),
      `{\n  "plugins": ["keep-me",\n    ${ENTRY_MARKER}\n    "${entry}"]\n}\n`,
    )

    await wireTui(tree, cliEmpty)
    assert.equal(fs.readFileSync(cliEmpty, "utf8"), `{\n  "plugins": [${ENTRY_MARKER}\n"${entry}"]\n}\n`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a user entry identical to ours is deduped and never claimed (no marker added)", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const entry = pathToFileURL(tree).href
    const before = `{\n  "plugins": ["${entry}"]\n}\n`
    const cli = writeCli(root, before)

    const out = await wireTui(tree, cli)
    assert.equal(fs.readFileSync(cli, "utf8"), before, "nothing may be added when the exact entry already exists")
    assert.equal(out.entry, entry)
    assert.equal(await unwireTui(cli), false, "an entry that predates us must never be removed")
    assert.equal(fs.readFileSync(cli, "utf8"), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- concurrent writer (the client rewrites cli.json live) ---- */

test("wireTui: a concurrent rewrite between read and write is re-read and its settings preserved", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const cli = writeCli(root, '{\n  "verbosity": 2\n}\n')
    let rewrites = 0
    __setWireTuiSeamForTests({
      beforeWrite: () => {
        rewrites++
        if (rewrites === 1) {
          // The live client rewrites cli.json between our read and our write.
          fs.writeFileSync(cli, '{\n  "verbosity": 9\n}\n')
          const st = fs.statSync(cli)
          // Strictly increasing mtime: the filesystem truncates to whole
          // milliseconds, so a fixed offset could collide across rounds.
          fs.utimesSync(cli, st.atime, new Date(st.mtimeMs + 5_000 + rewrites))
        }
      },
    })
    try {
      const out = await wireTui(tree, cli)
      assert.equal(rewrites, 2, "attempt 1 detects the race, attempt 2 re-reads and merges cleanly")
      const expected = [
        "{",
        `  "plugins": [`,
        `    ${CREATED_KEY_MARKER}`,
        `    "${out.entry}"`,
        `  ],`,
        '  "verbosity": 9',
        "}",
        "",
      ].join("\n")
      assert.equal(fs.readFileSync(cli, "utf8"), expected, "the concurrent writer's settings must survive the re-merge")
    } finally {
      __setWireTuiSeamForTests(null)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a writer that races on every attempt is refused loudly, naming the path, with no partial write", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const cli = writeCli(root, '{\n  "verbosity": 2\n}\n')
    let calls = 0
    __setWireTuiSeamForTests({
      beforeWrite: () => {
        calls++
        fs.writeFileSync(cli, `{\n  "verbosity": ${calls}\n}\n`)
        const st = fs.statSync(cli)
        fs.utimesSync(cli, st.atime, new Date(st.mtimeMs + 5_000 + calls))
      },
    })
    try {
      await assert.rejects(
        () => wireTui(tree, cli),
        (e) =>
          e instanceof Error &&
          e.message.includes("[oc-bifrost]") &&
          e.message.includes(cli) &&
          /concurrent/i.test(e.message),
      )
      assert.equal(calls, 3, "exactly three attempts must be made before refusing")
      assert.equal(fs.readFileSync(cli, "utf8"), '{\n  "verbosity": 3\n}\n', "the writer's last content must be untouched")
    } finally {
      __setWireTuiSeamForTests(null)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- unwireTui: removes only what we added ---- */

test("unwireTui: round-trips a created key byte-for-byte (golden)", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const before = [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "verbosity": 2,',
      "  // keep me exactly",
      '  "theme": "dark"',
      "}",
      "",
    ].join("\n")
    const cli = writeCli(root, before)
    await wireTui(tree, cli)
    const wired = fs.readFileSync(cli, "utf8")

    assert.equal(await unwireTui(cli), true, "unwiring a wired file must report a change")
    assert.equal(fs.readFileSync(cli, "utf8"), before, "unwire must restore the original bytes exactly")
    assert.notEqual(wired, before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("unwireTui: round-trips a top-of-object-created key with no $schema", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const before = '{\n  "verbosity": 2\n}\n'
    const cli = writeCli(root, before)
    await wireTui(tree, cli)
    assert.equal(await unwireTui(cli), true)
    assert.equal(fs.readFileSync(cli, "utf8"), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("unwireTui: removes only our entry from a user-owned plugins array, restoring it byte-for-byte", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    for (const [name, before] of [
      ["no-trailing", '{\n  "plugins": ["keep-me", "keep-me-2"]\n}\n'],
      ["trailing", '{\n  "plugins": ["keep-me",]\n}\n'],
      ["empty", '{\n  "plugins": []\n}\n'],
    ]) {
      const cli = writeCli(path.join(root, name), before)
      await wireTui(tree, cli)
      assert.equal(await unwireTui(cli), true, `${name}: unwire must report the change`)
      // The no-trailing and empty cases restore byte-for-byte. In the
      // trailing case the dangling comma directly before our marker is taken
      // with our pair so the restored array never keeps a stray separator.
      const expected = before === '{\n  "plugins": ["keep-me",]\n}\n' ? '{\n  "plugins": ["keep-me"]\n}\n' : before
      assert.equal(fs.readFileSync(cli, "utf8"), expected, `${name}: user bytes must be restored exactly`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("unwireTui: keeps user entries that were added after we created the key", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const entry = pathToFileURL(tree).href
    const cli = writeCli(root, "{}\n")
    await wireTui(tree, cli)
    // The user edits the managed key afterwards, adding their own entry.
    fs.writeFileSync(
      cli,
      `{\n  "plugins": [\n    ${CREATED_KEY_MARKER}\n    "${entry}",\n    "user-added"\n  ]\n}\n`,
    )
    assert.equal(await unwireTui(cli), true)
    assert.equal(fs.readFileSync(cli, "utf8"), '{\n  "plugins": [\n    "user-added"\n  ]\n}\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("unwireTui: returns false when there is nothing of ours to remove, touching no bytes", async () => {
  const root = tmpRoot()
  try {
    const cli = writeCli(root, '{\n  "verbosity": 2\n}\n')
    const before = fs.readFileSync(cli, "utf8")
    assert.equal(await unwireTui(cli), false)
    assert.equal(fs.readFileSync(cli, "utf8"), before)

    assert.equal(await unwireTui(path.join(root, "missing.json")), false, "a missing cli.json is nothing to do")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- loud refusals on ambiguous formatting ---- */

test("wireTui: refuses loudly when the plugins value is not an array, leaving the file untouched", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const before = '{\n  "plugins": "file:///C:/somewhere"\n}\n'
    const cli = writeCli(root, before)
    await assert.rejects(
      () => wireTui(tree, cli),
      (e) => e instanceof Error && e.message.includes("[oc-bifrost]") && e.message.includes(cli),
    )
    assert.equal(fs.readFileSync(cli, "utf8"), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui and unwireTui: refuse loudly on a file that is not a balanced JSONC object", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    for (const before of ["[1, 2]\n", "not json at all\n", '{\n  "a": [1, 2\n}\n']) {
      const cli = writeCli(path.join(root, String(fs.readdirSync(root).length)), before)
      await assert.rejects(
        () => wireTui(tree, cli),
        (e) => e instanceof Error && e.message.includes("[oc-bifrost]") && e.message.includes(cli),
      )
      await assert.rejects(
        () => unwireTui(cli),
        (e) => e instanceof Error && e.message.includes("[oc-bifrost]") && e.message.includes(cli),
      )
      assert.equal(fs.readFileSync(cli, "utf8"), before, "a refused file must never be written")
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})