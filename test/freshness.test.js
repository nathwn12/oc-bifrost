import { test } from "node:test"
import assert from "node:assert/strict"
import { compareTags, freshnessEnabled, pinnedNote, checkFreshness } from "../dist/freshness.js"
import * as root from "../dist/index.js"

/**
 * Freshness tests — all offline.
 *
 * The online path is exercised through an injected `fetchImpl`, never the real
 * network: CI runs without one. The point of these tests is the contract that
 * matters — the check NEVER throws, no matter how badly the network or the
 * response misbehaves.
 */

const SPEC = {
  id: "rtk",
  source: "rtk-ai/rtk",
  version: "v0.50.0",
  license: "Apache-2.0",
  entry: new URL("file:///tmp/rtk.ts"),
  requires: { binary: "rtk", minimumVersion: "0.23.0", hint: "" },
}

/** A fake fetch that records its calls and returns a canned response. */
function fakeFetch(responseOrThrows) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    if (responseOrThrows instanceof Error) throw responseOrThrows
    return responseOrThrows
  }
  impl.calls = calls
  return impl
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  }
}

test("freshness: the surface is exported from the package root", () => {
  for (const name of ["compareTags", "pinnedNote", "freshnessEnabled", "checkFreshness"]) {
    assert.equal(typeof root[name], "function", `package root must export ${name}`)
  }
})

test("compareTags: numeric ordering and v-prefix are equivalent", () => {
  assert.equal(compareTags("v1.2.3", "1.2.3"), 0)
  assert.equal(compareTags("1.2.3", "1.2.4"), -1)
  assert.equal(compareTags("1.2.4", "1.2.3"), 1)
  assert.equal(compareTags("v2.0.0", "v1.9.9"), 1)
  assert.equal(compareTags("1.2", "1.2.0"), 0)
})

test("compareTags: a prerelease ranks below its release", () => {
  assert.equal(compareTags("v1.0.0-rc1", "v1.0.0"), -1)
  assert.equal(compareTags("v1.0.0", "v1.0.0-rc1"), 1)
  assert.equal(compareTags("v1.0.0-rc1", "v1.0.0-rc2"), -1)
  assert.equal(compareTags("v1.0.0-rc.2", "v1.0.0-rc.10"), -1)
})

test("compareTags: junk input never throws and tolerates missing segments", () => {
  assert.doesNotThrow(() => compareTags("", ""))
  assert.equal(compareTags("", ""), 0)
  assert.equal(compareTags("junk", ""), 0)
  assert.equal(compareTags("v1.x.3", "v1.0.3"), 0)
  assert.equal(compareTags("not-a-version", "v1.0.0"), -1)
})

test("pinnedNote: names the preset, version, and upstream source", () => {
  const note = pinnedNote(SPEC)
  assert.equal(note, "vendored rtk v0.50.0 (rtk-ai/rtk)")
})

test("freshnessEnabled: an explicit option wins over the env var", () => {
  assert.equal(freshnessEnabled("online", {}), true)
  assert.equal(freshnessEnabled("off", { OC_BIFROST_FRESHNESS: "online" }), false)
  assert.equal(freshnessEnabled("ONLINE", {}), true)
})

test("freshnessEnabled: falls back to the env var, and defaults off", () => {
  assert.equal(freshnessEnabled(undefined, { OC_BIFROST_FRESHNESS: "online" }), true)
  assert.equal(freshnessEnabled(undefined, { OC_BIFROST_FRESHNESS: "off" }), false)
  assert.equal(freshnessEnabled(undefined, {}), false)
})

test("checkFreshness: behind when upstream is newer", async () => {
  const impl = fakeFetch(jsonResponse({ tag_name: "v0.60.0" }))
  const result = await checkFreshness(SPEC, { fetchImpl: impl })
  assert.equal(result.status, "behind")
  assert.equal(result.pinned, "v0.50.0")
  assert.equal(result.latest, "v0.60.0")
  assert.match(result.message, /behind/)
  assert.match(result.message, /npm run vendor:update/)
  assert.match(result.message, /npm i @nathwn12\/oc-bifrost@latest/)
})

test("checkFreshness: current when upstream is equal or older", async () => {
  const equal = await checkFreshness(SPEC, { fetchImpl: fakeFetch(jsonResponse({ tag_name: "v0.50.0" })) })
  assert.equal(equal.status, "current")
  assert.equal(equal.latest, "v0.50.0")

  const older = await checkFreshness(SPEC, { fetchImpl: fakeFetch(jsonResponse({ tag_name: "v0.40.0" })) })
  assert.equal(older.status, "current")
})

test("checkFreshness: the injected fetch receives the timeout signal", async () => {
  const impl = fakeFetch(jsonResponse({ tag_name: "v0.50.0" }))
  await checkFreshness(SPEC, { fetchImpl: impl, timeoutMs: 1234 })
  assert.equal(impl.calls.length, 1)
  assert.ok(impl.calls[0].init.signal instanceof AbortSignal, "fetch must receive an AbortSignal")
  assert.match(impl.calls[0].url, /api\.github\.com\/repos\/rtk-ai\/rtk\/releases\/latest/)
  assert.equal(impl.calls[0].init.headers["user-agent"].length > 0, true)
})

test("checkFreshness: non-2xx is unknown, never a throw", async () => {
  const result = await checkFreshness(SPEC, { fetchImpl: fakeFetch(jsonResponse({}, { ok: false, status: 500 })) })
  assert.equal(result.status, "unknown")
  assert.match(result.message, /could not be checked/)
})

test("checkFreshness: a thrown fetch is unknown, never a throw", async () => {
  const result = await checkFreshness(SPEC, { fetchImpl: fakeFetch(new Error("offline")) })
  assert.equal(result.status, "unknown")
  assert.match(result.message, /could not be checked/)
})

test("checkFreshness: malformed JSON is unknown", async () => {
  const impl = fakeFetch({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("bad json")
    },
  })
  const result = await checkFreshness(SPEC, { fetchImpl: impl })
  assert.equal(result.status, "unknown")
})

test("checkFreshness: an actual timeout is unknown, never a throw", async () => {
  // A fetch that never settles honors the abort signal the same way the real
  // fetch does, so a tiny timeout genuinely drives the timeout path.
  //
  // It must also hold the event loop open, exactly as a real in-flight request
  // does: `AbortSignal.timeout`'s timer is unref'd, so a fake whose only way to
  // settle is that timer leaves the loop with no handle at all. Node 22 drains
  // it before the abort can fire and the runner cancels the test; the pending
  // timer below is the in-flight handle the real socket would provide.
  const impl = (_url, init) =>
    new Promise((_resolve, reject) => {
      const inFlight = setTimeout(() => reject(new Error("the request never returned")), 60_000)
      init.signal.addEventListener("abort", () => {
        clearTimeout(inFlight)
        reject(new Error("The operation was aborted."))
      })
    })
  const result = await checkFreshness(SPEC, { fetchImpl: impl, timeoutMs: 20 })
  assert.equal(result.status, "unknown")
  assert.match(result.message, /could not be checked/)
})

test("checkFreshness: a missing tag_name is unknown", async () => {
  const result = await checkFreshness(SPEC, { fetchImpl: fakeFetch(jsonResponse({})) })
  assert.equal(result.status, "unknown")
})

test("checkFreshness: an empty tag_name is unknown", async () => {
  const result = await checkFreshness(SPEC, { fetchImpl: fakeFetch(jsonResponse({ tag_name: "   " })) })
  assert.equal(result.status, "unknown")
})
