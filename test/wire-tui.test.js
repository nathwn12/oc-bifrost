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
 *     idempotent - a loadable file means no write, ever. The re-export target
 *     is the tree's own `exports["./tui"]` / `tui` field / a discovered
 *     `src/tui/index.tsx`, derived BEFORE any existing wrapper is consulted.
 *     A wrapper this module wrote carries its managed marker (a file the
 *     pre-derive 1.4.0 release wrote has the exact legacy bytes): it is healed
 *     against the derived target -
 *     removed when the target is none, rewritten when the target moved - and
 *     a user-authored file is never deleted. A tree that ships NONE of those
 *     entries is a clean skip - no wrapper, no cli.json entry, an
 *     informational row - while a DECLARED target that names no real file
 *     inside the tree is refused loudly
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
 *     returns false when there is nothing to do. With an `entry` argument it
 *     removes only that tree's managed entry
 *
 * All paths live in tmp dirs; no real machine paths appear anywhere.
 */

const WRAPPER_MARKER = "// oc-bifrost: managed TUI entry"

/** The managed wrapper body this module writes for a tree-relative target. */
function wrapperFor(target) {
  return `${WRAPPER_MARKER}\nexport { default } from "./${target}";\n`
}

/** The exact wrapper the pre-derive 1.4.0 release wrote for EVERY tree (1.4.1 derived the target). */
const LEGACY_WRAPPER_CONTENT = 'export { default } from "./src/tui/index.tsx";\n'

const WRAPPER_CONTENT = wrapperFor("src/tui/index.tsx")

/** Write a tree with a package manifest and/or a real nested TUI entry file. */
function writeTuiTree(tree, { manifest, files = {} } = {}) {
  fs.mkdirSync(tree, { recursive: true })
  if (manifest !== undefined) fs.writeFileSync(path.join(tree, "package.json"), JSON.stringify(manifest))
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(tree, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return tree
}

// The exact marker comments wire-tui writes (the byte-level ownership
// contract unwireTui relies on; keep these in lockstep with src/wire-tui.ts).
const CREATED_KEY_MARKER = "// oc-bifrost: managed TUI entry (key auto-created; safe to remove with it)"
const ENTRY_MARKER = "// oc-bifrost: managed TUI entry"

const IND = "  "
const IND2 = IND + "  "

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-wire-test-"))
}

/**
 * A tree directory carrying the discovered `src/tui/index.tsx` target.
 *
 * A REAL provisioned tree that HAS a TUI ships a determinable entry, and every
 * fixture whose subject is the cli.json merge/unwire needs one - without it the
 * wire step is a clean skip (nothing written, cli.json never opened) and the
 * code under test is never reached. Trees whose subject IS the absence of an
 * entry pass `{ tuiEntry: false }`; a tree that DECLARES an entry it does not
 * ship is built with `writeTuiTree(..., { manifest: { exports: { "./tui": ... } } })`
 * and must refuse loudly.
 */
function writeTreeAt(dir, { tuiEntry = true } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  if (tuiEntry) {
    const entry = path.join(dir, "src", "tui", "index.tsx")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, "export default {}\n")
  }
  return dir
}

function writeTree(root, options) {
  return writeTreeAt(path.join(root, "tree"), options)
}

function writeCli(root, content) {
  const cli = path.join(root, "cli.json")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(cli, content)
  return cli
}

/* ---- wrapper ---- */

test("wireTui: creates the tui.tsx wrapper re-exporting the tree's own exports[\"./tui\"] target", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTuiTree(writeTree(root), {
      manifest: {
        name: "widget",
        version: "1.0.0",
        exports: { "./tui": { types: "./tui/deck.tsx", import: "./tui/deck.tsx" } },
      },
      files: { "tui/deck.tsx": "export default {}\n" },
    })
    const cli = writeCli(root, '{\n  "verbosity": 2\n}\n')
    const out = await wireTui(tree, cli)
    assert.equal(out.wrapper, path.join(tree, "tui.tsx"))
    assert.equal(out.entry, pathToFileURL(tree).href, "the entry must be exactly pathToFileURL(treeDir).href")
    assert.ok(out.entry.startsWith("file:///"), "the entry must be a file URL with forward slashes")
    assert.equal(
      fs.readFileSync(path.join(tree, "tui.tsx"), "utf8"),
      wrapperFor("tui/deck.tsx"),
      "the wrapper must re-export the tree's OWN declared tui entry, not a hardcoded path",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: the wrapper target falls back to a top-level tui field", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTuiTree(writeTree(root), {
      manifest: { name: "widget", version: "1.0.0", tui: "./tui/main.tsx" },
      files: { "tui/main.tsx": "export default {}\n" },
    })
    const cli = writeCli(root, "{}")
    await wireTui(tree, cli)
    assert.equal(
      fs.readFileSync(path.join(tree, "tui.tsx"), "utf8"),
      wrapperFor("tui/main.tsx"),
      "a tui field must drive the wrapper target",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: the wrapper target falls back to a discovered src/tui/index.tsx", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTuiTree(writeTree(root), {
      manifest: { name: "widget", version: "1.0.0" },
      files: { "src/tui/index.tsx": "export default {}\n" },
    })
    const cli = writeCli(root, "{}")
    await wireTui(tree, cli)
    assert.equal(fs.readFileSync(path.join(tree, "tui.tsx"), "utf8"), WRAPPER_CONTENT)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a tree with no TUI entry at all is a clean skip - no wrapper, no cli.json entry", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), { manifest: { name: "widget", version: "1.0.0" } })
    const before = '{\n  "verbosity": 2\n}\n'
    const cli = writeCli(root, before)
    const out = await wireTui(tree, cli)
    assert.equal(out.kind, "skipped", "a tree with no TUI entry must be skipped, never refused")
    assert.match(out.reason, /no TUI entry found/, "the informational row must say what was not found")
    assert.ok(out.reason.includes(tree), "the informational row must name the tree")
    assert.ok(!out.reason.includes("[oc-bifrost]"), "a skip is informational, never a refusal")
    assert.equal(fs.existsSync(path.join(tree, "tui.tsx")), false, "a skip must write no wrapper")
    assert.equal(fs.readFileSync(cli, "utf8"), before, "a skip must not touch cli.json at all")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a declared ./tui target that is not a real file refuses loudly, writing nothing", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), {
      manifest: { name: "widget", version: "1.0.0", exports: { "./tui": "./src/tui/index.tsx" } },
    })
    const before = '{\n  "verbosity": 2\n}\n'
    const cli = writeCli(root, before)
    await assert.rejects(
      () => wireTui(tree, cli),
      (e) =>
        e instanceof Error &&
        e.message.includes("[oc-bifrost]") &&
        e.message.includes('"src/tui/index.tsx"') &&
        e.message.includes(tree),
      "a declared target that is not a real file must refuse, naming the declaration and the tree",
    )
    assert.equal(fs.existsSync(path.join(tree, "tui.tsx")), false, "a refusal must write no wrapper")
    assert.equal(fs.readFileSync(cli, "utf8"), before, "a refusal must not touch cli.json")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a top-level tui field naming a missing file refuses loudly too", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), {
      manifest: { name: "widget", version: "1.0.0", tui: "./tui/main.tsx" },
    })
    const cli = writeCli(root, "{}")
    await assert.rejects(
      () => wireTui(tree, cli),
      (e) => e instanceof Error && e.message.includes("[oc-bifrost]") && e.message.includes('"tui/main.tsx"'),
      "the `tui` field is a declaration like any other: an absent target refuses",
    )
    assert.equal(fs.existsSync(path.join(tree, "tui.tsx")), false)
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
    const treeDir = writeTuiTree(writeTree(root), {
      manifest: { name: "widget", version: "1.0.0", exports: { "./tui": "./src/tui/index.tsx" } },
      files: { "src/tui/index.tsx": "export default {}\n" },
    })
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

/* ---- managed wrapper healing (a warm cache from an earlier version) ---- */

test("wireTui: heals a warm-cache stale managed wrapper with no derived target - wrapper removed, tree skipped and unwired", async () => {
  const root = tmpRoot()
  try {
    // The warm cache: a tree that ships NO TUI entry, carrying the hardcoded
    // wrapper 1.4.0 wrote, and a cli.json that already registered the tree.
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), { manifest: { name: "widget", version: "1.0.0" } })
    const wrapperPath = path.join(tree, "tui.tsx")
    fs.writeFileSync(wrapperPath, LEGACY_WRAPPER_CONTENT)
    const entry = pathToFileURL(tree).href
    const cli = writeCli(root, `{\n  "plugins": [\n    ${CREATED_KEY_MARKER}\n    "${entry}"\n  ]\n}\n`)

    const out = await wireTui(tree, cli)

    assert.equal(out.kind, "skipped", "a tree with no derived target must be skipped, never wired")
    assert.match(out.reason, /no TUI entry found/, "the skip row must say what was not found")
    assert.ok(out.reason.includes(tree), "the skip row must name the tree")
    assert.ok(!out.reason.includes("[oc-bifrost]"), "a healing skip is informational, never a refusal")
    assert.equal(fs.existsSync(wrapperPath), false, "the stale managed wrapper must be removed")
    const after = fs.readFileSync(cli, "utf8")
    assert.ok(!after.includes(entry), "the tree must no longer be registered in cli.json")
    assert.deepEqual(JSON.parse(after), {}, "the auto-created plugins key must be taken back out")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: rewrites a legacy unmarked wrapper to the newly derived target with the managed marker", async () => {
  const root = tmpRoot()
  try {
    // The manifest declares ./tui somewhere else; 1.4.0 still wrote the
    // hardcoded discovered-path wrapper. The derived target is authoritative,
    // so a wrapper we wrote must be rewritten to it, never treated as an entry.
    const tree = writeTuiTree(writeTree(root), {
      manifest: { name: "widget", version: "1.0.0", exports: { "./tui": "./tui/deck.tsx" } },
      files: { "tui/deck.tsx": "export default {}\n" },
    })
    const wrapperPath = path.join(tree, "tui.tsx")
    fs.writeFileSync(wrapperPath, LEGACY_WRAPPER_CONTENT)
    const cli = writeCli(root, "{}")

    const out = await wireTui(tree, cli)

    assert.equal(out.wrapper, wrapperPath, "the managed wrapper must be rewritten")
    assert.equal(
      fs.readFileSync(wrapperPath, "utf8"),
      wrapperFor("tui/deck.tsx"),
      "the rewritten wrapper must re-export the DERIVED target and carry the managed marker",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a managed wrapper never hides a broken declaration - declared-missing refuses, wrapper untouched", async () => {
  const root = tmpRoot()
  try {
    // The declaration itself is broken (the declared file is absent). A
    // managed wrapper from an earlier version must not turn that into a
    // silent wire, and must not be rewritten to a target that does not exist.
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), {
      manifest: { name: "widget", version: "1.0.0", exports: { "./tui": "./src/tui/index.tsx" } },
    })
    const wrapperPath = path.join(tree, "tui.tsx")
    fs.writeFileSync(wrapperPath, LEGACY_WRAPPER_CONTENT)
    const cli = writeCli(root, "{}")

    await assert.rejects(
      () => wireTui(tree, cli),
      (e) =>
        e instanceof Error &&
        e.message.includes("[oc-bifrost]") &&
        e.message.includes('"src/tui/index.tsx"') &&
        e.message.includes(tree),
      "a managed wrapper must not mask a declared target that is not a real file",
    )
    assert.equal(fs.readFileSync(wrapperPath, "utf8"), LEGACY_WRAPPER_CONTENT, "a refusal must leave the wrapper untouched")
    assert.equal(fs.readFileSync(cli, "utf8"), "{}", "a refusal must not touch cli.json")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: healing is idempotent - a second pass over a healed tree writes nothing", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), { manifest: { name: "widget", version: "1.0.0" } })
    const wrapperPath = path.join(tree, "tui.tsx")
    fs.writeFileSync(wrapperPath, LEGACY_WRAPPER_CONTENT)
    const entry = pathToFileURL(tree).href
    const cli = writeCli(root, `{\n  "plugins": ["keep-me",\n    ${ENTRY_MARKER}\n    "${entry}"]\n}\n`)

    const first = await wireTui(tree, cli)
    const healed = fs.readFileSync(cli, "utf8")
    const second = await wireTui(tree, cli)

    assert.equal(first.kind, "skipped")
    assert.equal(second.kind, "skipped")
    assert.equal(fs.existsSync(wrapperPath), false, "the wrapper must stay removed")
    assert.equal(fs.readFileSync(cli, "utf8"), healed, "the second pass must not touch cli.json")
    assert.deepEqual(JSON.parse(healed).plugins, ["keep-me"], "only our entry may be removed")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a user-authored tui.tsx is never deleted, even when the tree declares no TUI target", async () => {
  const root = tmpRoot()
  try {
    // No declaration and no src/tui/index.tsx: the derived target is `none`,
    // but a loadable USER file is still the tree's own entry - nothing
    // without our marker is bifrost's to remove (or rewrite).
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), { manifest: { name: "widget", version: "1.0.0" } })
    const wrapperPath = path.join(tree, "tui.tsx")
    const authored = "export default { mount() {} }\n"
    fs.writeFileSync(wrapperPath, authored)
    const cli = writeCli(root, "{}")

    const out = await wireTui(tree, cli)

    assert.equal(out.kind, "wired", "a user-authored loadable entry is still wireable")
    assert.equal(out.wrapper, null, "no wrapper may be written over a user's file")
    assert.equal(fs.readFileSync(wrapperPath, "utf8"), authored, "the user's bytes must survive untouched")
    const registered = JSON.parse(
      fs
        .readFileSync(cli, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n"),
    )
    assert.deepEqual(registered.plugins, [pathToFileURL(tree).href])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a user-authored tui.ts beside a stale managed tui.tsx stays wired - the managed shadow is removed, the user's file untouched", async () => {
  const root = tmpRoot()
  try {
    // A tree that ships a user-authored root tui.ts AND carries a stale
    // managed wrapper from the pre-derive release. The host probes root `tui`
    // by extension, and Bun probes .tsx BEFORE .ts (import.bun.ts:8), so the
    // managed wrapper SHADOWS the user's entry: it must go, the user's file
    // must survive byte-for-byte, and the tree must stay registered.
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), { manifest: { name: "widget", version: "1.0.0" } })
    const userEntry = "export default { mount() {} }\n"
    fs.writeFileSync(path.join(tree, "tui.ts"), userEntry)
    const wrapperPath = path.join(tree, "tui.tsx")
    fs.writeFileSync(wrapperPath, LEGACY_WRAPPER_CONTENT)
    const cli = writeCli(root, '{\n  "verbosity": 2\n}\n')

    const out = await wireTui(tree, cli)

    assert.equal(out.kind, "wired", "a tree with its own user tui.ts must stay wired, never skipped")
    assert.equal(out.wrapper, null, "the user's entry means no wrapper may be written")
    assert.equal(fs.existsSync(wrapperPath), false, "the stale managed wrapper that shadows tui.ts must be removed")
    assert.equal(fs.readFileSync(path.join(tree, "tui.ts"), "utf8"), userEntry, "the user's entry must survive byte-for-byte")
    const entry = pathToFileURL(tree).href
    assert.ok(fs.readFileSync(cli, "utf8").includes(entry), "the tree must stay registered in cli.json")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a single-quoted managed cli.json entry is matched and unwired - and the reported reason is true", async () => {
  const root = tmpRoot()
  try {
    // JSONC accepts single-quoted strings, so a managed entry may be spelled
    // with them. Healing must compare the parsed value: the entry really is
    // unwired, and the skip row may not claim a removal that did not happen.
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), { manifest: { name: "widget", version: "1.0.0" } })
    const wrapperPath = path.join(tree, "tui.tsx")
    fs.writeFileSync(wrapperPath, LEGACY_WRAPPER_CONTENT)
    const entry = pathToFileURL(tree).href
    const cli = writeCli(root, `{\n  "plugins": ["keep-me",\n    ${ENTRY_MARKER}\n    '${entry}']\n}\n`)

    const out = await wireTui(tree, cli)

    assert.equal(out.kind, "skipped")
    assert.equal(fs.existsSync(wrapperPath), false, "the stale managed wrapper must be removed")
    assert.ok(out.reason.includes("unwired the tree"), "the report must state the tree was unwired")
    const after = fs.readFileSync(cli, "utf8")
    assert.ok(!after.includes(entry), "the single-quoted entry must actually be gone - the reason must match reality")
    const surviving = JSON.parse(
      after
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n"),
    )
    assert.deepEqual(surviving.plugins, ["keep-me"], "only the user's entry may remain")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a stale managed wrapper with an empty cli.json removes the wrapper without claiming an unwire that never happened", async () => {
  const root = tmpRoot()
  try {
    // The wrapper is ours to remove, but this cli.json never carried a
    // `plugins` key at all: the skip row may report the wrapper removal,
    // never an unwire that did not occur.
    const tree = writeTuiTree(writeTree(root, { tuiEntry: false }), { manifest: { name: "widget", version: "1.0.0" } })
    const wrapperPath = path.join(tree, "tui.tsx")
    fs.writeFileSync(wrapperPath, LEGACY_WRAPPER_CONTENT)
    const cli = writeCli(root, "{}")

    const out = await wireTui(tree, cli)

    assert.equal(out.kind, "skipped")
    assert.equal(fs.existsSync(wrapperPath), false, "the stale managed wrapper must still be removed")
    assert.ok(out.reason.includes("removed the stale managed tui.tsx"), "the row must report the wrapper removal")
    assert.ok(!out.reason.includes("unwired the tree"), "the row may not claim an unwire when cli.json never registered the tree")
    assert.ok(out.reason.includes("no managed cli.json entry was unwired"), "the row must state the truth about the cli.json side")
    assert.equal(fs.readFileSync(cli, "utf8"), "{}", "cli.json must stay untouched")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: healing one tree unwires only that tree - a second wired tree stays registered", async () => {
  const root = tmpRoot()
  try {
    const treeA = writeTreeAt(path.join(root, "tree-a"))
    const treeB = writeTreeAt(path.join(root, "tree-b"))
    const entryA = pathToFileURL(treeA).href
    const entryB = pathToFileURL(treeB).href
    const cli = writeCli(root, '{\n  "plugins": ["keep-me"]\n}\n')
    await wireTui(treeA, cli)
    await wireTui(treeB, cli)

    // A later snapshot of tree A drops its TUI entry; tree B is unaffected.
    fs.rmSync(path.join(treeA, "src", "tui", "index.tsx"))
    const out = await wireTui(treeA, cli)

    assert.equal(out.kind, "skipped")
    assert.equal(fs.existsSync(path.join(treeA, "tui.tsx")), false, "tree A's managed wrapper must be removed")
    const after = fs.readFileSync(cli, "utf8")
    assert.ok(!after.includes(entryA), "tree A must be unwired")
    assert.ok(after.includes(entryB), "tree B must stay registered")
    assert.equal(after.split(ENTRY_MARKER).length - 1, 1, "only tree B's managed marker may remain")
    const surviving = JSON.parse(
      after
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n"),
    )
    assert.deepEqual(surviving.plugins, ["keep-me", entryB])
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

test("unwireTui: two wired trees in one user-owned plugins array coalesce into a byte-exact restore (regression)", async () => {
  const root = tmpRoot()
  try {
    const treeA = writeTreeAt(path.join(root, "tree-a"))
    const treeB = writeTreeAt(path.join(root, "tree-b"))
    const before = '{\n  "plugins": ["keep-me", "keep-me-2"]\n}\n'
    const cli = writeCli(root, before)
    await wireTui(treeA, cli)
    await wireTui(treeB, cli)
    const wired = fs.readFileSync(cli, "utf8")
    assert.ok(wired.includes(pathToFileURL(treeA).href), "tree A entry must be wired")
    assert.ok(wired.includes(pathToFileURL(treeB).href), "tree B entry must be wired")
    assert.equal(wired.split(ENTRY_MARKER).length - 1, 2, "both owned entries must carry their marker")
    assert.equal(await unwireTui(cli), true)
    assert.equal(
      fs.readFileSync(cli, "utf8"),
      before,
      "two owned entries must unwire to the exact original bytes - overlapping spans must coalesce, not corrupt",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("unwireTui: a user entry added AFTER ours unwires to a parseable array - only ONE separator is ours (M27 regression)", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const entry = pathToFileURL(tree).href
    const cli = writeCli(root, '{\n  "plugins": ["u1","u2"]\n}\n')
    await wireTui(tree, cli)
    // The user appends their own entry after our managed pair. The comma after
    // our entry is now THEIR separator - claiming it (plus the leading one)
    // would splice out both and leave "u2" "u3" (a JSON syntax error).
    fs.writeFileSync(cli, `{\n  "plugins": ["u1","u2",\n    ${ENTRY_MARKER}\n    "${entry}", "u3"\n]\n}\n`)
    assert.equal(await unwireTui(cli), true)
    const after = fs.readFileSync(cli, "utf8")
    assert.deepEqual(JSON.parse(after).plugins, ["u1", "u2", "u3"], "the user's entry must survive and the array must parse")
    assert.equal(after, '{\n  "plugins": ["u1","u2", "u3"\n]\n}\n', "only our own separator may be removed")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("unwireTui: a user entry BETWEEN two of ours unwires to a valid array (coalesced-span regression)", async () => {
  const root = tmpRoot()
  try {
    const treeA = writeTreeAt(path.join(root, "tree-a"))
    const treeB = writeTreeAt(path.join(root, "tree-b"))
    const urlA = pathToFileURL(treeA).href
    const urlB = pathToFileURL(treeB).href
    const cli = writeCli(root, '{\n  "plugins": ["u1","u2"]\n}\n')
    await wireTui(treeA, cli)
    await wireTui(treeB, cli)
    // The user inserts their own entry between our two managed entries.
    fs.writeFileSync(
      cli,
      `{\n  "plugins": ["u1","u2",\n    ${ENTRY_MARKER}\n    "${urlA}", "uX",\n    ${ENTRY_MARKER}\n    "${urlB}"\n]\n}\n`,
    )
    assert.equal(await unwireTui(cli), true)
    const after = fs.readFileSync(cli, "utf8")
    assert.deepEqual(JSON.parse(after).plugins, ["u1", "u2", "uX"], "the user's entry must survive and the array must parse")
    assert.equal(after, '{\n  "plugins": ["u1","u2", "uX"\n]\n}\n')
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

test("wireTui: a splice that would leave a malformed plugins array is refused loudly, writing nothing", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    // The user's file already lacks a separator; any splice keeps it malformed,
    // so the pre-write validation must refuse rather than rewrite.
    const before = '{\n  "plugins": ["a" "b"]\n}\n'
    const cli = writeCli(root, before)
    await assert.rejects(
      () => wireTui(tree, cli),
      (e) => e instanceof Error && e.message.includes("[oc-bifrost]") && e.message.includes(cli),
    )
    assert.equal(fs.readFileSync(cli, "utf8"), before, "a refused splice must never be written")
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