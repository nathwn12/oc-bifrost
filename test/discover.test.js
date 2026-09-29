import { test } from "node:test"
import assert from "node:assert/strict"
import { discover } from "../dist/discover.js"

test("discover: V1 default factory export", () => {
  const result = discover({ default: async () => ({}) }, "./legacy/thing.ts")
  assert.equal(result.kind, "v1")
  assert.equal(result.id, "thing")
})

test("discover: V1 named Plugin export", () => {
  const factory = async () => ({})
  const result = discover({ RtkOpenCodePlugin: factory }, "rtk.ts")
  assert.equal(result.kind, "v1")
  assert.equal(result.factory, factory)
})

test("discover: V1 module server export", () => {
  const server = async () => ({})
  const result = discover({ id: "legacy.mod", server }, "mod.ts")
  assert.equal(result.kind, "v1")
  assert.equal(result.id, "legacy.mod")
})

test("discover: V2 definition is recognised", () => {
  const result = discover({ default: { id: "modern", setup: () => {} } }, "modern.ts")
  assert.equal(result.kind, "v2")
  assert.equal(result.id, "modern")
})

test("discover: a dual-export file mounts its V2 default and leaves the V1 named export alone", () => {
  // obra/superpowers@v6.4.2 ships both: a V1 factory named export AND a V2
  // default definition. Discovery picks the V2 definition and route it as a
  // pass-through — the named V1 export is NOT hook-translated.
  const v1 = async () => ({})
  const result = discover(
    { SuperpowersPlugin: v1, default: { id: "superpowers", setup: () => {} } },
    "superpowers.ts",
  )
  assert.equal(result.kind, "v2")
  assert.equal(result.id, "superpowers")
})

test("discover: unknown module is reported, never guessed", () => {
  const result = discover({ somethingElse: 1 }, "nope.ts")
  assert.equal(result.kind, "unknown")
})
