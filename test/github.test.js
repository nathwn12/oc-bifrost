import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveSpec } from "../dist/index.js"
import {
  assertInsideRoot,
  consentMessage,
  githubCacheId,
  githubLabel,
  mountNote,
  parseGithubSpec,
  remoteTrustEnabled,
  resolveGithubPlugin,
  sha256Hex,
  validateCachePath,
} from "../dist/github.js"

/**
 * github: specifiers — mount a V1 plugin BY SOURCE, under the security
 * contract the review required:
 *
 *   - consent: a cold cache refuses to fetch+execute without opt-in
 *   - cache first: a warm cache loads with ZERO fetch calls, no re-consent
 *   - immutable identity: the ref resolves to a commit, recorded in meta
 *   - strict validation: no traversal, absolute paths, backslashes, encoded
 *     separators, control chars, or empty segments — URLs built from a fixed
 *     origin with component-aware encoding
 *   - fail closed offline; sanitized messages; size-capped, origin-pinned
 *     fetches; symlink/type-checked cache entries
 *
 * All offline: the network surface is an injected fetchImpl, never the real
 * network (CI runs without one), and all state lives in tmp dirs.
 */

const SRC = 'export default { id: "demo", setup() {} }\n'
const COMMIT = "abcdef1234567890abcdef1234567890abcdef12"

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-github-test-"))
}

/** Never-fetch sentinel: proves a path performs zero network. */
function noNetwork() {
  return async () => {
    throw new Error("the load path must never touch the network")
  }
}

/**
 * A fake fetch standing in for the GitHub API (repo info + commit resolution)
 * and the raw content surface. `contents` maps an in-repo path to its bytes;
 * an unlisted raw path is a 404, like the real thing. `contentsAtCommit` is
 * served INSTEAD when the raw URL names the resolved commit — which the real
 * code always does — so a test can distinguish "fetched by ref" from "fetched
 * by commit". `defaultBranch: null` fails the repo info call;
 * `commitSha: null` fails commit resolution; `rawStatus` overrides the raw
 * status (e.g. 302 to exercise redirect refusals).
 */
function fakeFetch({ defaultBranch = "main", commitSha = COMMIT, contents = {}, contentsAtCommit, rawStatus = 200 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    if (url.startsWith("https://api.github.com/repos/")) {
      const commitMatch = url.match(/\/commits\/(.+)$/)
      if (commitMatch) {
        if (commitSha === null) return { ok: false, status: 404, text: async () => "", json: async () => ({}) }
        return { ok: true, status: 200, text: async () => "", json: async () => ({ sha: commitSha }) }
      }
      if (defaultBranch === null) return { ok: false, status: 404, text: async () => "", json: async () => ({}) }
      return { ok: true, status: 200, text: async () => "", json: async () => ({ default_branch: defaultBranch }) }
    }
    const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
    if (raw) {
      if (rawStatus !== 200) return { ok: false, status: rawStatus, text: async () => "", json: async () => ({}) }
      const pool = raw[3] === commitSha && contentsAtCommit ? contentsAtCommit : contents
      const content = pool[raw[4]]
      if (content === undefined) return { ok: false, status: 404, text: async () => "", json: async () => ({}) }
      return { ok: true, status: 200, text: async () => content, json: async () => ({}) }
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) }
  }
  impl.calls = calls
  return impl
}

const SPECS = {
  bare: { owner: "obra", repo: "superpowers" },
  full: { owner: "rtk-ai", repo: "rtk", ref: "v0.50.0", path: "hooks/opencode/rtk.ts" },
}

function expectedMeta(overrides) {
  return {
    source: "github",
    owner: "obra",
    repo: "superpowers",
    ref: "main",
    resolvedCommit: COMMIT,
    path: "hooks/opencode/superpowers.ts",
    sha256: sha256Hex(SRC),
    bytes: Buffer.byteLength(SRC, "utf8"),
    fetchedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

/* ---- strict spec validation ---- */

test("parseGithubSpec: the full form splits owner, repo, ref, and path", () => {
  assert.deepEqual(parseGithubSpec("github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts"), SPECS.full)
})

test("parseGithubSpec: ref and path are each optional", () => {
  assert.deepEqual(parseGithubSpec("github:obra/superpowers"), SPECS.bare)
  assert.deepEqual(parseGithubSpec("github:obra/superpowers@v1.2.3"), { owner: "obra", repo: "superpowers", ref: "v1.2.3" })
  assert.deepEqual(parseGithubSpec("github:obra/superpowers#plugin.ts"), { owner: "obra", repo: "superpowers", path: "plugin.ts" })
})

test("parseGithubSpec: a ref may name a branch with a slash", () => {
  assert.deepEqual(parseGithubSpec("github:obra/superpowers@feature/next"), {
    owner: "obra",
    repo: "superpowers",
    ref: "feature/next",
  })
})

test("parseGithubSpec: malformed forms refuse loudly", () => {
  for (const bad of ["github:obra", "github:/repo", "github:obra/", "github:obra/r/extra", "github:o/r@-bad", "github:o/r@a@b", "github:o/r@"]) {
    assert.throws(() => parseGithubSpec(bad), /\[oc-bifrost\] invalid specifier/, `expected a refusal for "${bad}"`)
  }
})

test("parseGithubSpec: hostile shapes are refused (traversal, absolute, backslash, encoded separator, control char, empty segment)", () => {
  for (const bad of [
    "github:o/r#../etc/passwd",
    "github:o/r#/abs/x.ts",
    "github:o/r#hooks\\opencode\\x.ts",
    "github:o/r#hooks/opencode%2Frtk.ts",
    "github:o/r#hooks/\u0000x.ts",
    "github:o/r#hooks//x.ts",
    "github:o/r#hooks/./x.ts",
    "github:o/r#hooks/../x.ts",
    "github:../o/r",
    "github:o/..",
    "github:o/r@v1%2e0",
  ]) {
    assert.throws(() => parseGithubSpec(bad), /\[oc-bifrost\]/, `expected a refusal for "${bad}"`)
  }
})

test("githubLabel: round-trips the parsed form", () => {
  assert.equal(githubLabel(SPECS.full), "github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts")
  assert.equal(githubLabel(SPECS.bare), "github:obra/superpowers")
})

/* ---- specifier routing ---- */

test("resolveSpec: a github: spec parses to the github kind", () => {
  assert.deepEqual(resolveSpec("github:obra/superpowers", "some/dir"), {
    kind: "github",
    spec: SPECS.bare,
  })
})

test("resolveSpec: npm: is refused with the accepted-forms message (not built yet)", () => {
  assert.throws(() => resolveSpec("npm:left-pad", "some/dir"), /not yet supported/)
  assert.throws(() => resolveSpec("npm:left-pad", "some/dir"), /accepted forms are: preset:, github:, ~\/path, \.\/path/)
})

test("resolveSpec: a bare package name is refused with the accepted-forms message", () => {
  assert.throws(() => resolveSpec("some-plugin-package", "some/dir"), /not yet supported/)
  assert.throws(() => resolveSpec("some-plugin-package", "some/dir"), /accepted forms are: preset:, github:/)
})

/* ---- cache hardening: id + inside-root guard ---- */

test("githubCacheId: filesystem-safe, deterministic, and distinct per distinct spec", () => {
  const id = githubCacheId(SPECS.full)
  assert.match(id, /^[A-Za-z0-9._-]+$/, "the id must be filesystem-safe")
  assert.equal(id, githubCacheId(SPECS.full), "the id must be deterministic")
  const a = githubCacheId({ owner: "o", repo: "r", ref: "v1", path: "a/b.ts" })
  const b = githubCacheId({ owner: "o", repo: "r", ref: "v1", path: "a-b.ts" })
  assert.notEqual(a, b, "sanitizer collisions must be impossible")
})

test("assertInsideRoot: the cache-path guard fails closed outside the root", () => {
  const root = path.resolve(os.tmpdir(), "oc-bifrost-inside-root-test")
  assert.doesNotThrow(() => assertInsideRoot(root, path.join(root, "a", "b")))
  assert.throws(() => assertInsideRoot(root, root), /does not stay inside the cache root/)
  assert.throws(() => assertInsideRoot(root, path.join(root, "..", "elsewhere")), /does not stay inside the cache root/)
  assert.throws(() => assertInsideRoot(root, path.resolve(path.dirname(root), "elsewhere")), /does not stay inside the cache root/)
})

test("validateCachePath: absent root and entry pass (the cold path creates them)", () => {
  const root = path.join(tmpRoot(), "not-created-yet")
  assert.doesNotThrow(() => validateCachePath(root, path.join(root, githubCacheId(SPECS.bare))))
})

test("cache-path boundary: an EMPTY symlinked entry directory is refused before any fetch or write, and nothing lands outside the root", async () => {
  const root = tmpRoot()
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-github-empty-target-"))
  try {
    // A link pointing OUTSIDE the root, with NO marker files: the cold-cache
    // check sees neither plugin.ts nor meta.json, so this is exactly the case
    // where an unchecked fetch path would write THROUGH the link.
    fs.symlinkSync(target, path.join(root, githubCacheId(SPECS.bare)), "junction")
    const impl = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /symlink, and cache writes must never follow one/,
    )
    assert.equal(impl.calls.length, 0, "the boundary must fire before ANY fetch")
    assert.equal(fs.readdirSync(target).length, 0, "nothing may be written through the link, outside the root")
    assert.deepEqual(fs.readdirSync(root), [githubCacheId(SPECS.bare)], "the refused entry must gain nothing inside the root either")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test("cache-path boundary: a symlinked cache ROOT and a file-shaped entry are refused", async () => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-github-root-target-"))
  const linkedRootParent = tmpRoot()
  const entryRoot = tmpRoot()
  try {
    const linkedRoot = path.join(linkedRootParent, "linked-root")
    fs.symlinkSync(realRoot, linkedRoot, "junction")
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: linkedRoot, fetchImpl: noNetwork(), trusted: true }),
      /cache root.*symlink/,
    )
    // The cache ENTRY itself is a regular file, not a directory.
    fs.writeFileSync(path.join(entryRoot, githubCacheId(SPECS.bare)), "not a directory")
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: entryRoot, fetchImpl: noNetwork(), trusted: true }),
      /entry.*is not a directory/,
    )
  } finally {
    fs.rmSync(realRoot, { recursive: true, force: true })
    fs.rmSync(linkedRootParent, { recursive: true, force: true })
    fs.rmSync(entryRoot, { recursive: true, force: true })
  }
})

/* ---- the consent gate ---- */

test("remoteTrustEnabled: an explicit option wins over the env; the env consents when the option is omitted", () => {
  assert.equal(remoteTrustEnabled(true, {}), true)
  assert.equal(remoteTrustEnabled(false, { OC_BIFROST_TRUST: "github" }), false, "an explicit false wins over the env")
  assert.equal(remoteTrustEnabled(undefined, { OC_BIFROST_TRUST: "github" }), true)
  assert.equal(remoteTrustEnabled(undefined, { OC_BIFROST_TRUST: " GITHUB " }), true)
  assert.equal(remoteTrustEnabled(undefined, {}), false)
  assert.equal(remoteTrustEnabled(undefined, { OC_BIFROST_TRUST: "everything" }), false)
})

test("consent: a cold cache without opt-in refuses BEFORE fetching anything", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } })
    await assert.rejects(() => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl }), (error) => {
      assert.match(error.message, /cold cache, first use/)
      assert.match(error.message, /github:obra\/superpowers/)
      assert.match(error.message, /hooks\/opencode\/superpowers\.ts/)
      assert.match(error.message, /full user rights/)
      assert.match(error.message, /options\.trustRemote: true/)
      assert.match(error.message, /OC_BIFROST_TRUST=github/)
      return true
    })
    assert.equal(impl.calls.length, 0, "the refusal must fetch NOTHING")
    assert.equal(fs.readdirSync(root).length, 0, "the refusal must write NOTHING")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("consent: the refusal message names what is about to be fetched and the exact opt-in", () => {
  const message = consentMessage(SPECS.bare)
  assert.match(message, /^\[oc-bifrost\] refusing to fetch/)
  assert.match(message, /from https:\/\/github\.com\/obra\/superpowers/)
  assert.match(message, /EXECUTE it with this host process's full user rights/)
  assert.match(message, /Nothing was fetched and nothing was executed/)
})

/* ---- cold fetch (consented) ---- */

test("resolveGithubPlugin: a cold cache WITH opt-in fetches, records resolvedCommit + sha256", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } })
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true, now: () => new Date(0) })

    assert.equal(result.fetched, true)
    const cacheDir = path.join(root, fs.readdirSync(root)[0])
    assert.equal(result.url, pathToFileURL(path.join(cacheDir, "plugin.ts")).href)
    assert.equal(fs.readFileSync(path.join(cacheDir, "plugin.ts"), "utf8"), SRC)

    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8"))
    assert.deepEqual(meta, expectedMeta({}))
    assert.match(meta.resolvedCommit, /^[0-9a-f]{40}$/)

    // fetch hardening plumbing: fixed origin, commit-anchored URL, abort
    // signal, redirects forbidden
    const rawCall = impl.calls.find((call) => call.url.startsWith("https://raw.githubusercontent.com/"))
    assert.match(
      rawCall.url,
      new RegExp(`^https://raw\\.githubusercontent\\.com/obra/superpowers/${COMMIT}/hooks/opencode/superpowers\\.ts$`),
      "the raw content must be fetched BY the resolved commit",
    )
    assert.equal(rawCall.init.redirect, "error", "redirects must be forbidden at the fetch layer")
    assert.ok(rawCall.init.signal instanceof AbortSignal, "fetch must receive a timeout signal")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a warm cache loads WITHOUT opt-in and with ZERO fetch calls", async () => {
  const root = tmpRoot()
  try {
    const first = await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } }),
      trusted: true,
    })
    const second = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: noNetwork(), trusted: false })
    assert.equal(second.fetched, false, "the second resolve must be a cache hit")
    assert.equal(second.url, first.url)
    assert.equal(second.meta.sha256, first.meta.sha256)
    assert.equal(second.meta.resolvedCommit, COMMIT, "the resolved commit survives to later loads")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: raw bytes are fetched BY the resolved commit (a moving ref cannot split meta from bytes)", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({
      // What the REF name would serve after it moved upstream:
      contents: { "hooks/opencode/superpowers.ts": "bytes the ref would serve after it moved\n" },
      // What the COMMIT the ref resolved to actually holds:
      contentsAtCommit: { "hooks/opencode/superpowers.ts": SRC },
    })
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true })
    const cacheDir = path.join(root, fs.readdirSync(root)[0])
    assert.equal(
      fs.readFileSync(path.join(cacheDir, "plugin.ts"), "utf8"),
      SRC,
      "the cached bytes must be the commit's snapshot, not whatever the ref name now serves",
    )
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8"))
    assert.equal(meta.sha256, sha256Hex(SRC), "the recorded digest must describe the bytes actually cached")
    assert.equal(meta.resolvedCommit, COMMIT)
    const rawCall = impl.calls.find((call) => call.url.startsWith("https://raw.githubusercontent.com/"))
    assert.match(rawCall.url, new RegExp(`/${COMMIT}/`), "the raw URL must name the commit")
    assert.doesNotMatch(rawCall.url, /\/main\//, "the raw URL must not name the ref")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: an explicit ref skips the default-branch lookup but still resolves the commit", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ contents: { "hooks/opencode/rtk.ts": SRC } })
    const result = await resolveGithubPlugin(SPECS.full, { cacheRoot: root, fetchImpl: impl, trusted: true })
    assert.equal(result.meta.ref, "v0.50.0")
    assert.equal(result.meta.resolvedCommit, COMMIT)
    assert.equal(result.meta.path, "hooks/opencode/rtk.ts")
    const apiCalls = impl.calls.filter((call) => call.url.startsWith("https://api.github.com/"))
    assert.equal(apiCalls.length, 1, "exactly one API call: the commit resolution")
    assert.match(apiCalls[0].url, /\/commits\/v0\.50\.0$/)
    assert.equal(
      impl.calls.some((call) => /\/repos\/[^/]+\/[^/]+$/.test(call.url)),
      false,
      "the default-branch lookup must be skipped for an explicit ref",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a missing ref defaults to the repo default branch (branch + commit resolved)", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ defaultBranch: "develop", contents: { "hooks/opencode/superpowers.ts": SRC } })
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true })
    assert.equal(result.meta.ref, "develop")
    assert.equal(result.meta.resolvedCommit, COMMIT)
    const apiCalls = impl.calls.filter((call) => call.url.startsWith("https://api.github.com/"))
    assert.equal(apiCalls.length, 2, "one repo-info call + one commit-resolution call")
    assert.ok(apiCalls.some((call) => /\/repos\/obra\/superpowers$/.test(call.url)))
    assert.ok(apiCalls.some((call) => /\/repos\/obra\/superpowers\/commits\/develop$/.test(call.url)))
    const rawCalls = impl.calls.filter((call) => call.url.startsWith("https://raw.githubusercontent.com/"))
    assert.match(rawCalls[0].url, new RegExp(`/obra/superpowers/${COMMIT}/`), "content is fetched by the resolved commit, not the branch name")
    assert.doesNotMatch(rawCalls[0].url, /\/develop\//)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- immutable identity / no silent replacement ---- */

test("resolveGithubPlugin: a sha256 mismatch refuses, fetches nothing, and does NOT overwrite the cache", async () => {
  const root = tmpRoot()
  try {
    await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } }),
      trusted: true,
    })
    const cacheDir = path.join(root, fs.readdirSync(root)[0])
    const pluginFile = path.join(cacheDir, "plugin.ts")
    const metaBefore = fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8")
    fs.writeFileSync(pluginFile, "tampered bytes\n", "utf8")

    const impl = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": "fresh bytes\n" } })
    await assert.rejects(() => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }), (error) => {
      assert.match(error.message, /sha256/)
      assert.match(error.message, /recorded [0-9a-f]{64}, computed [0-9a-f]{64}/)
      assert.match(error.message, /delete the cache directory/)
      return true
    })
    assert.equal(impl.calls.length, 0, "a mismatch must never re-fetch")
    assert.equal(fs.readFileSync(pluginFile, "utf8"), "tampered bytes\n", "the cache must not be overwritten")
    assert.equal(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8"), metaBefore)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a cache with provenance but no plugin file refuses (never silently re-fetched)", async () => {
  const root = tmpRoot()
  try {
    await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } }),
      trusted: true,
    })
    const cacheDir = path.join(root, fs.readdirSync(root)[0])
    fs.rmSync(path.join(cacheDir, "plugin.ts"))
    const impl = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /plugin file.*unreadable|is not a regular file/,
    )
    assert.equal(impl.calls.length, 0, "a broken cache must never be silently re-fetched")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a cache without its provenance record refuses loudly", async () => {
  const root = tmpRoot()
  try {
    await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } }),
      trusted: true,
    })
    const cacheDir = path.join(root, fs.readdirSync(root)[0])
    fs.rmSync(path.join(cacheDir, "meta.json"))
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: noNetwork(), trusted: false }),
      /provenance record/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a symlinked cache entry is refused", async () => {
  const root = tmpRoot()
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-github-target-"))
  try {
    fs.writeFileSync(path.join(target, "plugin.ts"), SRC)
    // "junction" works unprivileged on Windows and is a symlink on POSIX.
    fs.symlinkSync(target, path.join(root, githubCacheId(SPECS.bare)), "junction")
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: noNetwork(), trusted: false }),
      /symlink|outside the cache root/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})

/* ---- fail-closed offline + fetch hardening ---- */

test("resolveGithubPlugin: cold cache + failing network fails closed (never falls back)", async () => {
  const root = tmpRoot()
  try {
    const impl = async () => {
      throw new TypeError("fetch failed: getaddrinfo EAI_AGAIN")
    }
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      (error) => {
        assert.match(error.message, /never falls back to another source/)
        assert.match(error.message, /offline or air-gapped/)
        return true
      },
    )
    assert.equal(fs.readdirSync(root).length, 0, "nothing may be written on a failed fetch")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a response over the size cap is refused and never cached", async () => {
  const root = tmpRoot()
  try {
    const big = "x".repeat(1024 * 1024 + 1)
    const impl = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": big } })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /larger than the 1048576-byte cap/,
    )
    assert.equal(fs.readdirSync(root).length, 0, "an oversized response must never be cached")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: oversized bodies are refused INCREMENTALLY (reading stops at the cap, mid-body)", async () => {
  const root = tmpRoot()
  try {
    // 10 chunks of 200,000 bytes = 2,000,000 total; the 1,048,576 cap trips
    // exactly on the 6th chunk (5 chunks = 1,000,000 <= cap). The streaming
    // body yields chunk by chunk, so the test OBSERVES incremental
    // consumption: a buffering implementation never calls getReader at all,
    // leaving the counter at 0, and fails this test.
    const CHUNK = 200_000
    const TOTAL_CHUNKS = 10
    const consumed = { chunks: 0, cancelled: false }
    const base = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": "x".repeat(CHUNK * TOTAL_CHUNKS) } })
    const encoder = new TextEncoder()
    const impl = async (url, init) => {
      const response = await base(url, init)
      if (!url.includes("raw.githubusercontent.com")) return response
      const full = encoder.encode(await response.text())
      let index = 0
      return {
        ...response,
        body: {
          getReader() {
            return {
              read: async () => {
                if (index >= TOTAL_CHUNKS) return { done: true }
                const value = full.subarray(index * CHUNK, (index + 1) * CHUNK)
                index++
                consumed.chunks++
                return { done: false, value }
              },
              cancel: async () => {
                consumed.cancelled = true
              },
            }
          },
        },
      }
    }
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      (error) => {
        assert.match(error.message, /exceeded the 1048576-byte cap after \d+ bytes/)
        assert.match(error.message, /mid-body/)
        return true
      },
    )
    assert.equal(consumed.chunks, 6, "reading must stop exactly at the cap — the whole body was never consumed")
    assert.equal(consumed.cancelled, true, "the reader must be cancelled on refusal")
    assert.equal(fs.readdirSync(root).length, 0, "nothing may be cached")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: cache writes are restrictive where the OS honours modes, and no temp file is left behind", async () => {
  const root = tmpRoot()
  try {
    await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } }),
      trusted: true,
    })
    const cacheDir = path.join(root, fs.readdirSync(root)[0])
    assert.deepEqual(fs.readdirSync(cacheDir).sort(), ["meta.json", "plugin.ts"], "exactly the two artifacts — no temp leftover")
    if (process.platform !== "win32") {
      // Windows ignores POSIX mode bits; where they are honoured, least privilege.
      assert.equal(fs.statSync(path.join(cacheDir, "plugin.ts")).mode & 0o777, 0o600, "plugin file must be owner-only")
      assert.equal(fs.statSync(path.join(cacheDir, "meta.json")).mode & 0o777, 0o600, "provenance must be owner-only")
      assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700, "the cache entry must be owner-only")
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a failed cache write rolls back (no partial plugin file, no temp leftover)", async () => {
  const root = tmpRoot()
  try {
    const cacheDir = path.join(root, githubCacheId(SPECS.bare))
    fs.mkdirSync(cacheDir, { recursive: true })
    // Plant an obstruction: meta.json exists as a DIRECTORY, so the meta
    // write fails AFTER the plugin write succeeded. The rollback must remove
    // the partial plugin file and every temp file; nothing may be executed
    // from an incomplete cache.
    fs.mkdirSync(path.join(cacheDir, "meta.json"))
    const impl = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /could not write the github: cache/,
    )
    assert.equal(fs.existsSync(path.join(cacheDir, "plugin.ts")), false, "no partial plugin file may survive")
    assert.equal(fs.existsSync(path.join(cacheDir, "meta.json")), true, "the planted obstruction is not ours to delete")
    assert.deepEqual(
      fs.readdirSync(cacheDir).filter((name) => name !== "meta.json"),
      [],
      "no temp file may be left behind",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a redirect response is refused (redirects must not leave the origin)", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC }, rawStatus: 302 })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      (error) => {
        assert.match(error.message, /HTTP 302/)
        assert.match(error.message, /never falls back to another source/)
        return true
      },
    )
    const rawCall = impl.calls.find((call) => call.url.startsWith("https://raw.githubusercontent.com/"))
    assert.equal(rawCall.init.redirect, "error")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a response URL that left the allowed origin is refused", async () => {
  const root = tmpRoot()
  try {
    const base = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC } })
    const impl = async (url, init) => {
      const response = await base(url, init)
      if (url.includes("raw.githubusercontent.com")) return { ...response, url: "https://evil.example/payload.ts" }
      return response
    }
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /left the allowed origin.*evil\.example/,
    )
    assert.equal(fs.readdirSync(root).length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- refusal hygiene ---- */

test("control characters never reach a refusal message raw (spec and remote response)", async () => {
  const CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f]/
  let message = ""
  try {
    parseGithubSpec("github:o/r#hooks/\u0000opencode/x.ts")
  } catch (error) {
    message = error.message
  }
  assert.match(message, /invalid specifier/)
  assert.equal(CONTROL.test(message), false, "no raw control character may reach the message")
  assert.match(message, /\\u0000/, "the control character must appear escaped, for diagnosis")

  const root = tmpRoot()
  try {
    const impl = fakeFetch({ defaultBranch: "main\u0000evil", contents: { "hooks/opencode/superpowers.ts": SRC } })
    try {
      await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true })
    } catch (error) {
      message = error.message
    }
    assert.equal(CONTROL.test(message), false, "no raw control character may reach the message")
    assert.match(message, /\\u0000/, "remote junk must be escaped, not dumped")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: an unusable commit sha from the API refuses (identity must be a real commit)", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ contents: { "hooks/opencode/superpowers.ts": SRC }, commitSha: "not-a-sha" })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /no usable commit sha/,
    )
    assert.equal(fs.readdirSync(root).length, 0, "nothing may be cached without a resolved commit")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- candidate probing refusals ---- */

test("resolveGithubPlugin: no candidate path existing refuses with every path tried", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ contents: {} })
    await assert.rejects(() => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }), (error) => {
      assert.match(error.message, /no plugin file found for obra\/superpowers at ref main/)
      for (const candidate of ["hooks/opencode/superpowers.ts", "hooks/opencode/index.ts", "plugin.ts", "index.ts"]) {
        assert.match(error.message, new RegExp(`${candidate.replace(/\./g, "\\.")} \\(HTTP 404\\)`))
      }
      assert.match(error.message, /Pass an explicit path: github:obra\/superpowers#<path>/)
      return true
    })
    const rawCalls = impl.calls.filter((call) => call.url.startsWith("https://raw.githubusercontent.com/"))
    assert.equal(rawCalls.length, 4, "every candidate is probed once")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: an explicit path that misses refuses naming that path", async () => {
  const root = tmpRoot()
  try {
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.full, { cacheRoot: root, fetchImpl: fakeFetch({ contents: {} }), trusted: true }),
      /plugin file "hooks\/opencode\/rtk\.ts" not found in rtk-ai\/rtk at ref v0\.50\.0: hooks\/opencode\/rtk\.ts \(HTTP 404\)/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a failing default-branch lookup refuses loudly with the fix", async () => {
  const root = tmpRoot()
  try {
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: fakeFetch({ defaultBranch: null }), trusted: true }),
      /could not resolve the default branch of obra\/superpowers: HTTP 404; pass an explicit ref: github:obra\/superpowers@<ref>/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- the informed mount report ---- */

test("mountNote: always prints the resolved commit, the digest, and the host-rights line", () => {
  const meta = expectedMeta({})
  const fetched = mountNote(meta, true)
  assert.match(fetched, new RegExp(`commit ${COMMIT}`))
  assert.match(fetched, new RegExp(`sha256 ${meta.sha256.slice(0, 12)}`))
  assert.match(fetched, /executes with the host process's full user rights/)
  const warm = mountNote(meta, false)
  assert.match(warm, new RegExp(`commit ${COMMIT}`))
  assert.match(warm, /sha256 [0-9a-f]{12}… verified/)
  assert.match(warm, /executes with the host process's full user rights/)
})
