import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { githubCacheRoot, resolveSpec } from "../dist/index.js"
import {
  defaultHostStoreRoot,
  githubCacheId,
  githubCacheLayoutRoot,
  provisionMode,
  resolveGithubPlugin,
  sha256Hex,
} from "../dist/github.js"

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

/* ---- options/env plumbing: provision mode ---- */

test("provisionMode: the default is \"host\" when both the option and the environment are absent", () => {
  assert.equal(provisionMode(undefined, {}), "host")
})

test("provisionMode: OC_BIFROST_PROVISION=npm is honored (the env var sets the mode)", () => {
  assert.equal(provisionMode(undefined, { OC_BIFROST_PROVISION: "npm" }), "npm")
  assert.equal(provisionMode(undefined, { OC_BIFROST_PROVISION: "  NPM " }), "npm", "case and whitespace are tolerated")
})

test("provisionMode: an explicit option wins over the environment", () => {
  assert.equal(provisionMode("off", { OC_BIFROST_PROVISION: "npm" }), "off")
  assert.equal(provisionMode("host", { OC_BIFROST_PROVISION: "npm" }), "host")
})

test("provisionMode: an invalid value is a loud refusal naming the valid modes, never a silent default", () => {
  assert.throws(() => provisionMode(undefined, { OC_BIFROST_PROVISION: "bogus" }), /invalid provision mode/)
  assert.throws(() => provisionMode(undefined, { OC_BIFROST_PROVISION: "bogus" }), /"host", "npm", or "off"/)
  assert.throws(() => provisionMode("bogus", {}), /invalid provision mode/)
})

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

test("OC_BIFROST_PROVISION=npm drives the npm install fallback through the real resolve path", async () => {
  // A warm, hash-verified snapshot whose manifest declares a dep the empty
  // host store cannot serve. The env var must be the ONLY input that flips
  // the mode to npm - the option is deliberately omitted.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-resolve-provision-"))
  try {
    const spec = { owner: "acme", repo: "widget" }
    const content = "export const WidgetPlugin = async () => ({})\n"
    const cacheDir = path.join(githubCacheLayoutRoot(root), githubCacheId(spec))
    const treeDir = path.join(cacheDir, "tree")
    fs.mkdirSync(treeDir, { recursive: true })
    fs.writeFileSync(
      path.join(treeDir, "package.json"),
      JSON.stringify({ name: "widget", version: "1.0.0", dependencies: { "missing-pkg": "1.0.0" } }),
    )
    fs.writeFileSync(path.join(treeDir, "plugin.mjs"), content)
    fs.writeFileSync(
      path.join(cacheDir, "meta.json"),
      JSON.stringify(
        {
          source: "github",
          owner: "acme",
          repo: "widget",
          ref: "main",
          resolvedCommit: "a".repeat(40),
          path: "plugin.mjs",
          sha256: sha256Hex(content),
          bytes: Buffer.byteLength(content, "utf8"),
          fetchedAt: new Date().toISOString(),
          layout: "snapshot",
          tarballSha256: "b".repeat(64),
          tarballBytes: 42,
          files: 2,
          treeBytes: 100,
        },
        null,
        2,
      ),
    )

    const store = path.join(root, "empty-store")
    fs.mkdirSync(store, { recursive: true })
    const shimDir = path.join(root, "bin")
    const marker = path.join(root, "npm-invoked.txt")
    const argsFile = path.join(root, "npm-args.txt")
    installFakeNpm(shimDir, { marker, argsFile, exitCode: 0 })

    const savedProvision = process.env.OC_BIFROST_PROVISION
    process.env.OC_BIFROST_PROVISION = "npm"
    try {
      const result = await withPath(shimDir, () =>
        resolveGithubPlugin(spec, { cacheRoot: root, trusted: true, hostStores: [store] }),
      )
      assert.equal(result.fetched, false, "the warm cache must load with zero network")
      assert.ok(Array.isArray(result.provision), "the npm provisioning rows must be reported")
      assert.ok(
        result.provision.includes("npm install --no-save"),
        `expected the npm row in the mount note, got: ${result.provision.join(" | ")}`,
      )
      assert.ok(fs.existsSync(marker), "the fake npm shim must have run - the env var alone enabled the fallback")
      assert.ok(
        fs.existsSync(path.join(treeDir, "node_modules", ".bifrost-provision.json")),
        "the provision marker must be written",
      )
    } finally {
      process.env.OC_BIFROST_PROVISION = savedProvision
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
