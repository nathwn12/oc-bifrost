import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { randomBytes } from "node:crypto"
import { pathToFileURL } from "node:url"
import { githubCacheRoot, resolveSpec } from "../dist/index.js"
import {
  assertInsideRoot,
  consentMessage,
  githubCacheId,
  githubCacheLayoutRoot,
  githubLabel,
  mountNote,
  parseGithubSpec,
  remoteTrustEnabled,
  resolveGithubPlugin,
  sha256Hex,
  validateCachePath,
} from "../dist/github.js"
import { entry, rawHeader, tar } from "./helpers/tar.js"

/**
 * github: specifiers — mount a V1 plugin BY SOURCE under the security
 * contract the review required, with the snapshot route in front:
 *
 *   - snapshot-first: the repository tarball at the RESOLVED commit is
 *     fetched in one request and materialized, so sibling files exist; the
 *     single-file route is the LOUD fallback (over-cap, links, malformed,
 *     missing candidates), never the default
 *   - hostile archives are refused outright — no fallback from a repository
 *     that serves a traversal attempt
 *   - consent: a cold cache refuses to fetch+execute without opt-in
 *   - cache first: a warm cache loads with ZERO fetch calls, no re-consent
 *   - immutable identity: the ref resolves to a commit, recorded in meta, and
 *     BOTH the tarball and the entry file carry digests; the entry digest is
 *     verified on every later load
 *   - strict validation: no traversal, absolute paths, backslashes, encoded
 *     separators, control chars, or empty segments; cache roots and entries
 *     are never symlinks and never leave their root
 *   - fail closed offline; sanitized messages; size-capped (incremental),
 *     origin-pinned fetches
 *
 * All offline: the network surface is an injected fetchImpl, never the real
 * network, and all state lives in tmp dirs.
 */

const SRC = 'export default { id: "demo", setup() {} }\n'
const COMMIT = "abcdef1234567890abcdef1234567890abcdef12"
const REPO = "superpowers"
const TOP = `${REPO}-${COMMIT}`

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-github-test-"))
}

/** Never-fetch sentinel: proves a path performs zero network. */
function noNetwork() {
  return async () => {
    throw new Error("the load path must never touch the network")
  }
}

/** Build a gzipped codeload-style tarball from a repo-relative path -> content map. */
function makeTarball(tree, top = TOP) {
  const entries = Object.entries(tree).map(([filePath, content]) => {
    const body = Buffer.from(content)
    return { header: rawHeader({ name: filePath, prefix: top, size: body.length }), body }
  })
  return gzipSync(tar(...entries))
}

/**
 * A fake fetch for the GitHub API (repo info + commit resolution), the
 * codeload snapshot surface, and the raw content surface.
 *
 * `tree` maps repo-relative paths to bytes and is what the TARBALL serves at
 * every commit. `raw` maps repo-relative paths for the SINGLE-FILE fallback;
 * an unlisted raw path is a 404. `rawStatus`/`tarballStatus` override the
 * status of those two surfaces (e.g. 302 to exercise redirect refusals).
 * `defaultBranch: null` fails the repo-info call; `commitSha: null` fails
 * commit resolution.
 */
function fakeFetch({
  defaultBranch = "main",
  commitSha = COMMIT,
  tree = {},
  raw = {},
  rawStatus = 200,
  tarballStatus = 200,
} = {}) {
  const calls = []
  // The top-level directory of a codeload tarball is `<repo>-<sha>` — it must
  // match the REQUESTED repo, so it is derived from the URL per request.
  const tarballs = new Map()
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
    if (url.startsWith("https://codeload.github.com/")) {
      if (tarballStatus !== 200) return { ok: false, status: tarballStatus, text: async () => "", json: async () => ({}) }
      const match = url.match(/^https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/)
      if (!match) return { ok: false, status: 404, text: async () => "", json: async () => ({}) }
      const key = `${match[1]}/${match[2]}@${match[3]}`
      if (!tarballs.has(key)) tarballs.set(key, makeTarball(tree, `${match[2]}-${match[3]}`))
      const tarball = tarballs.get(key)
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({}),
        arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
      }
    }
    const rawMatch = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
    if (rawMatch) {
      if (rawStatus !== 200) return { ok: false, status: rawStatus, text: async () => "", json: async () => ({}) }
      const content = raw[rawMatch[4]]
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

/** The default fixture tree happens to satisfy the bare spec's first candidate. */
const TREE = { "hooks/opencode/superpowers.ts": SRC }
const RAW = { "hooks/opencode/superpowers.ts": SRC }

/** Cache entry dir for a spec under a root: `<root>/v2/<id>`. */
function cacheDirFor(root, spec) {
  return path.join(githubCacheLayoutRoot(root), githubCacheId(spec))
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

test("githubCacheRoot: GitHub plugins share the user-level OpenCode cache, never the working project", () => {
  const home = path.join(os.tmpdir(), "oc-bifrost-home-test")
  assert.equal(
    githubCacheRoot(home, {}),
    path.join(home, ".cache", "opencode", "oc-bifrost", "github"),
  )
  assert.equal(
    githubCacheRoot(home, { XDG_CACHE_HOME: path.join(home, "xdg-cache") }),
    path.join(home, "xdg-cache", "opencode", "oc-bifrost", "github"),
  )
})

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
    fs.mkdirSync(githubCacheLayoutRoot(root), { recursive: true })
    fs.symlinkSync(target, cacheDirFor(root, SPECS.bare), "junction")
    const impl = fakeFetch({ tree: TREE })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /symlink, and cache writes must never follow one/,
    )
    assert.equal(impl.calls.length, 0, "the boundary must fire before ANY fetch")
    assert.equal(fs.readdirSync(target).length, 0, "nothing may be written through the link, outside the root")
    assert.deepEqual(fs.readdirSync(githubCacheLayoutRoot(root)), [githubCacheId(SPECS.bare)], "the refused entry must gain nothing inside the root either")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test("cache-path boundary: a symlinked cache ROOT and a file-shaped entry are refused", async () => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-github-root-target-"))
  const linkedRootParent = tmpRoot()
  const entryParent = tmpRoot()
  try {
    const linkedRoot = path.join(linkedRootParent, "linked-root")
    fs.symlinkSync(realRoot, linkedRoot, "junction")
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: linkedRoot, fetchImpl: noNetwork(), trusted: true }),
      /cache root.*symlink/,
    )
    const cacheDir = cacheDirFor(entryParent, SPECS.bare)
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true })
    fs.writeFileSync(cacheDir, "not a directory")
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: entryParent, fetchImpl: noNetwork(), trusted: true }),
      /entry.*is not a directory/,
    )
  } finally {
    fs.rmSync(realRoot, { recursive: true, force: true })
    fs.rmSync(linkedRootParent, { recursive: true, force: true })
    fs.rmSync(entryParent, { recursive: true, force: true })
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
    const impl = fakeFetch({ tree: TREE })
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
  assert.match(message, /EXECUTE its entry file with this host process's full user rights/)
  assert.match(message, /Nothing was fetched and nothing was executed/)
})

/* ---- cold fetch (consented): the snapshot route ---- */

test("resolveGithubPlugin: a cold cache WITH opt-in fetches the repository SNAPSHOT by commit and records provenance", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ tree: TREE })
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true, now: () => new Date(0) })

    assert.equal(result.fetched, true)
    const cacheDir = cacheDirFor(root, SPECS.bare)
    const entryFile = path.join(cacheDir, "tree", "hooks", "opencode", "superpowers.ts")
    assert.equal(result.url, pathToFileURL(entryFile).href)
    assert.equal(fs.readFileSync(entryFile, "utf8"), SRC)
    assert.equal(fs.existsSync(path.join(cacheDir, "tree", "hooks", "opencode", "superpowers.ts")), true, "the entry must sit at its repo-relative path inside the tree")

    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8"))
    assert.equal(meta.layout, "snapshot")
    assert.equal(meta.owner, "obra")
    assert.equal(meta.repo, "superpowers")
    assert.equal(meta.ref, "main")
    assert.equal(meta.path, "hooks/opencode/superpowers.ts")
    assert.equal(meta.sha256, sha256Hex(SRC))
    assert.equal(meta.bytes, Buffer.byteLength(SRC, "utf8"))
    assert.match(meta.resolvedCommit, /^[0-9a-f]{40}$/)
    assert.match(meta.tarballSha256, /^[0-9a-f]{64}$/, "the tarball digest must be recorded")
    assert.equal(typeof meta.tarballBytes, "number")
    assert.equal(meta.files, Object.keys(TREE).length)
    assert.equal(typeof meta.treeBytes, "number")
    assert.equal(meta.fetchedAt, new Date(0).toISOString())

    const tarballCall = impl.calls.find((call) => call.url.startsWith("https://codeload.github.com/"))
    assert.match(
      tarballCall.url,
      new RegExp(`^https://codeload\\.github\\.com/obra/superpowers/tar\\.gz/${COMMIT}$`),
      "the snapshot must be fetched BY the resolved commit",
    )
    assert.equal(tarballCall.init.redirect, "error", "redirects must be forbidden at the fetch layer")
    assert.ok(tarballCall.init.signal instanceof AbortSignal, "fetch must receive a timeout signal")
    assert.equal(
      impl.calls.some((call) => call.url.startsWith("https://raw.githubusercontent.com/")),
      false,
      "a successful snapshot must never hit the raw surface",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: SIBLING files materialize beside the entry (the point of the route)", async () => {
  const root = tmpRoot()
  try {
    const tree = {
      ".opencode/plugins/superpowers.js": 'export default { id: "superpowers", setup() {} }\n',
      "skills/using-superpowers/SKILL.md": "# Using superpowers\n",
      "skills/brainstorming/SKILL.md": "# Brainstorming\n",
      "README.md": "the repository README\n",
    }
    const impl = fakeFetch({ tree })
    const result = await resolveGithubPlugin(
      { owner: "obra", repo: "superpowers", ref: "v6.4.2", path: ".opencode/plugins/superpowers.js" },
      { cacheRoot: root, fetchImpl: impl, trusted: true },
    )
    const cacheDir = cacheDirFor(root, { owner: "obra", repo: "superpowers", ref: "v6.4.2", path: ".opencode/plugins/superpowers.js" })
    for (const sibling of Object.keys(tree)) {
      assert.equal(fs.existsSync(path.join(cacheDir, "tree", ...sibling.split("/"))), true, `sibling ${sibling} must materialize`)
    }
    assert.equal(result.url, pathToFileURL(path.join(cacheDir, "tree", ".opencode", "plugins", "superpowers.js")).href)
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8"))
    assert.equal(meta.layout, "snapshot")
    assert.equal(meta.files, Object.keys(tree).length)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: the snapshot probe finds the candidate entirely IN THE TREE (zero raw calls)", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ tree: TREE })
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true })
    assert.equal(result.meta.path, "hooks/opencode/superpowers.ts")
    assert.equal(impl.calls.filter((call) => call.url.startsWith("https://raw.githubusercontent.com/")).length, 0)
    assert.equal(impl.calls.filter((call) => call.url.startsWith("https://codeload.github.com/")).length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a tarball whose paths use the ustar PREFIX field materializes fully", async () => {
  const root = tmpRoot()
  try {
    // name <= 100 chars, prefix (incl. the <repo>-<sha>/ segment) <= 155 chars:
    // this fixture is built at the actual boundary of ustar's split fields.
    const REST = "segment/".repeat(12).slice(0, -1) // 95 chars
    const NAME = "superpowers.ts" // 14 chars
    const LONG = `${REST}/${NAME}`
    const split = LONG.lastIndexOf("/")
    assert.ok(LONG.length > 100, "the fixture must actually exceed the 100-byte name field")
    assert.ok(TOP.length + 1 + LONG.slice(0, split).length <= 155, "the prefix field itself must stay in bounds")
    const entries = [
      { header: rawHeader({ name: "hooks/opencode/superpowers.ts", prefix: TOP, size: Buffer.byteLength(SRC) }), body: Buffer.from(SRC) },
      { header: rawHeader({ name: NAME, prefix: `${TOP}/${LONG.slice(0, split)}`, size: Buffer.byteLength(SRC) }), body: Buffer.from(SRC) },
    ]
    const tarball = gzipSync(tar(...entries))
    const callImpl = async (url, init) => {
      if (url.startsWith("https://codeload.github.com/")) {
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({}),
          arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
        }
      }
      return fakeFetch({ tree: TREE, raw: RAW })(url, init)
    }
    const result = await resolveGithubPlugin(
      { owner: "obra", repo: "superpowers", path: LONG },
      { cacheRoot: root, fetchImpl: callImpl, trusted: true },
    )
    const cacheDir = cacheDirFor(root, { owner: "obra", repo: "superpowers", path: LONG })
    const materialized = path.join(cacheDir, "tree", ...LONG.split("/"))
    assert.equal(fs.existsSync(materialized), true, "the prefixed entry must materialize at its full path")
    assert.equal(result.meta.path, LONG)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: an explicit ref skips the default-branch lookup but still resolves the commit", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ tree: { "hooks/opencode/rtk.ts": SRC } })
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
    const impl = fakeFetch({ defaultBranch: "develop", tree: TREE })
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true })
    assert.equal(result.meta.ref, "develop")
    assert.equal(result.meta.resolvedCommit, COMMIT)
    const apiCalls = impl.calls.filter((call) => call.url.startsWith("https://api.github.com/"))
    assert.equal(apiCalls.length, 2, "one repo-info call + one commit-resolution call")
    assert.ok(apiCalls.some((call) => /\/repos\/obra\/superpowers$/.test(call.url)))
    assert.ok(apiCalls.some((call) => /\/repos\/obra\/superpowers\/commits\/develop$/.test(call.url)))
    const tarballCall = impl.calls.find((call) => call.url.startsWith("https://codeload.github.com/"))
    assert.match(tarballCall.url, new RegExp(`/obra/superpowers/tar\\.gz/${COMMIT}$`), "content is fetched by the resolved commit, never the branch name")
    assert.doesNotMatch(tarballCall.url, /\/develop\//)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- the loud single-file fallback ---- */

test("resolveGithubPlugin: a snapshot lacking every candidate falls back to single-file, named in meta", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ tree: {}, raw: RAW })
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true })
    assert.equal(result.meta.layout, "single-file")
    assert.match(result.meta.snapshotFallback, /none of the candidate plugin paths is present/)
    const cacheDir = cacheDirFor(root, SPECS.bare)
    assert.equal(fs.readFileSync(path.join(cacheDir, "plugin.ts"), "utf8"), SRC, "the fallback caches the raw file")
    const rawCalls = impl.calls.filter((call) => call.url.startsWith("https://raw.githubusercontent.com/"))
    assert.equal(rawCalls.length, 1, "the successful fallback probes exactly one path")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: an over-cap tarball falls back to single-file with the loss named in meta", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ tree: TREE, raw: RAW })
    const result = await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: impl,
      trusted: true,
      limits: { tarballBytes: 1 },
    })
    assert.equal(result.meta.layout, "single-file")
    assert.match(result.meta.snapshotFallback, /exceeded the 1-byte download cap/)
    assert.equal(fs.readFileSync(path.join(cacheDirFor(root, SPECS.bare), "plugin.ts"), "utf8"), SRC)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a link entry in the tarball falls back loudly (never materialized)", async () => {
  const root = tmpRoot()
  try {
    const body = Buffer.from("target")
    const link = { header: rawHeader({ name: "evil-link", prefix: TOP, type: "2", linkname: "../../outside" }), body }
    const tarball = gzipSync(tar({ header: rawHeader({ name: "hooks/opencode/superpowers.ts", prefix: TOP, size: Buffer.byteLength(SRC) }), body: Buffer.from(SRC) }, link))
    const impl = async (url, init) => {
      if (url.startsWith("https://codeload.github.com/")) {
        return { ok: true, status: 200, text: async () => "", json: async () => ({}), arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) }
      }
      return fakeFetch({ tree: TREE, raw: RAW })(url, init)
    }
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true })
    assert.equal(result.meta.layout, "single-file")
    assert.match(result.meta.snapshotFallback, /refused/)
    assert.equal(fs.existsSync(path.join(cacheDirFor(root, SPECS.bare), "tree")), false, "no partial tree may materialize")
    assert.equal(fs.existsSync(path.join(cacheDirFor(root, SPECS.bare), "tree")), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a HOSTILE archive (traversal) is refused outright — no fallback, nothing cached", async () => {
  const root = tmpRoot()
  try {
    const hostile = { header: rawHeader({ name: "../../escape.ts", prefix: TOP, size: Buffer.byteLength("pwned") }), body: Buffer.from("pwned") }
    const tarball = gzipSync(tar(hostile))
    const calls = []
    const impl = async (url, init) => {
      calls.push({ url, init })
      if (url.startsWith("https://codeload.github.com/")) {
        return { ok: true, status: 200, text: async () => "", json: async () => ({}), arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) }
      }
      return fakeFetch({ tree: TREE, raw: RAW })(url, init)
    }
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      (error) => {
        assert.match(error.message, /refusing the repository snapshot/)
        assert.match(error.message, /never used/)
        assert.match(error.message, /nothing was cached and nothing was executed/)
        return true
      },
    )
    assert.equal(
      calls.some((call) => call.url.startsWith("https://raw.githubusercontent.com/")),
      false,
      "a hostile archive must never degrade to the single-file route",
    )
    assert.equal(fs.readdirSync(root).length, 0, "nothing may be cached")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a pre-snapshot FLAT cache is never read as a snapshot and names the warning", async () => {
  const root = tmpRoot()
  try {
    const legacyDir = path.join(root, githubCacheId(SPECS.bare))
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, "plugin.ts"), SRC)
    fs.writeFileSync(path.join(legacyDir, "meta.json"), JSON.stringify({ layout: "single-file" }))
    const impl = fakeFetch({ tree: TREE })
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true })
    assert.ok(Array.isArray(result.warnings) && result.warnings.length === 1, "the legacy cache must be named out loud")
    assert.match(result.warnings[0], /pre-snapshot single-file cache/)
    assert.equal(fs.readFileSync(path.join(legacyDir, "plugin.ts"), "utf8"), SRC, "the legacy cache must remain untouched")
    assert.equal(result.meta.layout, "snapshot")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---- immutable identity / no silent replacement ---- */

test("resolveGithubPlugin: the tarball is fetched BY the resolved commit (a moving ref cannot split meta from bytes)", async () => {
  const root = tmpRoot()
  try {
    const impl = fakeFetch({ tree: TREE })
    const result = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true })
    const cacheDir = cacheDirFor(root, SPECS.bare)
    assert.equal(fs.readFileSync(path.join(cacheDir, "tree", "hooks", "opencode", "superpowers.ts"), "utf8"), SRC)
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8"))
    assert.equal(meta.sha256, sha256Hex(SRC), "the recorded digest must describe the bytes actually cached")
    assert.equal(meta.resolvedCommit, COMMIT)
    const tarballCall = impl.calls.find((call) => call.url.startsWith("https://codeload.github.com/"))
    assert.match(tarballCall.url, new RegExp(`/tar\\.gz/${COMMIT}$`), "the tarball URL must name the commit")
    assert.doesNotMatch(tarballCall.url, /\/main\//, "the tarball URL must not name the ref")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a warm cache loads WITHOUT opt-in and with ZERO fetch calls, entry digest verified", async () => {
  const root = tmpRoot()
  try {
    const first = await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ tree: TREE }),
      trusted: true,
    })
    const second = await resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: noNetwork(), trusted: false })
    assert.equal(second.fetched, false, "the second resolve must be a cache hit")
    assert.equal(second.url, first.url)
    assert.equal(second.meta.sha256, first.meta.sha256)
    assert.equal(second.meta.resolvedCommit, COMMIT, "the resolved commit survives to later loads")
    assert.equal(second.meta.layout, "snapshot")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a sha256 mismatch refuses, fetches nothing, and does NOT overwrite the cache", async () => {
  const root = tmpRoot()
  try {
    await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ tree: TREE }),
      trusted: true,
    })
    const cacheDir = cacheDirFor(root, SPECS.bare)
    const entryFile = path.join(cacheDir, "tree", "hooks", "opencode", "superpowers.ts")
    const metaBefore = fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8")
    fs.writeFileSync(entryFile, "tampered bytes\n", "utf8")

    const impl = fakeFetch({ tree: { "hooks/opencode/superpowers.ts": "fresh bytes\n" } })
    await assert.rejects(() => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }), (error) => {
      assert.match(error.message, /sha256/)
      assert.match(error.message, /recorded [0-9a-f]{64}, computed [0-9a-f]{64}/)
      assert.match(error.message, /delete the cache directory/)
      return true
    })
    assert.equal(impl.calls.length, 0, "a mismatch must never re-fetch")
    assert.equal(fs.readFileSync(entryFile, "utf8"), "tampered bytes\n", "the cache must not be overwritten")
    assert.equal(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8"), metaBefore)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a cache with provenance but no entry file refuses (never silently re-fetched)", async () => {
  const root = tmpRoot()
  try {
    await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ tree: TREE }),
      trusted: true,
    })
    const cacheDir = cacheDirFor(root, SPECS.bare)
    fs.rmSync(path.join(cacheDir, "tree", "hooks", "opencode", "superpowers.ts"))
    const impl = fakeFetch({ tree: TREE })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /entry file.*unreadable/,
    )
    assert.equal(impl.calls.length, 0, "a broken cache must never be silently re-fetched")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a snapshot cache without its provenance is never loaded as verified", async () => {
  const root = tmpRoot()
  try {
    await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ tree: TREE }),
      trusted: true,
    })
    const cacheDir = cacheDirFor(root, SPECS.bare)
    fs.rmSync(path.join(cacheDir, "meta.json"))
    // Without consent it is a cold cache and refuses before any fetch.
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: noNetwork(), trusted: false }),
      /cold cache, first use/,
    )
    // With consent, the orphaned tree is never overwritten — the write path refuses it.
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: fakeFetch({ tree: TREE }), trusted: true }),
      (error) => {
        assert.match(error.message, /could not write the github: cache/)
        assert.match(error.message, /refusing to write the snapshot cache/)
        assert.match(error.message, /"tree" directory is already present/)
        return true
      },
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a symlinked cache entry is refused", async () => {
  const root = tmpRoot()
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bifrost-github-target-"))
  try {
    fs.mkdirSync(path.join(target, "tree", "hooks", "opencode"), { recursive: true })
    fs.writeFileSync(path.join(target, "tree", "hooks", "opencode", "superpowers.ts"), SRC)
    // "junction" works unprivileged on Windows and is a symlink on POSIX.
    const cacheEntry = cacheDirFor(root, SPECS.bare)
    fs.mkdirSync(path.dirname(cacheEntry), { recursive: true })
    fs.symlinkSync(target, cacheEntry, "junction")
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

test("resolveGithubPlugin: an oversized SINGLE-FILE response is refused and never cached", async () => {
  const root = tmpRoot()
  try {
    // The snapshot is empty (falls back), and the raw body is over the 1 MiB cap.
    const big = "x".repeat(1024 * 1024 + 1)
    const impl = fakeFetch({ tree: {}, raw: { "hooks/opencode/superpowers.ts": big } })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /larger than the 1048576-byte cap/,
    )
    assert.equal(fs.readdirSync(root).length, 0, "an oversized response must never be cached")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: an oversized TARBALL is stopped mid-body, read incrementally, and degrades loudly", async () => {
  const root = tmpRoot()
  try {
    // 12 chunks of 400 bytes = 4,800 total; a 2048 cap trips on the 6th chunk.
    // The content is incompressible so the gzipped tarball is large enough.
    const CHUNK = 400
    const TOTAL_CHUNKS = 12
    // Incompressible content — a gzip of repeated text would be tiny and the
    // 2048 cap would never trip.
    const bigTree = { "hooks/opencode/superpowers.ts": randomBytes(4800).toString("latin1") }
    const consumed = { chunks: 0, cancelled: false }
    const base = fakeFetch({ tree: bigTree, raw: RAW })
    const compressed = makeTarball(bigTree)
    const calls = []
    const impl = async (url, init) => {
      calls.push({ url, init })
      const response = await base(url, init)
      if (!url.includes("codeload.github.com")) return response
      const full = new Uint8Array(compressed)
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
    const result = await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: impl,
      trusted: true,
      limits: { tarballBytes: 2048 },
    })
    assert.equal(result.meta.layout, "single-file", "the over-cap tarball must degrade loudly")
    assert.match(result.meta.snapshotFallback, /exceeded the 2048-byte download cap/)
    assert.ok(consumed.chunks <= 6, "reading must stop at the cap — the whole body was never consumed")
    assert.equal(consumed.cancelled, true, "the reader must be cancelled on refusal")
    assert.equal(fs.readFileSync(path.join(cacheDirFor(root, SPECS.bare), "plugin.ts"), "utf8"), SRC)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: cache writes are restrictive where the OS honours modes, and no temp file is left behind", async () => {
  const root = tmpRoot()
  try {
    await resolveGithubPlugin(SPECS.bare, {
      cacheRoot: root,
      fetchImpl: fakeFetch({ tree: TREE }),
      trusted: true,
    })
    const cacheDir = cacheDirFor(root, SPECS.bare)
    assert.deepEqual(fs.readdirSync(cacheDir).sort(), ["meta.json", "tree"], "exactly the two artifacts — no temp leftover")
    if (process.platform !== "win32") {
      // Windows ignores POSIX mode bits; where they are honoured, least privilege.
      assert.equal(fs.statSync(path.join(cacheDir, "meta.json")).mode & 0o777, 0o600, "provenance must be owner-only")
      assert.equal(fs.statSync(path.join(cacheDir, "tree")).mode & 0o777, 0o700, "the tree must be owner-only")
      assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700, "the cache entry must be owner-only")
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a failed cache write rolls back (no partial tree, no temp leftover)", async () => {
  const root = tmpRoot()
  try {
    const cacheDir = cacheDirFor(root, SPECS.bare)
    // Plant an obstruction: the tree exists as a plain directory with NO
    // provenance record. The snapshot materializer must refuse it, and the
    // rollback must leave no partial artifacts and no temp files behind.
    fs.mkdirSync(path.join(cacheDir, "tree"), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, "tree", "planted.txt"), "not a snapshot")
    const impl = fakeFetch({ tree: TREE })
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /could not write the github: cache/,
    )
    const leftovers = fs.readdirSync(cacheDir)
    assert.deepEqual(leftovers, [], "no partial tree, no temp file may survive the rollback")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveGithubPlugin: a redirect response is refused (redirects must not leave the origin)", async () => {
  const root = tmpRoot()
  try {
    // The snapshot is empty (so the raw surface is reached), and the raw body
    // is a 302: the refusal must name the redirect and stay fail-closed.
    const impl = fakeFetch({ tree: {}, raw: {}, rawStatus: 302 })
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

test("resolveGithubPlugin: a TARBALL response that left the allowed origin is refused hard (no fallback)", async () => {
  const root = tmpRoot()
  try {
    const base = fakeFetch({ tree: TREE, raw: RAW })
    const calls = []
    const impl = async (url, init) => {
      calls.push({ url, init })
      const response = await base(url, init)
      if (url.includes("codeload.github.com")) return { ...response, url: "https://evil.example/tarball.gz" }
      return response
    }
    await assert.rejects(
      () => resolveGithubPlugin(SPECS.bare, { cacheRoot: root, fetchImpl: impl, trusted: true }),
      /left the allowed origin.*evil\.example/,
    )
    assert.equal(
      calls.some((call) => call.url.startsWith("https://raw.githubusercontent.com/")),
      false,
      "an origin-leaving tarball must not degrade to single-file",
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
    const impl = fakeFetch({ defaultBranch: "main\u0000evil", tree: TREE })
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
    const impl = fakeFetch({ tree: TREE, commitSha: "not-a-sha" })
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
    const impl = fakeFetch({ tree: {}, raw: {} })
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
      () => resolveGithubPlugin(SPECS.full, { cacheRoot: root, fetchImpl: fakeFetch({ tree: {}, raw: {} }), trusted: true }),
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

test("mountNote: a snapshot always prints the layout, the commit, the digest, and the host-rights line", () => {
  const snapshot = {
    source: "github",
    owner: "obra",
    repo: "superpowers",
    ref: "main",
    resolvedCommit: COMMIT,
    path: "hooks/opencode/superpowers.ts",
    sha256: sha256Hex(SRC),
    bytes: Buffer.byteLength(SRC, "utf8"),
    fetchedAt: new Date(0).toISOString(),
    layout: "snapshot",
    tarballSha256: "d".repeat(64),
    tarballBytes: 1234,
    files: 7,
    treeBytes: 9999,
  }
  const fetched = mountNote(snapshot, true)
  assert.match(fetched, new RegExp(`commit ${COMMIT}`))
  assert.match(fetched, /as a repository snapshot \(7 files, 9999 bytes materialized/)
  assert.match(fetched, new RegExp(`sha256 ${sha256Hex(SRC).slice(0, 12)}`))
  assert.match(fetched, /tarball sha256 d{12}…/)
  assert.match(fetched, /executes with the host process's full user rights/)
  const warm = mountNote(snapshot, false)
  assert.match(warm, new RegExp(`commit ${COMMIT}`))
  assert.match(warm, /repository snapshot 7 files/)
  assert.match(warm, /verified/)
})

test("mountNote: a single-file fallback says the loss out loud on every load", () => {
  const single = {
    source: "github",
    owner: "obra",
    repo: "superpowers",
    ref: "main",
    resolvedCommit: COMMIT,
    path: "hooks/opencode/superpowers.ts",
    sha256: sha256Hex(SRC),
    bytes: Buffer.byteLength(SRC, "utf8"),
    fetchedAt: new Date(0).toISOString(),
    layout: "single-file",
    snapshotFallback: "the tarball of obra/superpowers at commit … exceeded the 16 MiB download cap",
  }
  const fetched = mountNote(single, true)
  assert.match(fetched, /as a SINGLE FILE — the repository snapshot was not used/)
  assert.match(fetched, /sibling files are NOT available, and a plugin that reads them by relative path is inert/)
  assert.match(fetched, new RegExp(`exceeded the 16 MiB download cap`))
  const warm = mountNote(single, false)
  assert.match(warm, /SINGLE FILE — sibling files are NOT available and a plugin that reads them by relative path is inert/)
})