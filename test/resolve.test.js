import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { githubCacheRoot, resolveSpec } from "../dist/index.js"
import { defaultHostStoreRoot } from "../dist/github.js"

const DIR = path.resolve("some", "session", "dir")

/* ---- regression surface: every input that worked in 0.1.0 ---- */

test("resolveSpec: absolute path becomes a file URL (regression)", () => {
  const abs = path.resolve(os.tmpdir(), "plugin.ts")
  assert.deepEqual(resolveSpec(abs, DIR), { kind: "module", url: pathToFileURL(abs).href })
})

test("resolveSpec: ./ resolves against the session directory (regression)", () => {
  assert.deepEqual(resolveSpec("./x/y.ts", DIR), {
    kind: "module",
    url: pathToFileURL(path.resolve(DIR, "./x/y.ts")).href,
  })
})

test("resolveSpec: ../ resolves against the session directory (regression)", () => {
  assert.deepEqual(resolveSpec("../shared/y.ts", DIR), {
    kind: "module",
    url: pathToFileURL(path.resolve(DIR, "../shared/y.ts")).href,
  })
})

test("resolveSpec: file:// passes through unchanged (regression)", () => {
  const url = "file:///tmp/legacy/plugin.ts"
  assert.deepEqual(resolveSpec(url, DIR), { kind: "module", url })
})

test("resolveSpec: bare package names are refused honestly (npm support not built yet)", () => {
  // Changed in the github:-by-source slice: a bare name used to pass through
  // to `import()`, which failed deep in the loader. Refusing with the accepted
  // forms is the feature; see src/index.ts resolveSpec.
  assert.throws(() => resolveSpec("some-plugin-package", DIR), /not yet supported/)
  assert.throws(() => resolveSpec("some-plugin-package", DIR), /accepted forms are: preset:, github:/)
})

/* ---- new behaviour ---- */

test("resolveSpec: ~ expands against the home directory", () => {
  assert.deepEqual(resolveSpec("~/x/y.ts", DIR), {
    kind: "module",
    url: pathToFileURL(path.resolve(os.homedir(), "x/y.ts")).href,
  })
})

test("resolveSpec: bare ~ is invalid", () => {
  assert.throws(() => resolveSpec("~", DIR), /invalid specifier/)
})

test("resolveSpec: preset:rtk resolves to the rtk preset", () => {
  assert.deepEqual(resolveSpec("preset:rtk", DIR), { kind: "preset", id: "rtk" })
})

test("resolveSpec: unknown preset fails loudly with the valid ids", () => {
  assert.throws(() => resolveSpec("preset:nope", DIR), /nope/)
  assert.throws(() => resolveSpec("preset:nope", DIR), /rtk/)
})

test("defaultHostStoreRoot: the npm SIBLING of the oc-bifrost cache under the shared opencode cache root", () => {
  const home = path.join(os.tmpdir(), "oc-bifrost-home-test")
  const plain = path.join(home, ".cache", "opencode")
  assert.equal(defaultHostStoreRoot(home, {}), path.join(plain, "npm"))
  const xdg = path.join(home, "xdg-cache")
  assert.equal(defaultHostStoreRoot(home, { XDG_CACHE_HOME: xdg }), path.join(xdg, "opencode", "npm"))
  // Ruling R-2: the store root is the cache root's npm SIBLING - derived from
  // the same base as githubCacheRoot - NOT github's parent (the oc-bifrost
  // dir itself, the known-wrong guess the plan file was corrected against).
  assert.equal(
    path.join(path.dirname(path.dirname(githubCacheRoot(home, {}))), "npm"),
    path.join(plain, "npm"),
  )
  assert.notEqual(defaultHostStoreRoot(home, {}), path.dirname(githubCacheRoot(home, {})))
})
