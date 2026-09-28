import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { PRESETS, checkPrerequisite, missingBinaryMessage } from "../dist/preset.js"

test("preset: rtk carries the pinned identity", () => {
  const rtk = PRESETS.rtk
  assert.ok(rtk)
  assert.equal(rtk.id, "rtk")
  assert.equal(rtk.source, "rtk-ai/rtk")
  assert.equal(rtk.version, "v0.50.0")
  assert.equal(rtk.license, "Apache-2.0")
  assert.equal(rtk.requires.binary, "rtk")
  assert.equal(rtk.requires.minimumVersion, "0.23.0")
  assert.match(rtk.requires.hint, /winget install rtk-ai\.rtk/)
  assert.match(rtk.requires.hint, /brew install rtk/)
  assert.match(rtk.requires.hint, /cargo install rtk/)
})

test("preset: the entry URL points at the bundled vendor file", () => {
  const file = fileURLToPath(PRESETS.rtk.entry)
  assert.equal(fs.existsSync(file), true)
  assert.match(file.replace(/\\/g, "/"), /\/vendor\/rtk\.ts$/)
})

test("preset: missing-binary message names the binary and the consequence", () => {
  const message = missingBinaryMessage(PRESETS.rtk)
  assert.match(message, /rtk/)
  assert.match(message, /not found/)
  assert.match(message, /self-disable/)
  assert.doesNotMatch(message, /"rtk" found in PATH/)
})

test("preset: a failing probe reports failure, never success", async () => {
  const failing = () => ({
    quiet: () => {
      throw new Error("not found")
    },
  })
  const check = await checkPrerequisite(PRESETS.rtk, failing)
  assert.equal(check.ok, false)
  assert.match(check.message, /rtk/)
  assert.doesNotMatch(check.message, /"rtk" found in PATH/)
})

test("preset: a successful probe reports the detected version", async () => {
  const shell = (strings) => {
    const command = Array.from(strings).join("")
    const result = command.includes("--version")
      ? { stdout: "rtk 0.23.4\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 }
    return {
      quiet() {
        return this
      },
      nothrow() {
        return this
      },
      then(resolve, reject) {
        return Promise.resolve(result).then(resolve, reject)
      },
    }
  }
  const check = await checkPrerequisite(PRESETS.rtk, shell)
  assert.equal(check.ok, true)
  assert.match(check.version, /0\.23\.4/)
  assert.match(check.message, /found in PATH/)
})
