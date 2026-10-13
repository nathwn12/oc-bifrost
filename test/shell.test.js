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

/* ---- shell-string removal: an interpolated value is argv data, never syntax ---- */

/**
 * The facade composed a command STRING and spawned it with `shell: true`, so on
 * Windows (`cmd.exe`) a payload inside an interpolation ended the quoting and ran
 * as a SECOND command - `x" & echo BIFROST_INJECTED` printed its own line and the
 * call still exited 0. These cases model that failing state: the value must come
 * back verbatim as exactly one argv element, on every shell.
 */
test("shell: an interpolated value can never become a second command", async () => {
  const $ = createShell()
  const payload = 'x" & echo BIFROST_INJECTED'
  const result = await $`node -e "process.stdout.write(process.argv[1])" ${payload}`.quiet()
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, payload, "the value must arrive as ONE argv element, verbatim")
  assert.equal(result.stdout.split("\n").length, 1, "an injected second command would add its own line")
})

test("shell: substitution and expansion inside an interpolated value stay literal", async () => {
  const $ = createShell()
  for (const payload of ["$(echo INJECTED)", "`echo INJECTED`", "%USERNAME%", "$HOME", "a b", ""]) {
    const result = await $`node -e "process.stdout.write(process.argv[1])" ${payload}`.quiet()
    assert.equal(result.stdout, payload, `${JSON.stringify(payload)} must travel as data`)
  }
})

/* ---- the refusal half: syntax only a shell could honour is named, never guessed ---- */

test("shell: command text carrying shell syntax is refused by name", () => {
  const $ = createShell()
  const refusals = [
    () => $`cat f | grep x`,
    () => $`a && b`,
    () => $`a ; b`,
    () => $`a > out.txt`,
    () => $`ls *.ts`,
    () => $`echo $HOME`,
    () => $`echo \${HOME}`,
    () => $`echo %TEMP%`,
    () => $`echo $(id)`,
    () => $`echo \`id\``,
    () => $`~/bin/thing`,
    () => $`# just a comment`,
  ]
  for (const run of refusals) {
    assert.throws(run, /only a shell could interpret|no shell performs here/, "every shell-only form must be refused loudly")
  }
  // The refusal names the offending text, so the author can see what to change.
  assert.throws(() => $`cat f | grep x`, /\|/)
  assert.throws(() => $`echo $HOME`, /\$HOME/)
  assert.throws(() => $`echo %TEMP%`, /%TEMP%/)
})

test("shell: literal text that a shell would NOT have changed is still accepted", async () => {
  const $ = createShell()
  // `%h` is not an expansion (no closing `%`), `$` at word end is literal data,
  // and a quoted argument keeps its grouping. `--` keeps node from reading the
  // flags as its own options.
  const result = await $`node -e "process.stdout.write(process.argv.slice(1).join('|'))" -- --format=%h --regex=$ "two words"`.quiet()
  assert.equal(result.stdout, "--format=%h|--regex=$|two words")
})
