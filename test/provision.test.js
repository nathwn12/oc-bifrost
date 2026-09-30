import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { missingDeps, provisionTree } from "../dist/provision.js"

/**
 * provision: - materialize a fetched tree's declared dependencies into its
 * own node_modules, host-store-first (junction, zero network), with an npm
 * fallback that is spawned, never imported.
 *
 *   - host-store junction: a declared dep found in a host store is linked
 *     into <tree>/node_modules/<name> as a junction (Windows) / symlink
 *     (elsewhere); dryRun records the action but writes nothing
 *   - npm fallback: deps with no host-store hit are installed with
 *     `npm install --no-save --legacy-peer-deps --prefix <tree>` when opts.npm
 *     is true; a failing install refuses the package (report semantics -
 *     never thrown)
 *   - idempotence: an already-present node_modules entry records "skip"
 *   - no manifest: returns { actions: [], refused: [] } silently
 *   - OpenCode npm-cache layout: scoped/unscoped deps resolve from
 *     `<store>/<name>@<version>/<cacheId>/node_modules/<name>`, newest version
 *     preferred - including a dep hoisted into ANOTHER package's versioned
 *     install root (the live flight-deck peers)
 *
 * All offline: the npm surface is a fake executable on PATH; host stores and
 * trees live in tmp dirs.
 */

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-provision-test-"))
}

/** Write a tree with an optional package.json and an optional entry file. */
function writeTree(treeDir, { packageJson, entryFile = "index.js", entryContent = "" } = {}) {
  fs.mkdirSync(treeDir, { recursive: true })
  if (packageJson !== undefined) {
    fs.writeFileSync(path.join(treeDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`)
  }
  if (entryContent !== "") {
    fs.writeFileSync(path.join(treeDir, entryFile), entryContent)
  }
  return treeDir
}

/** Materialize a real directory tree at `storeRoot/<pkgPath>` (a fake host-store package). */
function writePackage(storeRoot, pkgPath, files) {
  const dir = path.join(storeRoot, pkgPath)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

/** A fake `npm` on PATH: writes a marker + its args, then exits with `exitCode`. */
function installFakeNpm(shimDir, { marker, argsFile, exitCode = 0 }) {
  fs.mkdirSync(shimDir, { recursive: true })
  if (process.platform === "win32") {
    const content = [
      "@echo off",
      `echo invoked > "${marker}"`,
      `echo %* > "${argsFile}"`,
      `exit /b ${exitCode}`,
      "",
    ].join("\r\n")
    fs.writeFileSync(path.join(shimDir, "npm.cmd"), content)
  } else {
    const content =
      `#!/bin/sh\n` +
      `printf 'invoked\\n' > "${marker}"\n` +
      `printf '%s\\n' "$*" > "${argsFile}"\n` +
      `exit ${exitCode}\n`
    fs.writeFileSync(path.join(shimDir, "npm"), content, { mode: 0o755 })
  }
}

/** Prepend shimDir to PATH for the duration of `fn`, restoring afterwards. */
async function withPath(shimDir, fn) {
  const saved = process.env.PATH
  process.env.PATH = shimDir + path.delimiter + (saved ?? "")
  try {
    return await fn()
  } finally {
    process.env.PATH = saved
  }
}

/* ---- host-store junction (the proven live mechanism) ---- */

test("provisionTree: a host-store package is junctioned into the tree (zero network)", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "@acme/peer": "1.0.0" } } })
    const store = path.join(root, "store")
    const source = writePackage(store, "node_modules/@acme/peer", {
      "package.json": JSON.stringify({ name: "@acme/peer", version: "1.0.0" }),
      "index.js": "export default 1\n",
    })

    const report = await provisionTree(tree, { hostStores: [store] })

    assert.deepEqual(report.actions, [{ package: "@acme/peer", source: "host", target: source }])
    assert.deepEqual(report.refused, [])
    const dest = path.join(tree, "node_modules", "@acme", "peer")
    const stats = fs.lstatSync(dest)
    assert.equal(stats.isSymbolicLink(), true, "the provisioned dep must be a link (junction on Windows)")
    assert.equal(
      fs.readFileSync(path.join(dest, "package.json"), "utf8"),
      JSON.stringify({ name: "@acme/peer", version: "1.0.0" }),
      "the tree-local path must resolve through the junction to the host package",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: a flat host store (package directly at <store>/<name>) is junctioned", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "@scope/peer": "1.0.0" } } })
    const store = path.join(root, "store")
    // Layout (a): the store IS a flat package dir - no node_modules segment,
    // scoped packages nest directly under <store>/@scope/.
    const source = writePackage(store, "@scope/peer", {
      "package.json": JSON.stringify({ name: "@scope/peer", version: "1.0.0" }),
      "index.js": "export default 1\n",
    })

    const report = await provisionTree(tree, { hostStores: [store] })

    assert.deepEqual(report.actions, [{ package: "@scope/peer", source: "host", target: source }])
    assert.deepEqual(report.refused, [])
    assert.equal(
      fs.readFileSync(path.join(tree, "node_modules", "@scope", "peer", "package.json"), "utf8"),
      JSON.stringify({ name: "@scope/peer", version: "1.0.0" }),
      "the junction must resolve through to the flat-layout package",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: dryRun records the host action but creates nothing", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "@acme/peer": "1.0.0" } } })
    const store = path.join(root, "store")
    writePackage(store, "node_modules/@acme/peer", { "package.json": JSON.stringify({ name: "@acme/peer", version: "1.0.0" }) })

    const report = await provisionTree(tree, { hostStores: [store], dryRun: true })

    assert.equal(report.actions.length, 1)
    assert.equal(report.actions[0].source, "host")
    assert.equal(fs.existsSync(path.join(tree, "node_modules")), false, "dryRun must write nothing")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: resolves a scoped dep from the OpenCode npm-cache layout, preferring the newest version", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "@scope/peer": "1.0.0" } } })
    const store = path.join(root, "store")
    writePackage(store, "@scope/peer@1.0.0/111/node_modules/@scope/peer", { "package.json": JSON.stringify({ name: "@scope/peer", version: "1.0.0" }) })
    const newest = writePackage(store, "@scope/peer@2.0.0/222/node_modules/@scope/peer", { "package.json": JSON.stringify({ name: "@scope/peer", version: "2.0.0" }) })

    const report = await provisionTree(tree, { hostStores: [store] })

    assert.deepEqual(report.actions, [{ package: "@scope/peer", source: "host", target: newest }])
    assert.equal(
      fs.readFileSync(path.join(tree, "node_modules", "@scope", "peer", "package.json"), "utf8"),
      JSON.stringify({ name: "@scope/peer", version: "2.0.0" }),
      "the junction must point at the newest version",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: resolves an UNscoped dep from the OpenCode npm-cache layout", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.0.0" } } })
    const store = path.join(root, "store")
    const source = writePackage(store, "left-pad@1.0.0/111/node_modules/left-pad", { "package.json": JSON.stringify({ name: "left-pad", version: "1.0.0" }) })

    const report = await provisionTree(tree, { hostStores: [store] })

    assert.deepEqual(report.actions, [{ package: "left-pad", source: "host", target: source }])
    assert.equal(
      fs.readFileSync(path.join(tree, "node_modules", "left-pad", "package.json"), "utf8"),
      JSON.stringify({ name: "left-pad", version: "1.0.0" }),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: resolves a dep HOISTED inside another package's npm-cache install root (the live layout)", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, {
      packageJson: {
        name: "fixture",
        version: "1.0.0",
        dependencies: { "@opencode/plugin": "2.0.19" },
        peerDependencies: { "solid-js": ">=1.9.0" },
      },
    })
    const store = path.join(root, "store")
    // The live OpenCode npm cache: a package's own versioned install root
    // carries its hoisted dependency graph. The peers have NO root of their
    // own (`<store>/@opencode/plugin@...` does not exist) - they live only under
    // the install root of the package that depends on them.
    const scoped = writePackage(store, "oc-flight-deck@0.9.0/1790770553595/node_modules/@opencode/plugin", {
      "package.json": JSON.stringify({ name: "@opencode/plugin", version: "2.0.19" }),
      "index.js": "export default 1\n",
    })
    const unscoped = writePackage(store, "oc-flight-deck@0.9.0/1790770553595/node_modules/solid-js", {
      "package.json": JSON.stringify({ name: "solid-js", version: "1.9.15" }),
      "index.js": "export default 1\n",
    })

    const report = await provisionTree(tree, { hostStores: [store] })

    assert.deepEqual(report.actions, [
      { package: "@opencode/plugin", source: "host", target: scoped },
      { package: "solid-js", source: "host", target: unscoped },
    ])
    assert.deepEqual(report.refused, [])
    assert.equal(fs.lstatSync(path.join(tree, "node_modules", "@opencode", "plugin")).isSymbolicLink(), true)
    assert.equal(
      fs.readFileSync(path.join(tree, "node_modules", "solid-js", "package.json"), "utf8"),
      JSON.stringify({ name: "solid-js", version: "1.9.15" }),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: resolves a dep from a SCOPED package's npm-cache install root", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "@opentui/core": "0.5.12" } } })
    const store = path.join(root, "store")
    const source = writePackage(store, "@scope/host@1.2.0/abc/node_modules/@opentui/core", {
      "package.json": JSON.stringify({ name: "@opentui/core", version: "0.5.12" }),
    })

    const report = await provisionTree(tree, { hostStores: [store] })

    assert.deepEqual(report.actions, [{ package: "@opentui/core", source: "host", target: source }])
    assert.deepEqual(report.refused, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: an @latest alias dir does not beat a pinned numeric version", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.0.0" } } })
    const store = path.join(root, "store")
    writePackage(store, "left-pad@latest/999/node_modules/left-pad", { "package.json": JSON.stringify({ name: "left-pad", version: "9.9.9" }) })
    const pinned = writePackage(store, "left-pad@1.0.0/111/node_modules/left-pad", { "package.json": JSON.stringify({ name: "left-pad", version: "1.0.0" }) })

    const report = await provisionTree(tree, { hostStores: [store] })

    assert.deepEqual(report.actions, [{ package: "left-pad", source: "host", target: pinned }])
    assert.equal(
      fs.readFileSync(path.join(tree, "node_modules", "left-pad", "package.json"), "utf8"),
      JSON.stringify({ name: "left-pad", version: "1.0.0" }),
      "the numeric pinned version must win over the stale @latest alias",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: a hostile dep name (traversal) is refused and writes nothing outside node_modules", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, {
      packageJson: { name: "fixture", version: "1.0.0", dependencies: { "..": "1.0.0", "../../victim": "1.0.0" } },
    })
    const store = path.join(root, "store")
    writePackage(store, "node_modules/victim", { "package.json": JSON.stringify({ name: "victim", version: "1.0.0" }) })

    const report = await provisionTree(tree, { hostStores: [store] })

    assert.deepEqual(report.actions, [])
    assert.deepEqual(report.refused, ["..", "../../victim"])
    assert.equal(fs.existsSync(path.join(tree, "node_modules")), false, "no node_modules may be created for a hostile name")
    assert.equal(fs.existsSync(path.join(root, "victim")), false, "nothing may be written outside the tree's node_modules")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: a host-store link failure refuses the package without throwing", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.0.0" } } })
    const store = path.join(root, "store")
    writePackage(store, "node_modules/left-pad", { "package.json": JSON.stringify({ name: "left-pad", version: "1.0.0" }) })
    // Sabotage the destination: plant a regular FILE where `node_modules` must
    // be created, so the mkdir step in the link throws.
    fs.writeFileSync(path.join(tree, "node_modules"), "not a directory")

    const report = await provisionTree(tree, { hostStores: [store] })

    assert.deepEqual(report.actions, [])
    assert.deepEqual(report.refused, ["left-pad"])
    assert.equal(fs.existsSync(path.join(tree, "left-pad")), false, "nothing may be written outside node_modules")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: an already-provisioned dep is skipped and left untouched", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "@acme/peer": "1.0.0" } } })
    const store = path.join(root, "store")
    writePackage(store, "node_modules/@acme/peer", { "package.json": JSON.stringify({ name: "@acme/peer", version: "1.0.0" }) })

    await provisionTree(tree, { hostStores: [store] })
    const dest = path.join(tree, "node_modules", "@acme", "peer")
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), true, "first pass must junction the dep")

    const second = await provisionTree(tree, { hostStores: [store] })
    assert.deepEqual(second.actions, [{ package: "@acme/peer", source: "skip", target: dest }])
    assert.deepEqual(second.refused, [])
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), true, "the junction must be untouched by a later call")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: a tree without a package.json is skipped silently", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { entryFile: "plugin.ts", entryContent: "export default { id: 'x', setup() {} }\n" })
    const report = await provisionTree(tree, { hostStores: [path.join(root, "store")], npm: true })
    assert.deepEqual(report, { actions: [], refused: [] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- npm fallback ---- */

test("provisionTree: npm fallback spawns `npm install --no-save --prefix <tree>`", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.0.0" } } })
    const shimDir = path.join(root, "bin")
    const marker = path.join(root, "npm-marker.txt")
    const argsFile = path.join(root, "npm-args.txt")
    installFakeNpm(shimDir, { marker, argsFile, exitCode: 0 })

    const report = await withPath(shimDir, () => provisionTree(tree, { npm: true }))

    assert.equal(fs.existsSync(marker), true, "the fake npm must have been invoked")
    assert.equal(fs.readFileSync(argsFile, "utf8").trim(), `install --no-save --legacy-peer-deps --prefix ${tree}`)
    assert.equal(report.actions.length, 1)
    assert.deepEqual(
      { package: report.actions[0].package, source: report.actions[0].source },
      { package: "left-pad", source: "npm" },
    )
    assert.deepEqual(report.refused, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("provisionTree: a failing npm install refuses the package without throwing", async () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, { packageJson: { name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.0.0" } } })
    const shimDir = path.join(root, "bin")
    const marker = path.join(root, "npm-marker.txt")
    const argsFile = path.join(root, "npm-args.txt")
    installFakeNpm(shimDir, { marker, argsFile, exitCode: 1 })

    const report = await withPath(shimDir, () => provisionTree(tree, { npm: true }))

    assert.equal(fs.existsSync(marker), true, "npm must have been attempted")
    assert.deepEqual(report.actions, [])
    assert.deepEqual(report.refused, ["left-pad"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- missingDeps ---- */

test("missingDeps: lists a bare specifier the entry imports that the tree cannot resolve", () => {
  const root = tmpRoot()
  try {
    const tree = path.join(root, "tree")
    writeTree(tree, {
      packageJson: { name: "fixture", version: "1.0.0", main: "index.js" },
      entryContent:
        'import "@acme/missing"\nimport "./local.js"\nimport { join } from "node:path"\nexport const ok = 1\n',
    })
    assert.deepEqual(missingDeps(tree), ["@acme/missing"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
