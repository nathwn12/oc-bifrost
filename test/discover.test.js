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

test("discover: V1 named export is discovered by SHAPE when the name has no Plugin suffix", () => {
  // tlinhart/opencode-system-prompt-logger exports only `SystemPromptLogger` -
  // a textbook V1 factory whose name the legacy `/Plugin$/` heuristic missed.
  // The shape check (a named function export is a factory by the V1 contract)
  // must accept it regardless of the name.
  const factory = async () => ({ "experimental.chat.system.transform": async () => {} })
  const result = discover({ SystemPromptLogger: factory }, "index.ts")
  assert.equal(result.kind, "v1")
  assert.equal(result.id, "SystemPromptLogger")
  assert.equal(result.factory, factory)
  assert.match(result.note, /by shape/)
})

test("discover: another suffixless V1 factory (DirenvLoader-shaped) is discovered by shape", () => {
  // simonwjackson/opencode-direnv exports only `DirenvLoader`.
  const factory = async () => ({ event: async () => {} })
  const result = discover({ DirenvLoader: factory }, "src/index.ts")
  assert.equal(result.kind, "v1")
  assert.equal(result.id, "DirenvLoader")
  assert.equal(result.factory, factory)
})

test("discover: a plugin-named export still wins over an earlier helper function", () => {
  // The legacy name heuristic stays as the PREFERENCE: when a module exports
  // several functions, the one whose name ends in Plugin is chosen even when
  // a helper export comes first in module order - the shape pass alone would
  // mis-pick the helper.
  const plugin = async () => ({})
  const helper = async () => {}
  const result = discover({ helper, MySpecialPlugin: plugin }, "special.ts")
  assert.equal(result.kind, "v1")
  assert.equal(result.factory, plugin)
})

test("discover: a suffixless helper-only module is still refused when no export is a factory", () => {
  // Shape recognition widens the gate to named FUNCTIONS only; a module whose
  // exports are all non-functions is not a V1 factory and stays refused out
  // loud - including names that merely look plugin-ish.
  const result = discover({ SystemPromptLogger: { init: true } }, "not-a-plugin.ts")
  assert.equal(result.kind, "unknown")
  assert.match(result.reason, /no V1 factory/)
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
