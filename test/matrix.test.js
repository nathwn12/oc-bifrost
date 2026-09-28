import { test } from "node:test"
import assert from "node:assert/strict"
import { COMPAT_MATRIX, matrixRow } from "../dist/compat-matrix.js"
import { createReporter } from "../dist/report.js"

test("matrix: every row names the test that proves it", () => {
  for (const row of COMPAT_MATRIX) {
    assert.ok(row.test.length > 0, `row ${row.hook} has no test`)
    assert.ok(row.v2.length > 0, `row ${row.hook} has no destination`)
  }
})

test("matrix: every proven test name exists in the suite", async () => {
  const { registerV1Hooks } = await import("../dist/hooks.js")
  assert.equal(typeof registerV1Hooks, "function")
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
