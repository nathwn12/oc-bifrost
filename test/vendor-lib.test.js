import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import {
  gitBlobSha,
  isValidRef,
  renderProvenanceTable,
  rewritePin,
  sha256Hex,
  validateVendorFile,
} from "../scripts/vendor-lib.mjs"

/**
 * Vendor tooling tests — all offline.
 *
 * The updater writes bytes it downloaded, so these pure helpers are the last
 * line of defence: a bad hash, a wrong-file gate, or a guessed pin rewrite would
 * corrupt the repo. Each is proven here without touching the network.
 */

test("gitBlobSha: matches git's canonical blob hash", () => {
  assert.equal(gitBlobSha("test content\n"), "d670460b4b4aece5915caf5c68d12f560a9fe3e4")
})

test("gitBlobSha: Buffer and string agree, and length is byte length", () => {
  const text = "héllo\n"
  assert.equal(gitBlobSha(text), gitBlobSha(Buffer.from(text, "utf8")))
  assert.equal(gitBlobSha(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
})

test("sha256Hex: hashes the raw bytes", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})

test("validateVendorFile: rejects empty and whitespace-only content", () => {
  assert.equal(validateVendorFile("").ok, false)
  const blank = validateVendorFile("   \n\t ")
  assert.equal(blank.ok, false)
  assert.match(blank.reason, /empty/)
})

test("validateVendorFile: rejects content larger than 64 KiB", () => {
  const big = "export const Plugin = 1\n" + "x".repeat(64 * 1024)
  const result = validateVendorFile(big)
  assert.equal(result.ok, false)
  assert.match(result.reason, /larger than/)
})

test("validateVendorFile: rejects an HTML error page", () => {
  const result = validateVendorFile("<!DOCTYPE html><html><body>500</body></html>")
  assert.equal(result.ok, false)
  assert.match(result.reason, /HTML/i)
})

test("validateVendorFile: rejects anything that is not a plugin", () => {
  const noExport = validateVendorFile("const Plugin = 1\n")
  assert.equal(noExport.ok, false)
  assert.match(noExport.reason, /export/)

  const noPlugin = validateVendorFile("export const x = 1\n")
  assert.equal(noPlugin.ok, false)
  assert.match(noPlugin.reason, /Plugin/)
})

test("validateVendorFile: accepts the real vendored file", () => {
  const content = fs.readFileSync(fileURLToPath(new URL("../vendor/rtk.ts", import.meta.url)), "utf8")
  assert.deepEqual(validateVendorFile(content), { ok: true })
})

test("rewritePin: replaces the single version line", () => {
  const source = 'export const PRESETS = {\n  rtk: {\n    version: "v0.50.0",\n  },\n}\n'
  const next = rewritePin(source, "v0.51.0")
  assert.match(next, /version: "v0\.51\.0"/)
  assert.doesNotMatch(next, /v0\.50\.0/)
})

test("rewritePin: throws when there is no version line", () => {
  assert.throws(() => rewritePin("export const x = 1\n", "v1.0.0"), /no `version:/)
})

test("rewritePin: throws when there is more than one match", () => {
  const source = 'a: {\n  version: "v1.0.0",\n}\nb: {\n  version: "v2.0.0",\n}\n'
  assert.throws(() => rewritePin(source, "v3.0.0"), /exactly one/)
})

test("rewritePin: a version containing replacement tokens is inserted literally", () => {
  const source = 'export const x = {\n  version: "v0.50.0",\n}\n'
  const next = rewritePin(source, "v1.0.0-$&")
  assert.equal(next, 'export const x = {\n  version: "v1.0.0-$&",\n}\n')
})

test("isValidRef: accepts safe tags and rejects the dangerous ones", () => {
  for (const ref of ["v0.50.0", "main", "release/v1.2.3", "1.2.3"]) {
    assert.equal(isValidRef(ref), true, `${ref} should be valid`)
  }
  for (const ref of ["", "-evil", "a..b", "v1;rm -rf", "ref with space", "v$&", "a/b/../../c"]) {
    assert.equal(isValidRef(ref), false, `${ref} should be refused`)
  }
})

test("renderProvenanceTable: renders the README rows from meta", () => {
  const table = renderProvenanceTable({
    upstream: "rtk-ai/rtk",
    path: "hooks/opencode/rtk.ts",
    ref: "v0.50.0",
    gitBlob: "abc",
    sha256: "def",
    bytes: 1339,
    license: "Apache-2.0",
  })
  assert.match(table, /^\| Field \| Value \|$/m)
  assert.match(table, /\| Upstream \| \[`rtk-ai\/rtk`\]\(https:\/\/github\.com\/rtk-ai\/rtk\) \|/)
  assert.match(table, /\| Version \| `v0\.50\.0` \|/)
  assert.match(table, /\| Bytes \| 1339 \|/)
  assert.match(table, /\| \*\*Changes\*\* \| \*\*none — byte-identical\*\* \|/)
})
