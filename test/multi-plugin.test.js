import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import bifrost from "../dist/index.js"

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
