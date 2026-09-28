import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { gitBlobSha, sha256Hex } from "../scripts/vendor-lib.mjs"

/**
 * Provenance drift guard.
 *
 * The pin lives in three independent copies — the bytes, the recorded
 * provenance, and the version constant. Nothing keeps them in sync at
 * runtime, so they drift silently the moment one is updated and another is
 * forgotten. This test is what stops that: it recomputes everything from the
 * actual `vendor/rtk.ts` and asserts all three copies still agree.
 */

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8")

const vendored = fs.readFileSync(new URL("../vendor/rtk.ts", import.meta.url))
const meta = JSON.parse(read("../vendor/rtk.meta.json"))
const preset = read("../src/preset.ts")
const readme = read("../vendor/README.md")

test("provenance: meta.sha256 matches the real bytes", () => {
  assert.equal(sha256Hex(vendored), meta.sha256)
})

test("provenance: meta.bytes matches the real byte length", () => {
  assert.equal(vendored.length, meta.bytes)
})

test("provenance: meta.gitBlob matches the real git blob", () => {
  assert.equal(gitBlobSha(vendored), meta.gitBlob)
})

test("provenance: the pin in src/preset.ts matches meta.ref", () => {
  const matches = [...preset.matchAll(/version:\s*"([^"]+)"/g)]
  assert.equal(matches.length, 1, "expected exactly one version line in src/preset.ts")
  assert.equal(matches[0][1], meta.ref)
})

test("provenance: the sha256 recorded in vendor/README.md matches", () => {
  const match = /^\|\s*sha256\s*\|\s*`([0-9a-f]{64})`\s*\|$/im.exec(readme)
  assert.ok(match, "vendor/README.md must record a sha256")
  assert.equal(match[1], meta.sha256)
})

test("provenance: the version, blob, and bytes in vendor/README.md match", () => {
  assert.equal(/^\|\s*Version\s*\|\s*`([^`]+)`\s*\|$/im.exec(readme)?.[1], meta.ref)
  assert.equal(/^\|\s*Git blob\s*\|\s*`([0-9a-f]{40})`\s*\|$/im.exec(readme)?.[1], meta.gitBlob)
  assert.equal(Number(/^\|\s*Bytes\s*\|\s*(\d+)\s*\|$/im.exec(readme)?.[1]), meta.bytes)
})

test("provenance: the meta file names the upstream identity", () => {
  assert.equal(meta.id, "rtk")
  assert.equal(meta.upstream, "rtk-ai/rtk")
  assert.equal(meta.path, "hooks/opencode/rtk.ts")
  assert.equal(meta.license, "Apache-2.0")
  assert.equal(fs.existsSync(new URL("../vendor/rtk-LICENSE", import.meta.url)), true)
})
