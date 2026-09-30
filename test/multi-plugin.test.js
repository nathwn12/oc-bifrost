import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import bifrost, { githubCacheRoot } from "../dist/index.js"
import { githubCacheId, githubCacheLayoutRoot, sha256Hex } from "../dist/github.js"

/**
 * These tests run the real mount loop, so the durable report sink is live inside
 * them. With no override every `npm run check` would append its mounts to the
 * operator's real user cache (`~/.cache/opencode/oc-bifrost/report.log`). Nothing
 * here asserts sink behaviour — that is `sink.test.js`, with its own paths — so
 * the sink is off for this file.
 */
process.env.OC_BIFROST_REPORT = "off"

/**
 * The bridge's headline claim is that it scales to N plugins with one writer per
 * artifact and no collision. Until now every test mounted exactly one plugin, so
 * that claim was structural but unexecuted. These tests run the real mount loop.
 */

/** Minimal V2 context that records every registration. Mirrors hooks.test.js. */
function fakeContext() {
  const registered = new Map()
  const record = (key, callback) => {
    const list = registered.get(key) ?? []
    list.push(callback)
    registered.set(key, list)
  }
  const ctx = {
    location: { directory: process.cwd(), project: { id: "test" } },
    options: {},
    app: { name: "opencode", version: "2.0.0", channel: "test" },
    tool: {
      hook: async (name, callback) => record(`tool:${name}`, callback),
      transform: async () => {},
      list: async () => [],
      reload: async () => {},
    },
    shell: { hook: async (name, callback) => record(`shell:${name}`, callback) },
    session: { hook: async (name, callback) => record(`session:${name}`, callback) },
    permission: { hook: async (name, callback) => record(`permission:${name}`, callback) },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    storage: { get: async () => undefined, set: async () => {} },
  }
  const fire = async (key, event) => {
    for (const callback of registered.get(key) ?? []) await callback(event)
  }
  return { ctx, registered, fire }
}

/**
 * Fixtures are `.mjs`, not `.ts`: this suite runs under plain Node
 * (`node --test`), which will not import TypeScript. The mount loop under test
 * is era-agnostic, so the extension is not load-bearing.
 */
function writeFixture(dir, name, exportName) {
  const file = path.join(dir, name)
  fs.writeFileSync(
    file,
    [
      `export const ${exportName}Plugin = async (input, options) => ({`,
      `  "tool.execute.before": async (_input, output) => {`,
      `    output.args.command = options.tag + ":" + output.args.command`,
      `  },`,
      `  dispose: async () => {`,
      `    ;(globalThis.__bifrostDisposed ??= []).push(options.tag)`,
      `  },`,
      `})`,
    ].join("\n"),
  )
  return pathToFileURL(file).href
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bifrost-multi-"))
}

const shellEvent = (command) => ({
  tool: "shell",
  sessionID: "s",
  agent: "a",
  messageID: "m",
  id: "c",
  input: { command },
})

test("multi-plugin: N plugins mount, each with its OWN options, in declaration order", async () => {
  globalThis.__bifrostDisposed = []
  const dir = tempDir()
  const alpha = writeFixture(dir, "alpha.mjs", "Alpha")
  const beta = writeFixture(dir, "beta.mjs", "Beta")
  const { ctx, fire } = fakeContext()
  ctx.options = {
    plugins: [
      { spec: alpha, options: { tag: "A" } },
      { spec: beta, options: { tag: "B" } },
    ],
  }

  const cleanup = await bifrost.setup(ctx)
  const event = shellEvent("git status")
  await fire("tool:execute.before", event)

  // Declaration order, and each plugin saw ITS OWN options: A runs first, then B
  // sees A's mutation. Composition is a documented property, not an accident.
  assert.equal(event.input.command, "B:A:git status")

  await cleanup()
  // Cleanups run in reverse so teardown mirrors setup.
  assert.deepEqual(globalThis.__bifrostDisposed, ["B", "A"])

  fs.rmSync(dir, { recursive: true, force: true })
})

test("multi-plugin: a failing entry does not stop the others (independent branches continue)", async () => {
  const dir = tempDir()
  const gamma = writeFixture(dir, "gamma.mjs", "Gamma")
  const missing = pathToFileURL(path.join(dir, "does-not-exist.mjs")).href
  const { ctx, fire } = fakeContext()
  ctx.options = { plugins: [{ spec: missing }, { spec: gamma, options: { tag: "G" } }] }

  const cleanup = await bifrost.setup(ctx)
  const event = shellEvent("ls")
  await fire("tool:execute.before", event)

  assert.equal(event.input.command, "G:ls")

  await cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
})

test("multi-plugin: options are not shared between entries", async () => {
  const dir = tempDir()
  const alpha = writeFixture(dir, "alpha.mjs", "Alpha")
  const beta = writeFixture(dir, "beta.mjs", "Beta")
  const { ctx, fire } = fakeContext()
  ctx.options = {
    plugins: [
      { spec: alpha, options: { tag: "A" } },
      { spec: beta, options: { tag: "B" } },
    ],
  }

  await bifrost.setup(ctx)
  const event = shellEvent("x")
  await fire("tool:execute.before", event)

  // If options leaked across entries both would apply the same tag.
  assert.equal(event.input.command, "B:A:x")

  fs.rmSync(dir, { recursive: true, force: true })
})

/* ---- options/env plumbing: wireTui (opt-in TUI wiring on mounted github: snapshots) ---- */

/**
 * A warm, hash-verified `github:` snapshot cache entry under `cacheRoot` -
 * zero network, exactly what a first-fetched-and-cached plugin looks like.
 * The entry file is a `.mjs` V1 factory (plain Node cannot import `.ts`).
 */
function writeWarmGithubSnapshot(cacheRoot, spec, { entryName = "plugin.mjs", entryContent, manifest }) {
  const cacheDir = path.join(githubCacheLayoutRoot(cacheRoot), githubCacheId(spec))
  const treeDir = path.join(cacheDir, "tree")
  fs.mkdirSync(treeDir, { recursive: true })
  fs.writeFileSync(path.join(treeDir, "package.json"), JSON.stringify(manifest))
  fs.writeFileSync(path.join(treeDir, entryName), entryContent)
  fs.writeFileSync(
    path.join(cacheDir, "meta.json"),
    JSON.stringify(
      {
        source: "github",
        owner: spec.owner,
        repo: spec.repo,
        ref: "main",
        resolvedCommit: "a".repeat(40),
        path: entryName,
        sha256: sha256Hex(entryContent),
        bytes: Buffer.byteLength(entryContent, "utf8"),
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
  return { cacheDir, treeDir }
}

const WIDGET_ENTRY = [
  "export const WidgetPlugin = async (input, options) => ({",
  '  "tool.execute.before": async (_input, output) => {',
  '    output.args.command = "widget:" + output.args.command',
  "  },",
  "  dispose: async () => {},",
  "})",
].join("\n")

/** Redirect XDG_CACHE_HOME (the github cache + host-store roots) into `root` for `fn`. */
async function withXdgCacheHome(root, fn) {
  const saved = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = path.join(root, "xdg")
  try {
    return await fn()
  } finally {
    process.env.XDG_CACHE_HOME = saved
  }
}

test("wireTui: true wires a mounted github: snapshot into the caller-provided cli.json", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bifrost-multi-wire-"))
  try {
    await withXdgCacheHome(root, async () => {
      const spec = { owner: "acme", repo: "widget" }
      // The mount loop resolves against `githubCacheRoot()` (XDG-redirected
      // here), so the warm cache must sit exactly there.
      const { treeDir } = writeWarmGithubSnapshot(githubCacheRoot(), spec, {
        entryContent: WIDGET_ENTRY,
        manifest: { name: "widget", version: "1.0.0" }, // zero declared deps: no provision rows, clean mount
      })
      const cli = path.join(root, "cli.json")
      fs.writeFileSync(cli, '{\n  "verbosity": 2\n}\n')
      const { ctx, fire } = fakeContext()
      ctx.options = { plugins: ["github:acme/widget"], wireTui: true, cliJsonPath: cli }

      const cleanup = await bifrost.setup(ctx)

      // The plugin itself mounts AND the TUI wiring happens after that mount.
      const event = shellEvent("git status")
      await fire("tool:execute.before", event)
      assert.equal(event.input.command, "widget:git status", "the github: plugin must mount")

      const wired = fs.readFileSync(cli, "utf8")
      const entry = pathToFileURL(treeDir).href
      assert.ok(wired.includes(`"${entry}"`), `cli.json must gain the tree file:// entry, got:\n${wired}`)
      assert.ok(wired.includes("oc-bifrost: managed TUI entry"), "the entry must carry the ownership marker")
      const wrapper = path.join(treeDir, "tui.tsx")
      assert.ok(fs.existsSync(wrapper), "the tui.tsx wrapper must be created at the tree root")
      assert.equal(fs.readFileSync(wrapper, "utf8"), 'export { default } from "./src/tui/index.tsx";\n')

      await cleanup()
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: false leaves cli.json byte-untouched and writes no wrapper", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bifrost-multi-no-wire-"))
  try {
    await withXdgCacheHome(root, async () => {
      const spec = { owner: "acme", repo: "widget" }
      const { treeDir } = writeWarmGithubSnapshot(githubCacheRoot(), spec, {
        entryContent: WIDGET_ENTRY,
        manifest: { name: "widget", version: "1.0.0" },
      })
      const cli = path.join(root, "cli.json")
      const before = '{\n  "verbosity": 2\n}\n'
      fs.writeFileSync(cli, before)
      const { ctx, fire } = fakeContext()
      ctx.options = { plugins: ["github:acme/widget"], wireTui: false, cliJsonPath: cli }

      const cleanup = await bifrost.setup(ctx)
      const event = shellEvent("x")
      await fire("tool:execute.before", event)
      assert.equal(event.input.command, "widget:x", "the plugin itself must still mount")
      assert.equal(fs.readFileSync(cli, "utf8"), before, "cli.json must be untouched")
      assert.equal(fs.existsSync(path.join(treeDir, "tui.tsx")), false, "no wrapper may be written")
      await cleanup()
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: OC_BIFROST_WIRE_TUI=1 opts in when the option is omitted; an explicit false wins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bifrost-multi-wire-env-"))
  const savedWire = process.env.OC_BIFROST_WIRE_TUI
  process.env.OC_BIFROST_WIRE_TUI = "1"
  try {
    await withXdgCacheHome(root, async () => {
      // Run 1 - env only (no wireTui option): the env var opts in.
      const spec = { owner: "acme", repo: "widget" }
      const one = writeWarmGithubSnapshot(githubCacheRoot(), spec, {
        entryContent: WIDGET_ENTRY,
        manifest: { name: "widget", version: "1.0.0" },
      })
      const cli = path.join(root, "cli-one.json")
      fs.writeFileSync(cli, '{\n  "verbosity": 2\n}\n')
      const first = fakeContext()
      first.ctx.options = { plugins: ["github:acme/widget"], cliJsonPath: cli }
      await bifrost.setup(first.ctx)
      assert.ok(
        fs.readFileSync(cli, "utf8").includes(`"${pathToFileURL(one.treeDir).href}"`),
        "the env var alone must enable wiring",
      )
      assert.ok(fs.existsSync(path.join(one.treeDir, "tui.tsx")))

      // Run 2 - explicit false beats env true (a distinct spec keeps the two
      // runs' warm caches from sharing a cache entry under the same root).
      const specTwo = { owner: "acme", repo: "gadget" }
      const two = writeWarmGithubSnapshot(githubCacheRoot(), specTwo, {
        entryContent: WIDGET_ENTRY,
        manifest: { name: "gadget", version: "1.0.0" },
      })
      const cliTwo = path.join(root, "cli-two.json")
      const twoBefore = '{\n  "verbosity": 2\n}\n'
      fs.writeFileSync(cliTwo, twoBefore)
      const second = fakeContext()
      second.ctx.options = { plugins: ["github:acme/gadget"], wireTui: false, cliJsonPath: cliTwo }
      await bifrost.setup(second.ctx)
      assert.equal(fs.readFileSync(cliTwo, "utf8"), twoBefore, "an explicit false must beat the env var")
      assert.equal(fs.existsSync(path.join(two.treeDir, "tui.tsx")), false)
    })
  } finally {
    process.env.OC_BIFROST_WIRE_TUI = savedWire
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("wireTui: a wire refusal is a loud row and never aborts the mounted plugin", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bifrost-multi-wire-fail-"))
  try {
    await withXdgCacheHome(root, async () => {
      const spec = { owner: "acme", repo: "widget" }
      writeWarmGithubSnapshot(githubCacheRoot(), spec, {
        entryContent: WIDGET_ENTRY,
        manifest: { name: "widget", version: "1.0.0" },
      })
      // Not a balanced JSONC object: wireTui refuses loudly (never guess-writes).
      const cli = path.join(root, "cli.json")
      fs.writeFileSync(cli, "[1, 2]\n")
      const { ctx, fire } = fakeContext()
      ctx.options = { plugins: ["github:acme/widget"], wireTui: true, cliJsonPath: cli }

      const warned = []
      const savedWarn = console.warn
      console.warn = (line) => warned.push(String(line))
      try {
        const cleanup = await bifrost.setup(ctx) // must resolve: the mount already happened
        const event = shellEvent("ls")
        await fire("tool:execute.before", event)
        assert.equal(event.input.command, "widget:ls", "the plugin must stay mounted after a wire refusal")
        assert.equal(fs.readFileSync(cli, "utf8"), "[1, 2]\n", "the refused file must never be written")
        assert.ok(
          warned.some((line) => line.includes(cli) && line.includes("[oc-bifrost")),
          `the wire refusal must be a loud row, got:\n${warned.join("\n")}`,
        )
        await cleanup()
      } finally {
        console.warn = savedWarn
      }
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
