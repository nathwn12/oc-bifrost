import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveSpec } from "../dist/index.js"
import { discover } from "../dist/discover.js"
import {
  isBareRegistrySpecifier,
  parseRegistrySpecifier,
  registryCacheId,
  registryCacheRoot,
  registryMountNote,
  resolveRegistryEntry,
  resolveRegistryPlugin,
} from "../dist/registry.js"

/**
 * registry: specifiers - install a plugin FROM THE NPM REGISTRY into a
 * bifrost-owned cache directory and mount whatever it resolves to.
 *
 * Verified facts this slice builds on: `src/index.ts:110-112` said "npm
 * support is not built yet" and `src/index.ts:114-139` (`resolveSpec`) threw
 * `unsupportedSpecifierMessage` (`:83-88`) for everything outside
 * `preset:`/`github:`/paths (`README.md:56,98`; pinned by
 * `test/resolve.test.js:45-51` and `test/github.test.js:236-243`, both
 * updated by this slice).
 *
 * All hermetic: the spawned install is modelled behind the injectable
 * `install` runner, which materializes a fixture package and returns a canned
 * `installedBy` label. Exactly ONE case touches the network, opt-in via
 * `OC_BIFROST_REGISTRY_LIVE=1`.
 */

const DIR = path.resolve("some", "session", "dir")

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-registry-test-"))
}

/**
 * A fake spawned installer: materializes `node_modules/<name>/` with the
 * given manifest fields and entry file, and returns the canned label. Counts
 * its own invocations so tests prove the warm path spawns nothing.
 */
function fakeInstall({ name, version = "1.2.3", entry = "index.js", manifest = {}, content = 'export default { id: "demo", setup() {} }\n' }) {
  const calls = []
  const install = async (dir, bare) => {
    calls.push({ dir, bare })
    const packageDir = path.join(dir, "node_modules", ...name.split("/"))
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name, version, ...manifest }),
    )
    const entryFile = path.join(packageDir, entry)
    fs.mkdirSync(path.dirname(entryFile), { recursive: true })
    fs.writeFileSync(entryFile, content)
    return "fake-installer (`fake install`)"
  }
  return { install, calls }
}

/* ---- specifier parsing ---- */

test("resolveSpec: a bare name resolves to the registry kind", () => {
  assert.deepEqual(resolveSpec("oc-todo", DIR), {
    kind: "registry",
    spec: { manager: "npm", bare: "oc-todo", name: "oc-todo" },
  })
})

test("resolveSpec: name@version resolves with the range", () => {
  assert.deepEqual(resolveSpec("oc-todo@0.4.0", DIR), {
    kind: "registry",
    spec: { manager: "npm", bare: "oc-todo@0.4.0", name: "oc-todo", range: "0.4.0" },
  })
})

test("resolveSpec: name@range resolves with the range", () => {
  const resolved = resolveSpec("oc-todo@^1.0.0", DIR)
  assert.equal(resolved.kind, "registry")
  assert.equal(resolved.spec.name, "oc-todo")
  assert.equal(resolved.spec.range, "^1.0.0")
})

test("resolveSpec: name@tag resolves with the tag", () => {
  const resolved = resolveSpec("oc-todo@latest", DIR)
  assert.equal(resolved.kind, "registry")
  assert.equal(resolved.spec.range, "latest")
})

test("resolveSpec: @scope/name@version resolves with the scope", () => {
  assert.deepEqual(resolveSpec("@scope/pkg@1.2.3", DIR), {
    kind: "registry",
    spec: { manager: "npm", bare: "@scope/pkg@1.2.3", name: "@scope/pkg", range: "1.2.3" },
  })
})

test("resolveSpec: npm: strips the prefix and treats the remainder as a registry spec", () => {
  assert.deepEqual(resolveSpec("npm:oc-todo@0.4.0", DIR), {
    kind: "registry",
    spec: { manager: "npm", bare: "oc-todo@0.4.0", name: "oc-todo", range: "0.4.0" },
  })
})

test("resolveSpec: pnpm: strips the prefix and records the alias manager", () => {
  const resolved = resolveSpec("pnpm:oc-todo@^1.0.0", DIR)
  assert.equal(resolved.kind, "registry")
  assert.equal(resolved.spec.manager, "pnpm")
  assert.equal(resolved.spec.bare, "oc-todo@^1.0.0")
  assert.equal(resolved.spec.name, "oc-todo")
})

test("resolveSpec: bun: strips the prefix and records the alias manager", () => {
  const resolved = resolveSpec("bun:@scope/pkg@latest", DIR)
  assert.equal(resolved.kind, "registry")
  assert.equal(resolved.spec.manager, "bun")
  assert.equal(resolved.spec.bare, "@scope/pkg@latest")
  assert.equal(resolved.spec.name, "@scope/pkg")
})

/* ---- malformed specs refuse loudly ---- */

test("resolveSpec: malformed registry specs refuse loudly, never guess", () => {
  // Empty remainder behind a prefix: the parser's own invalid-specifier refusal.
  assert.throws(() => resolveSpec("npm:", DIR), /invalid registry specifier/)
  assert.throws(() => resolveSpec("pnpm:", DIR), /invalid registry specifier/)
  assert.throws(() => resolveSpec("bun:@scope", DIR), /invalid registry specifier/)
  assert.throws(() => resolveSpec("npm:pkg@", DIR), /invalid registry specifier/)
  // Unknown schemes and path-shaped junk are not registry specs: the
  // accepted-forms refusal (a refusal is a feature).
  assert.throws(() => resolveSpec("foo:bar", DIR), /unsupported specifier/)
  assert.throws(() => resolveSpec("foo:bar", DIR), /accepted forms are: preset:, github:/)
})

test("isBareRegistrySpecifier: only genuine bare names qualify", () => {
  assert.equal(isBareRegistrySpecifier("oc-todo"), true)
  assert.equal(isBareRegistrySpecifier("oc-todo@^1.0.0"), true)
  assert.equal(isBareRegistrySpecifier("@scope/pkg@latest"), true)
  assert.equal(isBareRegistrySpecifier("./local.ts"), false)
  assert.equal(isBareRegistrySpecifier("foo:bar"), false)
  assert.equal(isBareRegistrySpecifier(""), false)
})

/* ---- cache-root convention (mirrors the github layout) ---- */

test("registryCacheRoot: the oc-bifrost registry sibling of the github cache under the shared opencode cache root", () => {
  const home = path.join(os.tmpdir(), "oc-bifrost-registry-home-test")
  const plain = path.join(home, ".cache", "opencode", "oc-bifrost")
  assert.equal(registryCacheRoot(home, {}), path.join(plain, "registry"))
  const xdg = path.join(home, "xdg-cache")
  assert.equal(registryCacheRoot(home, { XDG_CACHE_HOME: xdg }), path.join(xdg, "opencode", "oc-bifrost", "registry"))
})

test("registryCacheId: filesystem-safe, deterministic, and distinct per distinct spec", () => {
  const id = registryCacheId("oc-todo@^1.0.0")
  assert.match(id, /^[A-Za-z0-9._-]+$/, "the id must be filesystem-safe")
  assert.equal(id, registryCacheId("oc-todo@^1.0.0"), "the id must be deterministic")
  assert.notEqual(registryCacheId("oc-todo@1.0.0"), registryCacheId("oc-todo@2.0.0"), "distinct specs must never share a directory")
})

/* ---- cold install + warm cache-first (hermetic) ---- */

test("resolveRegistryPlugin: a cold cache installs via the injected runner and verifies the entry before import", async () => {
  const root = tmpRoot()
  try {
    const fake = fakeInstall({ name: "oc-todo" })
    const spec = parseRegistrySpecifier("oc-todo@0.4.0")
    const result = await resolveRegistryPlugin(spec, { cacheRoot: root, install: fake.install, now: () => new Date(0) })
    assert.equal(result.fetched, true)
    assert.deepEqual(fake.calls, [{ dir: result.cacheDir, bare: "oc-todo@0.4.0" }])
    assert.equal(result.meta.name, "oc-todo")
    assert.equal(result.meta.range, "0.4.0")
    assert.equal(result.meta.version, "1.2.3", "the version is read from the installed manifest")
    assert.equal(result.meta.installedBy, "fake-installer (`fake install`)")
    const module = await import(result.url)
    assert.equal(module.default.id, "demo", "the verified entry must import")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveRegistryPlugin: a warm cache loads with zero installs and verifies the entry file", async () => {
  const root = tmpRoot()
  try {
    const fake = fakeInstall({ name: "oc-todo" })
    const spec = parseRegistrySpecifier("oc-todo@0.4.0")
    const first = await resolveRegistryPlugin(spec, { cacheRoot: root, install: fake.install })
    const second = await resolveRegistryPlugin(spec, {
      cacheRoot: root,
      install: async () => {
        throw new Error("must never install on a warm cache")
      },
    })
    assert.equal(second.fetched, false, "the second resolve must be a cache hit")
    assert.equal(second.url, first.url)
    assert.equal(second.meta.version, first.meta.version)
    assert.equal(fake.calls.length, 1, "exactly one install across both resolves")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveRegistryPlugin: the installed entry resolves via the package's own exports, then main", async () => {
  const root = tmpRoot()
  try {
    const fake = fakeInstall({
      name: "oc-todo",
      entry: "dist/entry.mjs",
      manifest: { exports: { ".": "./dist/entry.mjs" }, main: "./wrong.js" },
    })
    const result = await resolveRegistryPlugin(parseRegistrySpecifier("oc-todo"), {
      cacheRoot: root,
      install: fake.install,
    })
    assert.match(result.url, /dist\/entry\.mjs$/, "exports must win over main")
    assert.equal(result.meta.entry, path.join("dist", "entry.mjs"))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveRegistryEntry: an install whose manifest names no importable entry fails loudly", () => {
  const dir = tmpRoot()
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "empty", version: "1.0.0", main: "./missing.js" }))
    assert.throws(() => resolveRegistryEntry(dir), /no importable entry/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---- classification: V1 bridges, V2 runs natively ---- */

test("registry: a V1 factory package classifies as V1 (bridged) and a V2 definition as V2 (native setup)", async () => {
  const root = tmpRoot()
  try {
    const v1 = fakeInstall({
      name: "legacy-plugin",
      content: "export default async () => ({})\n",
    })
    const v1Result = await resolveRegistryPlugin(parseRegistrySpecifier("legacy-plugin"), {
      cacheRoot: root,
      install: v1.install,
    })
    assert.equal(discover(await import(v1Result.url), "legacy-plugin").kind, "v1")

    const v2 = fakeInstall({
      name: "modern-plugin",
      content: 'export default { id: "modern", setup() {} }\n',
    })
    const v2Result = await resolveRegistryPlugin(parseRegistrySpecifier("modern-plugin"), {
      cacheRoot: root,
      install: v2.install,
    })
    const shape = discover(await import(v2Result.url), "modern-plugin")
    assert.equal(shape.kind, "v2")
    assert.equal(shape.kind === "v2" && shape.id, "modern")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- the alias-honesty mount note ---- */

test("registryMountNote: pnpm: and bun: say plainly they are aliases installed the same way", async () => {
  const root = tmpRoot()
  try {
    for (const manager of ["pnpm", "bun"]) {
      const fake = fakeInstall({ name: "oc-todo" })
      const result = await resolveRegistryPlugin(parseRegistrySpecifier(`${manager}:oc-todo@0.4.0`), {
        cacheRoot: root,
        install: fake.install,
      })
      assert.equal(result.manager, manager)
      const note = registryMountNote(result)
      assert.match(note, new RegExp(`requested via "${manager}:"`))
      assert.match(note, new RegExp(`"${manager}:" is an alias, not a real ${manager} install`), "must never imply a real pnpm/bun install happened")
      assert.match(note, /installed with fake-installer/)
      assert.match(note, /executes with the host process's full user rights/)
    }
    const plain = await resolveRegistryPlugin(parseRegistrySpecifier("npm:oc-todo"), {
      cacheRoot: root,
      install: fakeInstall({ name: "oc-todo" }).install,
    })
    assert.doesNotMatch(registryMountNote(plain), /is an alias/, "the npm: form carries no alias line")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- opt-in live integration: ONE real install of a tiny real package ---- */

test(
  "registry: LIVE install of escape-string-regexp mounts what the registry resolves to",
  { skip: process.env.OC_BIFROST_REGISTRY_LIVE !== "1" && "set OC_BIFROST_REGISTRY_LIVE=1 to run the live registry install" },
  async () => {
    const root = tmpRoot()
    try {
      const result = await resolveRegistryPlugin(parseRegistrySpecifier("escape-string-regexp@5.0.0"), { cacheRoot: root })
      assert.equal(result.fetched, true)
      assert.equal(result.meta.version, "5.0.0")
      const module = await import(result.url)
      assert.equal(typeof (module.default ?? module.escapeStringRegexp), "function", "the installed entry must import and export its function")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)
