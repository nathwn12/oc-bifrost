import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { sha256Hex } from "../scripts/vendor-lib.mjs"

/**
 * Updater integration tests — all offline.
 *
 * These drive the real CLI with `--from-file`, which is the offline path and
 * must never touch the network. The point is the safety contract: a dry run and
 * every refusal leave the working tree byte-identical.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const CLI = path.join(ROOT, "scripts", "vendor-update.mjs")
const TARGETS = ["vendor/rtk.ts", "vendor/rtk.meta.json", "vendor/README.md", "src/preset.ts"]

function run(args, cwd = ROOT) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" })
}

function snapshot(cwd = ROOT) {
  return Object.fromEntries(TARGETS.map((rel) => [rel, fs.readFileSync(path.join(cwd, rel))]))
}

function assertUnchanged(before, cwd = ROOT) {
  for (const rel of TARGETS) {
    assert.deepEqual(fs.readFileSync(path.join(cwd, rel)), before[rel], `${rel} must be untouched`)
  }
}

test("vendor-update: a dry run with --from-file changes nothing", () => {
  const before = snapshot()
  const result = run(["--dry-run", "--from-file", "vendor/rtk.ts"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /dry run/)
  assert.match(result.stderr, /DRY RUN WITHOUT VERIFICATION/)
  assertUnchanged(before)
})

test("vendor-update: a dry run with a matching --expect-sha256 verifies and changes nothing", () => {
  const before = snapshot()
  const digest = sha256Hex(fs.readFileSync(path.join(ROOT, "vendor", "rtk.ts")))
  const result = run(["--dry-run", "--from-file", "vendor/rtk.ts", "--expect-sha256", digest])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /verified against the supplied digest/)
  assertUnchanged(before)
})

test("vendor-update: --from-file without a digest refuses to write unless it is a dry run", () => {
  const before = snapshot()
  const result = run(["--from-file", "vendor/rtk.ts"])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires independent verification/)
  assertUnchanged(before)
})

test("vendor-update: a wrong --expect-sha256 refuses to write", () => {
  const before = snapshot()
  const result = run(["--from-file", "vendor/rtk.ts", "--expect-sha256", "0".repeat(64)])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /refusing to write/)
  assertUnchanged(before)
})

test("vendor-update: an unexpected layout fails loudly and writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-vendor-"))
  try {
    for (const sub of ["scripts", "vendor", "src"]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
    fs.copyFileSync(path.join(ROOT, "scripts", "vendor-lib.mjs"), path.join(dir, "scripts", "vendor-lib.mjs"))
    fs.copyFileSync(path.join(ROOT, "scripts", "vendor-update.mjs"), path.join(dir, "scripts", "vendor-update.mjs"))
    fs.copyFileSync(path.join(ROOT, "vendor", "rtk.ts"), path.join(dir, "vendor", "rtk.ts"))
    fs.copyFileSync(path.join(ROOT, "vendor", "README.md"), path.join(dir, "vendor", "README.md"))
    fs.copyFileSync(path.join(ROOT, "vendor", "rtk.meta.json"), path.join(dir, "vendor", "rtk.meta.json"))
    // A preset file with no rtk version line, at all.
    fs.writeFileSync(path.join(dir, "src", "preset.ts"), "export const PRESETS = {}\n")

    const before = fs.readFileSync(path.join(dir, "vendor", "rtk.ts"))
    const digest = sha256Hex(before)
    const result = spawnSync(
      process.execPath,
      [path.join(dir, "scripts", "vendor-update.mjs"), "--ref", "v0.50.0", "--from-file", path.join(dir, "vendor", "rtk.ts"), "--expect-sha256", digest, "--skip-tests"],
      { cwd: dir, encoding: "utf8" },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /nothing written/)
    assert.deepEqual(fs.readFileSync(path.join(dir, "vendor", "rtk.ts")), before)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
