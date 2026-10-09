import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import bifrost from "../dist/index.js"
import {
  BIFROST_CONFIG_FILENAME,
  parseBifrostJsonc,
  readBifrostFileConfig,
  resolveBifrostConfigDir,
  resolveBifrostConfigPath,
  resolveBifrostOptions,
} from "../dist/config-file.js"

/**
 * Config-file fallback: a git spec cannot carry `options`, so
 * `oc-bifrost.jsonc` in the OpenCode config dir supplies them instead.
 * Precedence is defaults < config file < `context.options`, key by key.
 */

process.env.OC_BIFROST_REPORT = "off"

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bifrost-config-file-"))
}

/** Minimal V2 context that records every registration. Mirrors multi-plugin.test.js. */
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
  return { ctx, fire }
}

function quietConsole() {
  const original = { log: console.log, warn: console.warn }
  console.log = () => {}
  console.warn = () => {}
  return () => {
    console.log = original.log
    console.warn = original.warn
  }
}

function withEnv(name, value) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  return () => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

/**
 * Fixture is `.mjs`, not `.ts`: this suite runs under plain Node
 * (`node --test`), which will not import TypeScript. The option-resolution
 * path under test is era-agnostic, so the extension is not load-bearing.
 */
function writeFixture(dir, name, tag) {
  const file = path.join(dir, name)
  fs.writeFileSync(
    file,
    [
      `export const TaggedPlugin = async (input, options) => ({`,
      `  "tool.execute.before": async (_input, output) => {`,
      `    output.args.command = "${tag}:" + output.args.command`,
      `  },`,
      `  dispose: async () => {},`,
      `})`,
    ].join("\n"),
  )
  return pathToFileURL(file).href
}

const shellEvent = (command) => ({
  tool: "shell",
  sessionID: "s",
  agent: "a",
  messageID: "m",
  id: "c",
  input: { command },
})

test("config-file: OPENCODE_CONFIG_DIR wins, then XDG_CONFIG_HOME, then ~/.config", () => {
  const home = path.join(path.sep, "home", "you")
  assert.equal(
    resolveBifrostConfigDir({ OPENCODE_CONFIG_DIR: path.join(path.sep, "cfg") }, home),
    path.join(path.sep, "cfg"),
  )
  assert.equal(
    resolveBifrostConfigDir({ XDG_CONFIG_HOME: path.join(path.sep, "xdg") }, home),
    path.join(path.sep, "xdg", "opencode"),
  )
  assert.equal(
    resolveBifrostConfigDir({}, home),
    path.join(home, ".config", "opencode"),
  )
  assert.equal(BIFROST_CONFIG_FILENAME, "oc-bifrost.jsonc")
  assert.equal(
    resolveBifrostConfigPath(path.join(path.sep, "cfg")),
    path.join(path.sep, "cfg", "oc-bifrost.jsonc"),
  )
})

test("config-file: the reader parses JSONC and never throws", () => {
  assert.deepEqual(parseBifrostJsonc(`{ "plugins": ["a",], // trailing comma + comment\n}`), {
    plugins: ["a"],
  })
  const dir = tempDir()
  try {
    assert.deepEqual(readBifrostFileConfig(path.join(dir, "missing.jsonc")), {})
    const bad = path.join(dir, "bad.jsonc")
    fs.writeFileSync(bad, "{ not json")
    assert.deepEqual(readBifrostFileConfig(bad), {})
    const scalar = path.join(dir, "scalar.jsonc")
    fs.writeFileSync(scalar, `"just a string"`)
    assert.deepEqual(readBifrostFileConfig(scalar), {})
    // A non-array plugins value is dropped, never trusted into the mount loop.
    const wrong = path.join(dir, "wrong.jsonc")
    fs.writeFileSync(wrong, JSON.stringify({ plugins: "preset:rtk", strict: true }))
    assert.deepEqual(readBifrostFileConfig(wrong), { strict: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("config-file: precedence is defaults < file < options, key by key", () => {
  const file = { plugins: ["preset:rtk"], strict: true, verbose: false }
  // An empty options object takes everything from the file.
  assert.deepEqual(resolveBifrostOptions({}, file), file)
  assert.deepEqual(resolveBifrostOptions(undefined, file), file)
  // options.plugins overrides the file's list wholesale (no merging).
  assert.deepEqual(resolveBifrostOptions({ plugins: ["preset:other"] }, file).plugins, [
    "preset:other",
  ])
  // An empty plugins array is "not supplied" - the file still wins.
  assert.deepEqual(resolveBifrostOptions({ plugins: [] }, file).plugins, ["preset:rtk"])
  // Scalars merge key by key: an explicit option wins, the file fills the rest.
  const merged = resolveBifrostOptions({ strict: false }, file)
  assert.equal(merged.strict, false)
  assert.equal(merged.verbose, false)
  assert.deepEqual(merged.plugins, ["preset:rtk"])
  // No file and no options is the old no-op shape.
  assert.deepEqual(resolveBifrostOptions({}, {}), {})
  assert.deepEqual(resolveBifrostOptions(undefined, undefined), {})
})

test("config-file: the file supplies plugins when options is empty (the git-install path)", async () => {
  const dir = tempDir()
  const spec = writeFixture(dir, "from-file.mjs", "FILE")
  fs.writeFileSync(
    path.join(dir, "oc-bifrost.jsonc"),
    `{\n  // a git spec cannot carry options, so the file carries them\n  "plugins": ["${spec}",],\n}\n`,
  )
  const restoreDir = withEnv("OPENCODE_CONFIG_DIR", dir)
  const restoreConsole = quietConsole()
  try {
    const { ctx, fire } = fakeContext()
    ctx.location.directory = dir
    ctx.options = {}
    await bifrost.setup(ctx)
    const event = shellEvent("git status")
    await fire("tool:execute.before", event)
    assert.equal(event.input.command, "FILE:git status", "the file-listed plugin must mount")
  } finally {
    restoreConsole()
    restoreDir()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("config-file: options.plugins overrides the file list (no merging)", async () => {
  const dir = tempDir()
  const fromFile = writeFixture(dir, "from-file.mjs", "FILE")
  const fromOptions = writeFixture(dir, "from-options.mjs", "OPTIONS")
  fs.writeFileSync(path.join(dir, "oc-bifrost.jsonc"), JSON.stringify({ plugins: [fromFile] }))
  const restoreDir = withEnv("OPENCODE_CONFIG_DIR", dir)
  const restoreConsole = quietConsole()
  try {
    const { ctx, fire } = fakeContext()
    ctx.location.directory = dir
    ctx.options = { plugins: [fromOptions] }
    await bifrost.setup(ctx)
    const event = shellEvent("ls")
    await fire("tool:execute.before", event)
    assert.equal(event.input.command, "OPTIONS:ls", "only the options-listed plugin must mount")
  } finally {
    restoreConsole()
    restoreDir()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
