import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { COMPAT_MATRIX, matrixRow } from "../dist/compat-matrix.js"
import { createReporter } from "../dist/report.js"

const testDirectory = dirname(fileURLToPath(import.meta.url))

/**
 * Every test name the suite registers, read from the source of test/*.test.js.
 * Names must be string literals; a dynamically built name is deliberately not
 * discoverable here, because the matrix contract needs an exact, greppable name.
 */
function suiteTestNames() {
  const names = new Set()
  for (const file of readdirSync(testDirectory).filter((name) => name.endsWith(".test.js"))) {
    const source = readFileSync(join(testDirectory, file), "utf8")
    for (const match of source.matchAll(/\btest\(\s*(?:"([^"]+)"|'([^']+)')/g)) {
      names.add(match[1] ?? match[2])
    }
  }
  return names
}

test("matrix: every row names the test that proves it", () => {
  for (const row of COMPAT_MATRIX) {
    assert.ok(row.test.length > 0, `row ${row.hook} has no test`)
    assert.ok(row.v2.length > 0, `row ${row.hook} has no destination`)
  }
})

test("matrix: every proven test name exists in the suite", () => {
  const registered = suiteTestNames()
  assert.ok(registered.size > 0, "the test-name scan found nothing — the guard itself is broken")
  const missing = COMPAT_MATRIX.filter((row) => !registered.has(row.test)).map(
    (row) => `  ${row.hook} -> "${row.test}"`,
  )
  assert.equal(
    missing.length,
    0,
    `compat-matrix rows name tests that test/*.test.js does not register:\n${missing.join("\n")}`,
  )
})

test("matrix: tool.execute.before is a full bridge", () => {
  assert.equal(matrixRow("tool.execute.before")?.level, "full")
})

test("matrix: unmappable hooks are refused, not faked", () => {
  for (const hook of [
    "experimental.provider.small_model",
    "experimental.compaction.autocontinue",
    "experimental.text.complete",
  ]) {
    assert.equal(matrixRow(hook)?.level, "unsupported", `${hook} must be unsupported`)
  }
})

test("reporter: strict mode aborts on an unsupported hook", () => {
  const reporter = createReporter("strict-test", { strict: true })
  assert.throws(() => reporter.record("config", "unsupported", "no equivalent"))
})

test("reporter: default mode warns and continues", () => {
  const reporter = createReporter("soft-test", {})
  reporter.record("config", "unsupported", "no equivalent")
  assert.equal(reporter.reports.length, 1)
})
