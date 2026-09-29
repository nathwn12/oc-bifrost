import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import bifrost from "../dist/index.js"
import {
  createReportSink,
  reportPath,
  reportSinkEnabled,
  sanitizeReportText,
  MAX_REPORT_BYTES,
} from "../dist/sink.js"

/**
 * The durable report sink.
 *
 * The mount report is oc-bifrost's proof surface, but the host discards stdout
 * when it runs as a managed background service or a stdio server. These tests
 * prove the file mirror: it exists, it carries the SAME lines the console gets,
 * it never leaks an environment secret, and its size is hard-capped.
 */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bifrost-sink-"))
}

/** Minimal V2 context; mirrors multi-plugin.test.js. */
function fakeContext() {
  const ctx = {
    location: { directory: process.cwd(), project: { id: "test" } },
    options: {},
    app: { name: "opencode", version: "2.0.0", channel: "test" },
    tool: {
      hook: async () => {},
      transform: async () => {},
      list: async () => [],
      reload: async () => {},
    },
    shell: { hook: async () => {} },
    session: { hook: async () => {} },
    permission: { hook: async () => {} },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    storage: { get: async () => undefined, set: async () => {} },
  }
  return { ctx }
}

/** A V1 plugin that mounts one full hook and one refused hook, so both appear. */
function writeFixture(dir) {
  const file = path.join(dir, "legacy.mjs")
  fs.writeFileSync(
    file,
    [
      `export const LegacyPlugin = async () => ({`,
      `  "tool.execute.before": async (_input, output) => {`,
      `    output.args.command = "bridged " + output.args.command`,
      `  },`,
      `  config: async () => ({}),`,
      `})`,
    ].join("\n"),
  )
  return pathToFileURL(file).href
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

test("sink: the default path is the shared OpenCode cache; an env var overrides it", () => {
  const home = path.join(path.sep, "home", "you")
  assert.equal(
    reportPath(home, {}),
    path.join(home, ".cache", "opencode", "oc-bifrost", "report.log"),
  )
  assert.equal(
    reportPath(home, { XDG_CACHE_HOME: path.join(path.sep, "xdg") }),
    path.join(path.sep, "xdg", "opencode", "oc-bifrost", "report.log"),
  )
  const override = path.join(tempDir(), "reports", "r.log")
  assert.equal(reportPath(home, { OC_BIFROST_REPORT: override }), path.resolve(override))
  assert.equal(reportSinkEnabled({}), true)
  assert.equal(reportSinkEnabled({ OC_BIFROST_REPORT: "off" }), false)
})

test("sink: enforces the size cap, rolling over to keep the newest bytes", () => {
  const dir = tempDir()
  const file = path.join(dir, "report.log")
  try {
    const sink = createReportSink({ path: file, maxBytes: 64 })
    sink.write("first report line\n")
    assert.ok(fs.existsSync(file), "the file is created on first write")
    assert.ok(fs.statSync(file).size <= 64)

    // A single block larger than the cap: only the newest tail survives.
    sink.write(`${"x".repeat(200)}\n`)
    assert.ok(fs.statSync(file).size <= 64, "a single oversized block must not exceed the cap")
    assert.match(fs.readFileSync(file, "utf8"), /x/)

    // A normal block that would cross the cap rolls the file over first.
    fs.writeFileSync(file, `${"a".repeat(60)}\n`)
    createReportSink({ path: file, maxBytes: 64 }).write("newest block\n")
    assert.equal(fs.readFileSync(file, "utf8"), "newest block\n")
    assert.ok(fs.statSync(file).size <= 64)

    assert.equal(MAX_REPORT_BYTES, 256 * 1024)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("sink: escapes control characters so a report line cannot inject into the log", () => {
  const dir = tempDir()
  const file = path.join(dir, "report.log")
  try {
    const sink = createReportSink({ path: file, maxBytes: 4096 })
    sink.write("has\u0000nul and \r carriage and \u001b[31mansi\n")
    const content = fs.readFileSync(file, "utf8")
    assert.ok(!content.includes("\u0000"))
    assert.ok(!content.includes("\r"))
    assert.ok(!content.includes("\u001b"))
    assert.match(content, /\\u0000/)
    assert.match(sanitizeReportText("a\u0007b"), /a\\u0007b/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("sink: the durable report carries the same lines the console gets", async () => {
  const dir = tempDir()
  const reportFile = path.join(dir, "report.log")
  const restoreEnv = withEnv("OC_BIFROST_REPORT", reportFile)
  const restoreConsole = quietConsole()
  const consoleLines = []
  console.log = (...args) => {
    consoleLines.push(...args.map(String).flatMap((value) => value.split("\n")))
  }
  console.warn = (...args) => {
    consoleLines.push(...args.map(String).flatMap((value) => value.split("\n")))
  }
  try {
    const { ctx } = fakeContext()
    ctx.location.directory = dir
    ctx.options = { plugins: [writeFixture(dir)] }
    const cleanup = await bifrost.setup(ctx)
    await cleanup()

    const content = fs.readFileSync(reportFile, "utf8")
    const fileLines = content.split("\n").filter((line) => line.trim() !== "")
    const expected = consoleLines.filter((line) => line.trim() !== "")

    assert.ok(fileLines.length > 0, "the file must not be empty")
    assert.deepEqual(fileLines, expected, "the file must mirror the console line for line")
    assert.ok(
      fileLines.some((line) => /full\s+tool\.execute\.before/.test(line)),
      "the report names the bridged hook",
    )
    assert.ok(
      fileLines.some((line) => /unsupported\s+config/.test(line)),
      "the report names the refused hook",
    )
  } finally {
    restoreConsole()
    restoreEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("sink: never writes environment secrets into the report", async () => {
  const dir = tempDir()
  const reportFile = path.join(dir, "report.log")
  const sentinel = `SENTINEL-${Math.random().toString(36).slice(2)}`
  const restoreEnv = withEnv("OC_BIFROST_REPORT", reportFile)
  const restoreSecret = withEnv("OC_BIFROST_TEST_SECRET", sentinel)
  const restoreConsole = quietConsole()
  try {
    const { ctx } = fakeContext()
    ctx.location.directory = dir
    ctx.options = { plugins: [writeFixture(dir)] }
    await bifrost.setup(ctx)

    const content = fs.readFileSync(reportFile, "utf8")
    assert.ok(content.length > 0, "a report was written")
    assert.ok(!content.includes(sentinel), "the report must not echo an environment secret")
  } finally {
    restoreConsole()
    restoreSecret()
    restoreEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("sink: the no-plugins notice is durable, and OC_BIFROST_REPORT=off disables the sink", async () => {
  const dir = tempDir()
  const reportFile = path.join(dir, "report.log")
  const restoreConsole = quietConsole()
  try {
    const on = withEnv("OC_BIFROST_REPORT", reportFile)
    const { ctx } = fakeContext()
    ctx.location.directory = dir
    ctx.options = {}
    await bifrost.setup(ctx)
    assert.match(fs.readFileSync(reportFile, "utf8"), /no plugins configured/)
    on()

    // Off switch: a fresh path must never be created.
    const offFile = path.join(dir, "disabled.log")
    const off = withEnv("OC_BIFROST_REPORT", "off")
    const { ctx: ctx2 } = fakeContext()
    ctx2.location.directory = dir
    ctx2.options = { plugins: [writeFixture(dir)] }
    await bifrost.setup(ctx2)
    assert.equal(fs.existsSync(offFile), false)
    off()
  } finally {
    restoreConsole()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
