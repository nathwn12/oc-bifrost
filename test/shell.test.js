import { test } from "node:test"
import assert from "node:assert/strict"
import { createShell } from "../dist/shell.js"

test("shell: tagged template resolves stdout", async () => {
  const $ = createShell()
  const result = await $`node -e "process.stdout.write('ok')"`.quiet()
  assert.equal(result.stdout, "ok")
  assert.equal(result.exitCode, 0)
})

test("shell: nothrow suppresses a non-zero exit", async () => {
  const $ = createShell()
  const result = await $`node -e "process.exit(3)"`.quiet().nothrow()
  assert.equal(result.exitCode, 3)
})

test("shell: a non-zero exit rejects without nothrow", async () => {
  const $ = createShell()
  await assert.rejects(async () => {
    await $`node -e "process.exit(3)"`.quiet()
  })
})

test("shell: interpolation is quoted as a single argument", async () => {
  const $ = createShell()
  const value = "a b"
  const result = await $`node -e "process.stdout.write(process.argv[1])" ${value}`.quiet()
  assert.equal(result.stdout, value)
})
