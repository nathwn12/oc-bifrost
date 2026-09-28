import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { looksLikeV1Plugin, scanStrandedV1 } from "../dist/scan.js"

const V1 = `import type { Plugin } from "@opencode-ai/plugin"\nexport const RtkOpenCodePlugin: Plugin = async ({ $ }) => ({})\n`
const V2 = `export default { id: "modern", setup() {} }\n`
const RANDOM = `export const util = (x) => x + 1\n`

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test("scan: flags a V1-looking .ts and nothing else", () => {
  const root = mkTemp("oc-bifrost-scan-")
  const discovery = path.join(root, ".opencode", "plugin")
  fs.mkdirSync(discovery, { recursive: true })
  fs.writeFileSync(path.join(discovery, "legacy.ts"), V1)
  fs.writeFileSync(path.join(discovery, "modern.ts"), V2)
  fs.writeFileSync(path.join(discovery, "util.ts"), RANDOM)

  const isolatedGlobal = mkTemp("oc-bifrost-global-")
  const findings = scanStrandedV1({ directory: root, env: { XDG_CONFIG_HOME: isolatedGlobal } })

  assert.equal(findings.length, 1)
  assert.match(findings[0].path, /legacy\.ts$/)
  assert.equal(findings[0].root, "project")
})

test("scan: finds a stranded V1 file in the global root", () => {
  const globalConfig = mkTemp("oc-bifrost-global-")
  const globalPlugins = path.join(globalConfig, "opencode", "plugins")
  fs.mkdirSync(globalPlugins, { recursive: true })
  fs.writeFileSync(path.join(globalPlugins, "old.js"), "module.exports = async () => ({})\n")

  const project = mkTemp("oc-bifrost-proj-")
  const findings = scanStrandedV1({ directory: project, env: { XDG_CONFIG_HOME: globalConfig } })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].root, "global")
})

test("scan: a missing discovery directory does not throw", () => {
  const root = mkTemp("oc-bifrost-empty-")
  const findings = scanStrandedV1({ directory: root, env: { XDG_CONFIG_HOME: root } })
  assert.deepEqual(findings, [])
})

test("scan: an unreadable path does not throw", () => {
  const root = mkTemp("oc-bifrost-unreadable-")
  fs.mkdirSync(path.join(root, ".opencode"), { recursive: true })
  // `.opencode/plugin` is a FILE, not a directory -> readdirSync throws ENOTDIR.
  fs.writeFileSync(path.join(root, ".opencode", "plugin"), "not a directory")

  const findings = scanStrandedV1({ directory: root, env: { XDG_CONFIG_HOME: root } })
  assert.deepEqual(findings, [])
})

test("scan: looksLikeV1Plugin is conservative", () => {
  assert.equal(looksLikeV1Plugin(V1), true)
  assert.equal(looksLikeV1Plugin("export default async (input) => ({})\n"), true)
  assert.equal(looksLikeV1Plugin("module.exports = {}\n"), true)
  assert.equal(looksLikeV1Plugin(V2), false)
  assert.equal(looksLikeV1Plugin(RANDOM), false)
})

test("scan: a V2 OBJECT export named *Plugin is not flagged", () => {
  // Regression: the first heuristic matched the identifier alone, so a legitimate
  // V2-style definition ending in "Plugin" was warned as stranded V1. The `= {`
  // tail is the discriminator — only a factory (`= async|function|(`) is V1-shaped.
  assert.equal(looksLikeV1Plugin(`export const FooPlugin = { id: "modern", setup() {} }\n`), false)
  assert.equal(looksLikeV1Plugin(`export const FooPlugin: Plugin = { id: "x", setup() {} }\n`), false)
  assert.equal(looksLikeV1Plugin(`export let BarPlugin\n`), false)
})

test("scan: the REAL vendored RTK file is still recognised", () => {
  // Ties the heuristic to the actual artifact it exists to catch, so tightening
  // the pattern cannot silently stop detecting the file we ship a preset for.
  const source = fs.readFileSync(new URL("../vendor/rtk.ts", import.meta.url), "utf8")
  assert.equal(looksLikeV1Plugin(source), true)
})
