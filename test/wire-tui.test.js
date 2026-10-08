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

/** Parse a cli.json carrying `//`-comment markers by stripping comment lines. */
function readCliJson(cli) {
  return JSON.parse(
    fs
      .readFileSync(cli, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  )
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

/* ---- family prune: re-provisioning a plugin replaces its previous managed entry ---- */

test("wireTui: prune-then-add replaces the previous managed entry for the same plugin family", async () => {
  const root = tmpRoot()
  try {
    const oldTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitA--default-0123456789abcdef", "tree"))
    const newTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-fedcba9876543210", "tree"))
    const otherTree = writeTreeAt(path.join(root, "github", "v2", "other--repo--commitX--default-0011223344556677", "tree"))
    const oldEntry = pathToFileURL(oldTree).href
    const newEntry = pathToFileURL(newTree).href
    const otherEntry = pathToFileURL(otherTree).href
    const before = [
      "{",
      '  "plugins": [',
      '    "keep-me",',
      `    ${ENTRY_MARKER}`,
      `    "${otherEntry}",`,
      `    ${ENTRY_MARKER}`,
      `    "${oldEntry}"`,
      "  ]",
      "}",
      "",
    ].join("\n")
    const cli = writeCli(root, before)

    const out = await wireTui(newTree, cli, { treeFamily: "acme--widget--" })

    assert.equal(out.kind, "wired")
    assert.equal(out.entry, newEntry)
    const after = fs.readFileSync(cli, "utf8")
    const parsed = JSON.parse(
      after
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n"),
    )
    const family = parsed.plugins.filter((p) => typeof p === "string" && p.includes("acme--widget--"))
    assert.equal(family.length, 1, "exactly one acme--widget-- entry may remain")
    assert.equal(family[0], newEntry, "the surviving family entry must be the NEW tree's URL")
    assert.ok(parsed.plugins.includes("keep-me"), "the user entry must survive")
    assert.ok(parsed.plugins.includes(otherEntry), "the other plugin's managed entry must survive")
    assert.ok(
      after.includes(`${ENTRY_MARKER}\n    "${otherEntry}"`),
      "the other plugin's managed marker+entry block must be byte-intact",
    )
    assert.equal(after.split(ENTRY_MARKER).length - 1, 2, "only the other plugin's and the new managed markers may remain")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a user (unmarked) entry inside the family is never pruned", async () => {
  const root = tmpRoot()
  try {
    const oldTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitA--default-digestA", "tree"))
    const newTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-digestB", "tree"))
    const oldEntry = pathToFileURL(oldTree).href
    const newEntry = pathToFileURL(newTree).href
    const before = `{\n  "plugins": ["${oldEntry}"]\n}\n`
    const cli = writeCli(root, before)

    await wireTui(newTree, cli, { treeFamily: "acme--widget--" })

    const after = fs.readFileSync(cli, "utf8")
    assert.ok(after.includes(oldEntry), "a user entry in the family must never be claimed")
    assert.ok(after.includes(newEntry), "the new managed entry must be added")
    const parsed = JSON.parse(
      after
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n"),
    )
    assert.deepEqual(parsed.plugins, [oldEntry, newEntry])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: dedupes the new entry by parsed value - a single-quoted copy is not duplicated", async () => {
  const root = tmpRoot()
  try {
    const newTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-digestB", "tree"))
    const newEntry = pathToFileURL(newTree).href
    const before = `{\n  "plugins": ['${newEntry}']\n}\n`
    const cli = writeCli(root, before)

    await wireTui(newTree, cli, { treeFamily: "acme--widget--" })

    const after = fs.readFileSync(cli, "utf8")
    assert.equal(after, before, "an exact entry in any spelling must dedupe, writing no second copy")
    assert.equal(after.split(newEntry).length - 1, 1, "exactly one copy of the entry may exist")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- identity in the marker: keyed prune + guarded legacy fallback ---- */

test("wireTui: a repo whose name extends another's (widget vs widget--extra) is never pruned", async () => {
  const root = tmpRoot()
  try {
    // The blocking counterexample: `acme--widget--extra--...` CONTAINS the
    // family `acme--widget--`, so a raw substring test would delete the
    // different plugin's managed entry. The `--`-segment guard must reject it.
    const extraTree = writeTreeAt(
      path.join(root, "github", "v2", "acme--widget--extra--commitX--default-digestX", "tree"),
    )
    const newTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-digestB", "tree"))
    const extraEntry = pathToFileURL(extraTree).href
    const newEntry = pathToFileURL(newTree).href
    const before = `{\n  "plugins": [\n    ${ENTRY_MARKER}\n    "${extraEntry}"\n  ]\n}\n`
    const cli = writeCli(root, before)

    await wireTui(newTree, cli, { treeFamily: "acme--widget--", pluginKey: "keyWidget" })

    const after = fs.readFileSync(cli, "utf8")
    assert.ok(after.includes(extraEntry), "the other plugin's managed entry must SURVIVE")
    assert.ok(
      after.includes(`${ENTRY_MARKER}\n    "${extraEntry}"`),
      "the other plugin's managed marker+entry block must be byte-intact",
    )
    assert.ok(after.includes(newEntry), "the new plugin's entry must be added")
    assert.deepEqual(readCliJson(cli).plugins, [extraEntry, newEntry], "exactly the other entry and the new entry")
    assert.ok(after.includes(`[keyWidget]`), "the new entry must carry its key")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: keyed replacement - a second mount at a new cache dir with the same key leaves exactly one entry", async () => {
  const root = tmpRoot()
  try {
    const treeA = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitA--default-digestA", "tree"))
    const treeB = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-digestB", "tree"))
    const entryA = pathToFileURL(treeA).href
    const entryB = pathToFileURL(treeB).href
    const cli = writeCli(root, "{}")

    await wireTui(treeA, cli, { treeFamily: "acme--widget--", pluginKey: "keyWidget" })
    const afterFirst = fs.readFileSync(cli, "utf8")
    assert.ok(afterFirst.includes(entryA))
    assert.ok(afterFirst.includes(`[keyWidget]`), "the first entry must carry the key")

    await wireTui(treeB, cli, { treeFamily: "acme--widget--", pluginKey: "keyWidget" })

    const parsed = readCliJson(cli)
    assert.deepEqual(parsed.plugins, [entryB], "exactly one entry may remain - the new URL")
    const after = fs.readFileSync(cli, "utf8")
    assert.ok(!after.includes(entryA), "the old URL must be pruned by exact key")
    assert.equal(after.split(`[keyWidget]`).length - 1, 1, "exactly one keyed marker may remain")

    // A keyed entry is still removable by the unchanged unwire semantics.
    assert.equal(await unwireTui(cli), true)
    assert.deepEqual(readCliJson(cli), {}, "untargeted unwire must remove the keyed entry and its created key")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a keyless legacy flight-deck entry at a changed ref is pruned (exact-shape fallback)", async () => {
  const root = tmpRoot()
  try {
    const treeA = writeTreeAt(
      path.join(root, "github", "v2", "nathwn12--oc-flight-deck--commitA--src-index.ts-0123456789abcdef", "tree"),
    )
    const treeB = writeTreeAt(
      path.join(root, "github", "v2", "nathwn12--oc-flight-deck--commitB--src-index.ts-fedcba9876543210", "tree"),
    )
    const entryA = pathToFileURL(treeA).href
    const entryB = pathToFileURL(treeB).href
    const before = `{\n  "plugins": [\n    ${ENTRY_MARKER}\n    "${entryA}"\n  ]\n}\n`
    const cli = writeCli(root, before)

    await wireTui(treeB, cli, { treeFamily: "nathwn12--oc-flight-deck--", pluginKey: "keyDeck" })

    const parsed = readCliJson(cli)
    assert.deepEqual(parsed.plugins, [entryB], "the stale keyless entry must be pruned and replaced")
    assert.ok(!fs.readFileSync(cli, "utf8").includes(entryA), "the commitA URL must be gone")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a keyed entry is pruned by exact key even when the family is absent from the URL (long owner+repo truncation)", async () => {
  const root = tmpRoot()
  try {
    // The 96-char slice in githubCacheId can drop the owner--repo family from
    // the cache-dir name entirely. A keyless fallback could then never match;
    // a KEYED block is claimed by exact key, with no URL test at all.
    const oldTree = writeTreeAt(path.join(root, "unrelated-cache-name-a", "tree"))
    const newTree = writeTreeAt(path.join(root, "unrelated-cache-name-b", "tree"))
    const oldEntry = pathToFileURL(oldTree).href
    const newEntry = pathToFileURL(newTree).href
    assert.ok(!oldEntry.includes("/verylongowner--verylongrepo--"), "the fixture deliberately omits the family")
    const before = `{\n  "plugins": [\n    ${ENTRY_MARKER} [keyLong]\n    "${oldEntry}"\n  ]\n}\n`
    const cli = writeCli(root, before)

    await wireTui(newTree, cli, { treeFamily: "verylongowner--verylongrepo--", pluginKey: "keyLong" })

    assert.deepEqual(readCliJson(cli).plugins, [newEntry], "the stale keyed entry must be pruned by key alone")
    assert.ok(!fs.readFileSync(cli, "utf8").includes(oldEntry))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a keyed entry with a DIFFERENT key is never pruned, even in the same family", async () => {
  const root = tmpRoot()
  try {
    const otherTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitX--default-digestX", "tree"))
    const newTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-digestB", "tree"))
    const otherEntry = pathToFileURL(otherTree).href
    const newEntry = pathToFileURL(newTree).href
    const before = `{\n  "plugins": [\n    ${ENTRY_MARKER} [keyOther]\n    "${otherEntry}"\n  ]\n}\n`
    const cli = writeCli(root, before)

    await wireTui(newTree, cli, { treeFamily: "acme--widget--", pluginKey: "keyWidget" })

    const after = fs.readFileSync(cli, "utf8")
    assert.ok(after.includes(otherEntry), "a differently-keyed managed entry must never be claimed")
    assert.ok(after.includes(`${ENTRY_MARKER} [keyOther]`), "the other key's marker must survive")
    assert.deepEqual(readCliJson(cli).plugins, [otherEntry, newEntry])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: with neither pluginKey nor treeFamily (or empty strings) nothing is pruned", async () => {
  const root = tmpRoot()
  try {
    const oldTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitA--default-digestA", "tree"))
    const newTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-digestB", "tree"))
    const oldEntry = pathToFileURL(oldTree).href
    const newEntry = pathToFileURL(newTree).href
    const seed = `{\n  "plugins": [\n    ${ENTRY_MARKER}\n    "${oldEntry}"\n  ]\n}\n`

    const absent = writeCli(path.join(root, "absent"), seed)
    await wireTui(newTree, absent)
    assert.deepEqual(readCliJson(absent).plugins, [oldEntry, newEntry], "without identity opts the old entry stays")

    const empty = writeCli(path.join(root, "empty"), seed)
    await wireTui(newTree, empty, { treeFamily: "", pluginKey: "" })
    assert.deepEqual(readCliJson(empty).plugins, [oldEntry, newEntry], 'empty "" identity must not degrade to includes("/")')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: writes the keyed managed marker, and created keys carry the key too (golden)", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTree(root)
    const entry = pathToFileURL(tree).href
    const key = "abc123def456abcd"

    const existing = writeCli(path.join(root, "existing"), '{\n  "plugins": ["keep-me"]\n}\n')
    await wireTui(tree, existing, { treeFamily: "acme--widget--", pluginKey: key })
    assert.equal(
      fs.readFileSync(existing, "utf8"),
      `{\n  "plugins": ["keep-me",\n    ${ENTRY_MARKER} [${key}]\n    "${entry}"]\n}\n`,
      "an appended entry must carry the keyed marker",
    )

    const created = writeCli(path.join(root, "created"), "{}\n")
    await wireTui(tree, created, { treeFamily: "acme--widget--", pluginKey: key })
    assert.equal(
      fs.readFileSync(created, "utf8"),
      `{\n  "plugins": [\n    ${CREATED_KEY_MARKER}\n    ${ENTRY_MARKER} [${key}]\n    "${entry}"\n  ]}\n`,
      "an auto-created key must still carry the keyed entry marker",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("unwireTui: a legacy bare-marker entry unwires both targeted and untargeted", async () => {
  const root = tmpRoot()
  try {
    const treeA = writeTreeAt(path.join(root, "tree-a"))
    const treeB = writeTreeAt(path.join(root, "tree-b"))
    const entryA = pathToFileURL(treeA).href
    const entryB = pathToFileURL(treeB).href
    const cli = writeCli(
      root,
      `{\n  "plugins": ["keep-me",\n    ${ENTRY_MARKER}\n    "${entryA}",\n    ${ENTRY_MARKER}\n    "${entryB}"]\n}\n`,
    )

    assert.equal(await unwireTui(cli, entryA), true, "targeted unwire must remove the bare entry it names")
    const targeted = fs.readFileSync(cli, "utf8")
    assert.ok(!targeted.includes(entryA), "the named bare entry must be gone")
    assert.ok(targeted.includes(entryB), "the other bare entry must survive a targeted unwire")

    assert.equal(await unwireTui(cli), true, "untargeted unwire must remove the remaining bare entry")
    assert.deepEqual(readCliJson(cli).plugins, ["keep-me"], "untargeted unwire removes every managed entry")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- idempotence: a repeat wire must never re-claim the entry it just wrote ---- */

test("wireTui: a second wire with the same tree and key writes nothing (idempotent)", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-fedcba9876543210", "tree"))
    const cli = writeCli(root, '{\n  "plugins": ["keep-me"]\n}\n')
    await wireTui(tree, cli, { treeFamily: "acme--widget--", pluginKey: "keyW" })
    const once = fs.readFileSync(cli, "utf8")

    await wireTui(tree, cli, { treeFamily: "acme--widget--", pluginKey: "keyW" })

    assert.equal(fs.readFileSync(cli, "utf8"), once, "a repeat wire must not churn bytes (no prune+re-add)")
    assert.equal(once.split(`[keyW]`).length - 1, 1, "the entry must not be duplicated")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a second wire into the auto-created-key shape is byte-stable", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-fedcba9876543210", "tree"))
    const cli = writeCli(root, "{}\n")
    await wireTui(tree, cli, { treeFamily: "acme--widget--", pluginKey: "keyW" })
    const once = fs.readFileSync(cli, "utf8")
    assert.ok(once.includes(CREATED_KEY_MARKER), "the auto-created-key shape must be in place")
    assert.ok(once.includes(`[keyW]`), "the auto-created entry must carry the keyed marker")

    await wireTui(tree, cli, { treeFamily: "acme--widget--", pluginKey: "keyW" })

    assert.equal(fs.readFileSync(cli, "utf8"), once, "the auto-created-key shape must not churn on a repeat wire")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a repeat wire keeps a managed entry at the array head in place", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-fedcba9876543210", "tree"))
    const entry = pathToFileURL(tree).href
    const seeded = `{\n  "plugins": [\n    ${ENTRY_MARKER} [keyW]\n    "${entry}",\n    "user-after"\n  ]\n}\n`
    const cli = writeCli(root, seeded)

    await wireTui(tree, cli, { treeFamily: "acme--widget--", pluginKey: "keyW" })

    assert.equal(fs.readFileSync(cli, "utf8"), seeded, "the head entry must keep its position with no churn")
    assert.deepEqual(readCliJson(cli).plugins, [entry, "user-after"], "the head entry must remain first")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- keyless fallback: exact canonical shape, never a segment count ---- */

test("wireTui: a widget@x--y (ref with --) never claims a widget--extra legacy entry", async () => {
  const root = tmpRoot()
  try {
    // Both names split to 5 segments, so a bare segment-count rule would
    // claim the unrelated plugin. The canonical-shape rule sees ours != 4 and
    // skips the fallback entirely.
    const newTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--x--y--default-fedcba9876543210", "tree"))
    const otherTree = writeTreeAt(
      path.join(root, "github", "v2", "acme--widget--extra--default--default-0011223344556677", "tree"),
    )
    const newEntry = pathToFileURL(newTree).href
    const otherEntry = pathToFileURL(otherTree).href
    const cli = writeCli(root, `{\n  "plugins": [\n    ${ENTRY_MARKER}\n    "${otherEntry}"\n  ]\n}\n`)

    await wireTui(newTree, cli, { treeFamily: "acme--widget--", pluginKey: "keyW" })

    const after = fs.readFileSync(cli, "utf8")
    assert.ok(after.includes(otherEntry), "the different plugin's legacy entry must SURVIVE")
    assert.ok(after.includes(newEntry), "the new entry must be added")
    assert.deepEqual(readCliJson(cli).plugins, [otherEntry, newEntry])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a 5-segment (non-canonical) legacy name is never claimed", async () => {
  const root = tmpRoot()
  try {
    const newTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-fedcba9876543210", "tree"))
    const legacyTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--x--y--default-0123456789abcdef", "tree"))
    const newEntry = pathToFileURL(newTree).href
    const legacyEntry = pathToFileURL(legacyTree).href
    const cli = writeCli(root, `{\n  "plugins": [\n    ${ENTRY_MARKER}\n    "${legacyEntry}"\n  ]\n}\n`)

    await wireTui(newTree, cli, { treeFamily: "acme--widget--", pluginKey: "keyW" })

    const after = fs.readFileSync(cli, "utf8")
    assert.ok(after.includes(legacyEntry), "a 5-segment legacy name must never be claimed")
    assert.ok(after.includes(newEntry))
    assert.deepEqual(readCliJson(cli).plugins, [legacyEntry, newEntry])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: degenerate treeFamily ('/' and '--') with no key prunes nothing", async () => {
  const root = tmpRoot()
  try {
    const newTree = writeTreeAt(path.join(root, "github", "v2", "acme--widget--commitB--default-fedcba9876543210", "tree"))
    const otherTree = writeTreeAt(path.join(root, "github", "v2", "other--repo--commitX--default-0011223344556677", "tree"))
    const otherEntry = pathToFileURL(otherTree).href
    const seed = `{\n  "plugins": [\n    ${ENTRY_MARKER}\n    "${otherEntry}"\n  ]\n}\n`

    // "/" makes `value.includes("/" + treeFamily)` true for every file URL, so
    // the shape gate is the only thing standing between it and a wrong claim.
    const slash = writeCli(path.join(root, "slash"), seed)
    await wireTui(newTree, slash, { treeFamily: "/" })
    assert.ok(fs.readFileSync(slash, "utf8").includes(otherEntry), "'/' must not prune an unrelated managed entry")

    const dashes = writeCli(path.join(root, "dashes"), seed)
    await wireTui(newTree, dashes, { treeFamily: "--" })
    assert.ok(fs.readFileSync(dashes, "utf8").includes(otherEntry), "'--' must not prune an unrelated managed entry")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- server entry ---- */

const SERVER_WRAPPER_MARKER = "// oc-bifrost: managed server entry"

/** The managed root index.ts body this module writes for a tree-relative server target. */
function serverWrapperFor(target) {
  return `${SERVER_WRAPPER_MARKER}\nexport { default } from "./${target}";\n`
}

/** A tree with a TUI entry AND a server entry file at `serverRel`. */
function writeServerTree(root, serverRel = "src/index.ts") {
  const tree = writeTree(root)
  const entry = path.join(tree, ...serverRel.split("/"))
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, 'export default { id: "widget.host" }\n')
  return tree
}

test("wireTui: with opts.serverEntry writes a managed root index.ts re-exporting the declared entry", async () => {
  const root = tmpRoot()
  try {
    const tree = writeServerTree(root)
    const cli = writeCli(root, "{}")
    const out = await wireTui(tree, cli, { serverEntry: "src/index.ts" })
    assert.equal(out.kind, "wired")
    assert.equal(out.serverEntry, path.join(tree, "index.ts"))
    assert.equal(
      fs.readFileSync(path.join(tree, "index.ts"), "utf8"),
      serverWrapperFor("src/index.ts"),
      "the server wrapper must re-export the ref's DECLARED entry file, not a hardcoded path",
    )
    assert.equal(out.wrapper, path.join(tree, "tui.tsx"), "the TUI wrapper behavior must be intact")
    assert.ok(
      readCliJson(cli).plugins.includes(pathToFileURL(tree).href),
      "the tree root registration must be intact",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: the server-entry wrapper is idempotent", async () => {
  const root = tmpRoot()
  try {
    const tree = writeServerTree(root)
    const cli = writeCli(root, "{}")
    await wireTui(tree, cli, { serverEntry: "src/index.ts" })
    const again = await wireTui(tree, cli, { serverEntry: "src/index.ts" })
    assert.equal(again.serverEntry, null, "a repeat mount must report no new server wrapper")
    assert.equal(fs.readFileSync(path.join(tree, "index.ts"), "utf8"), serverWrapperFor("src/index.ts"))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: without opts.serverEntry no root index.ts is written", async () => {
  const root = tmpRoot()
  try {
    const tree = writeServerTree(root)
    const cli = writeCli(root, "{}")
    const out = await wireTui(tree, cli)
    assert.equal(out.serverEntry, null)
    assert.equal(fs.existsSync(path.join(tree, "index.ts")), false, "existing TUI-only behavior must be intact")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a user-authored root index.ts is never clobbered", async () => {
  const root = tmpRoot()
  try {
    const tree = writeServerTree(root)
    fs.writeFileSync(path.join(tree, "index.ts"), "export default { id: \"user.widget\" }\n")
    const cli = writeCli(root, "{}")
    const out = await wireTui(tree, cli, { serverEntry: "src/index.ts" })
    assert.equal(out.serverEntry, null)
    assert.equal(
      fs.readFileSync(path.join(tree, "index.ts"), "utf8"),
      "export default { id: \"user.widget\" }\n",
      "a user server entry must survive byte-for-byte",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a managed server wrapper is removed when a user entry appears beside it", async () => {
  const root = tmpRoot()
  try {
    const tree = writeServerTree(root)
    const cli = writeCli(root, "{}")
    await wireTui(tree, cli, { serverEntry: "src/index.ts" })
    assert.equal(fs.existsSync(path.join(tree, "index.ts")), true)
    fs.writeFileSync(path.join(tree, "plugin.ts"), "export default { id: \"user.widget\" }\n")
    const out = await wireTui(tree, cli, { serverEntry: "src/index.ts" })
    assert.equal(out.kind, "wired", "the TUI half must keep working")
    assert.equal(fs.existsSync(path.join(tree, "index.ts")), false, "our wrapper must never shadow a user entry")
    assert.equal(
      fs.readFileSync(path.join(tree, "plugin.ts"), "utf8"),
      "export default { id: \"user.widget\" }\n",
      "the user entry must survive byte-for-byte",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a declared server entry naming no real file refuses loudly", async () => {
  const root = tmpRoot()
  try {
    const tree = writeServerTree(root)
    const cli = writeCli(root, "{}")
    await assert.rejects(
      () => wireTui(tree, cli, { serverEntry: "src/missing.ts" }),
      /\[oc-bifrost\] refusing to create server-entry wrapper/,
      "a broken declaration must refuse, never guess",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: the skip path writes no server wrapper", async () => {
  const root = tmpRoot()
  try {
    const tree = writeTreeAt(path.join(root, "tree"), { tuiEntry: false })
    const entry = path.join(tree, "src", "index.ts")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, "export default {}\n")
    const cli = writeCli(root, "{}")
    const out = await wireTui(tree, cli, { serverEntry: "src/index.ts" })
    assert.equal(out.kind, "skipped", "a tree with no TUI entry is never registered")
    assert.equal(fs.existsSync(path.join(tree, "index.ts")), false, "an unregistered tree needs no server entry")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})