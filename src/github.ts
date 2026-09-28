/**
 * github: — mount a V1 plugin BY SOURCE, with a verified local cache and an
 * explicit consent gate on the first fetch.
 *
 * Specifier form: `github:<owner>/<repo>[@<ref>][#<path>]`
 *
 *   - `github:obra/superpowers`
 *   - `github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts`
 *
 * The contract:
 *
 *   - CONSENT BEFORE FIRST EXECUTION. A cold cache refuses to fetch+execute
 *     unless the user opted in for this oc-bifrost entry (`trustRemote: true`)
 *     or via the environment (`OC_BIFROST_TRUST=github`). The refusal names
 *     exactly what would be downloaded, that it will run with the host
 *     process's full user rights, and the exact opt-in. Trust-on-first-use is
 *     a HUMAN decision, not a silent default.
 *   - CACHE FIRST. A warm (already verified) cache loads with ZERO network
 *     and needs no consent: the opt-in is about the first fetch, not every
 *     mount. The cache directory is keyed by the normalized spec itself, so
 *     the load path never fetches while the cache hits.
 *   - IMMUTABLE IDENTITY. The ref is resolved to a commit sha at first fetch
 *     and recorded in meta.json (`resolvedCommit`), and the raw bytes are
 *     downloaded BY that commit — never by the ref — so a ref that moves
 *     cannot produce meta/bytes disagreement. A cached artifact is NEVER
 *     silently replaced because a ref moved: refresh is explicit — deleting
 *     the cache directory is the documented refresh.
 *   - CACHE-PATH INTEGRITY. One shared boundary (validateCachePath) runs
 *     before ANY fetch or write: root and entry must each be absent or real
 *     directories — never symlinks — and realpath-contained. Writes are
 *     temp+rename with restrictive modes (POSIX; Windows ignores the bits)
 *     and roll back on failure, leaving no partial file and no temp leftover.
 *   - VERIFICATION IS DRIFT DETECTION, NOT A DEFENSE AGAINST A LOCAL
 *     ADVERSARY. The digest lives beside the file it pins (meta.json in the
 *     same directory), so same-user malware can rewrite both. It catches
 *     corruption and accidental drift; it cannot protect against an attacker
 *     with the user's own rights.
 *   - FAIL CLOSED. Cold cache + no network refuses with the offline path; no
 *     fallback source exists. Refusals are sanitized: control characters from
 *     specs, URLs, or remote responses are escaped before they reach a
 *     message, and a remote body is never dumped.
 *
 * The cache lives under the session's location directory — the same directory
 * that hosts the config which named this plugin (`legacy/cache/<safe-id>/`).
 * The safe id is filesystem-safe and derived only from the normalized spec;
 * no host path ever flows into it.
 *
 * Zero runtime dependencies: plain `globalThis.fetch`, node builtins only.
 */
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/** A parsed `github:` specifier. `ref`/`path` are absent when the spec omits them. */
export interface GithubSpec {
  owner: string
  repo: string
  ref?: string
  path?: string
}

/** Provenance record. Field set is fixed: see the package security notes. */
export interface GithubMeta {
  source: string
  owner: string
  repo: string
  ref: string
  /** The commit sha the ref resolved to at first fetch (immutable identity). */
  resolvedCommit: string
  path: string
  sha256: string
  bytes: number
  fetchedAt: string
}

export interface GithubResolveOptions {
  /** Cache root: the plugin is cached at `<cacheRoot>/<safe-id>/plugin.ts`. */
  cacheRoot: string
  /**
   * Explicit informed consent to fetch + execute a plugin whose cache is cold
   * (`options.trustRemote: true`, or `OC_BIFROST_TRUST=github`). A cold cache
   * without it is refused BEFORE anything is fetched. A warm cache needs no
   * consent.
   */
  trusted?: boolean
  /** Injectable fetch for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Injectable clock for tests; defaults to `new Date`. */
  now?: () => Date
}

export interface GithubResolveResult {
  /** `file://` URL of the verified cached plugin module — the import target. */
  url: string
  cacheDir: string
  meta: GithubMeta
  /** True when this call downloaded the bytes; false on a verified cache hit. */
  fetched: boolean
}

/** Structural subset of a streaming response body, for the incremental size cap. */
export interface BodyReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(): Promise<void>
}

export interface BodyLike {
  getReader(): BodyReaderLike
}

/** Structural subset of a fetch Response that this module consumes. */
export interface FetchResponseLike {
  ok: boolean
  status: number
  /** Final URL after redirects, when the implementation exposes it. */
  url?: string
  /** Streaming body when the implementation exposes one; the size cap consumes it incrementally. */
  body?: BodyLike | null
  text(): Promise<string>
  json(): Promise<unknown>
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "error" },
) => Promise<FetchResponseLike>

const GITHUB_SPEC_PATTERN =
  /^github:([^/@#\s]+)\/([^/@#\s]+)(?:@([^#\s]+))?(?:#(\S+))?$/

const GITHUB_PLUGIN_FILENAME = "plugin.ts"
const META_FILENAME = "meta.json"
const RAW_ORIGIN = "https://raw.githubusercontent.com"
const API_ORIGIN = "https://api.github.com"
const USER_AGENT = "oc-bifrost-github"
const TIMEOUT_MS = 10_000
/** A plugin file larger than this is refused, never cached, never executed. */
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_OWNER = 39
const MAX_REPO = 100
const MAX_REF = 200
const MAX_PATH = 400

const OWNER_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/

/** Every refusal carries the package prefix, like the rest of src/. */
function fail(message: string): never {
  throw new Error(`[oc-bifrost] ${message}`)
}

/**
 * Neutralise control characters and cap the length of ANY untrusted string
 * before it reaches a message: a loud refusal must never be a terminal or
 * log hazard. Control characters are escaped (`\u0000`-style), never raw.
 */
export function safe(value: string, max = 200): string {
  const escaped = String(value).replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
  return escaped.length > max ? `${escaped.slice(0, max)}…(truncated)` : escaped
}

/** Canonical display form used in every message about this spec. */
export function githubLabel(spec: GithubSpec): string {
  let label = `github:${spec.owner}/${spec.repo}`
  if (spec.ref !== undefined) label += `@${spec.ref}`
  if (spec.path !== undefined) label += `#${spec.path}`
  return label
}

/**
 * Parity with `scripts/vendor-lib.mjs` `isValidRef`: a ref is safe to
 * interpolate into a URL. The charset excludes `%`, control characters, and
 * `..`; the only separator it may contain is the legitimate `/` (branch
 * names like `feature/next`), which is why the ref is NOT percent-encoded
 * when building raw URLs — encoding it would break branch refs, and the
 * strict charset is the control that makes raw use safe.
 */
export function isValidRef(ref: string): boolean {
  if (ref === "") return false
  if (ref.startsWith("-")) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false
  if (ref.includes("..")) return false
  return true
}

/** In-repo paths tried, in order, when the spec omits `#<path>`. */
export function candidatePaths(spec: GithubSpec): readonly string[] {
  if (spec.path !== undefined) return [spec.path]
  return [`hooks/opencode/${spec.repo}.ts`, "hooks/opencode/index.ts", "plugin.ts", "index.ts"]
}

/** sha256 hex of the utf8 bytes — the same digest the provenance record pins. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex")
}

/** Parse and validate a `github:` specifier. Throws loudly on any malformed form. */
export function parseGithubSpec(spec: string): GithubSpec {
  const match = GITHUB_SPEC_PATTERN.exec(spec)
  if (!match) {
    fail(`invalid specifier "${safe(spec)}": expected "github:<owner>/<repo>[@<ref>][#<path>]"`)
  }
  const owner = match[1] as string
  const repo = match[2] as string
  const ref = match[3]
  const rawPath = match[4]
  const parsed: GithubSpec = { owner: "", repo: "" }
  if (!OWNER_PATTERN.test(owner) || owner.length > MAX_OWNER) {
    fail(`invalid specifier "${safe(spec)}": the owner must be 1-${MAX_OWNER} GitHub-charset characters (letters, digits, single hyphens between them)`)
  }
  if (!REPO_PATTERN.test(repo) || repo === "." || repo === ".." || repo.length > MAX_REPO) {
    fail(`invalid specifier "${safe(spec)}": the repo must be 1-${MAX_REPO} GitHub-charset characters (letters, digits, ".", "_", "-") and must not be "." or ".."`)
  }
  parsed.owner = owner
  parsed.repo = repo
  if (ref !== undefined) {
    if (!isValidRef(ref) || ref.length > MAX_REF) {
      fail(
        `invalid specifier "${safe(spec)}": refs must match [A-Za-z0-9._/-] (max ${MAX_REF}), not start with "-", ` +
          `and contain no "..", "%", or control characters`,
      )
    }
    parsed.ref = ref
  }
  if (rawPath !== undefined) parsed.path = normalizeRepoPath(rawPath, spec)
  return parsed
}

/**
 * Path validation: reject traversal, absolute paths, backslashes, `%`
 * (encoded separators), control characters, and empty/`.`/`..` segments.
 * A leading `./` is tolerated and stripped; a leading `/` is absolute and
 * refused, never normalized.
 */
function normalizeRepoPath(raw: string, spec: string): string {
  if (raw.startsWith("/")) {
    fail(`invalid specifier "${safe(spec)}": the #<path> must be relative to the repository root, not "/${safe(raw)}"`)
  }
  const cleaned = raw.replace(/^\.?\//, "")
  if (cleaned === "") fail(`invalid specifier "${safe(spec)}": the #<path> must name a file in the repository`)
  if (cleaned.includes("\\")) fail(`invalid specifier "${safe(spec)}": paths use "/" separators, never backslashes`)
  if (cleaned.includes("%")) fail(`invalid specifier "${safe(spec)}": "%"/percent-encodings are not accepted in #<path> (nothing here may smuggle an encoded separator)`)
  for (const ch of cleaned) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      fail(`invalid specifier "${safe(spec)}": control characters are not accepted in #<path>`)
    }
  }
  for (const segment of cleaned.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      fail(`invalid specifier "${safe(spec)}": path segments must be non-empty and may not be "." or ".."`)
    }
  }
  if (cleaned.length > MAX_PATH) fail(`invalid specifier "${safe(spec)}": the #<path> exceeds ${MAX_PATH} characters`)
  return cleaned
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "")
  return (cleaned === "" ? "x" : cleaned).slice(0, 64)
}

/**
 * Deterministic, collision-resistant cache directory name for the
 * NORMALIZED spec. Derived ONLY from the spec (owner/repo and the spec's own
 * ref/path, with `default` standing in for omitted parts) so a cache hit
 * needs zero network. A sha256-derived suffix keys the RAW parts, so two
 * specs whose sanitized readable forms coincide can never share a directory.
 */
export function githubCacheId(spec: GithubSpec): string {
  const parts = [spec.owner, spec.repo, spec.ref ?? "default", spec.path ?? "default"]
  const readable = parts.map(sanitizeSegment).join("--").slice(0, 96)
  const digest = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16)
  return `${readable}-${digest}`
}

/**
 * Fail-closed guard: after resolving the cache path, assert it stays INSIDE
 * the cache root. Exported pure for tests.
 */
export function assertInsideRoot(cacheRoot: string, dir: string): void {
  const rel = path.relative(cacheRoot, dir)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail(`internal guard tripped: the cache path ${safe(dir)} does not stay inside the cache root ${safe(cacheRoot)}; refusing (fail closed)`)
  }
}

/**
 * THE cache-path validation boundary — the single gate every fetch and write
 * passes, before ANY network and before ANY write. The cache root and the
 * entry directory must each be ABSENT or a REAL directory: never a symlink
 * (cache writes must never follow one — a symlinked entry would land the
 * bytes outside the cache root), never another file type. When both exist,
 * the entry's realpath must land exactly one basename under the root's
 * realpath. Only the root and the entry are checked: ancestors above the
 * root are the host's own config tree and are routinely symlinked by the OS
 * (e.g. /var -> /private/var). Node has no portable O_NOFOLLOW for
 * mkdir/write, so the honest no-follow semantics are validate -> create ->
 * re-validate immediately before the write, which shrinks the race window.
 * Exported pure for tests.
 */
export function validateCachePath(cacheRoot: string, cacheDir: string): void {
  for (const [target, what] of [
    [cacheRoot, "root"],
    [cacheDir, "entry"],
  ] as const) {
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      fail(`refusing to use the cache ${what} at ${safe(target)}: ${safe((error as Error).message)}`)
    }
    if (stats.isSymbolicLink()) {
      fail(`refusing to use the cache ${what} at ${safe(target)}: it is a symlink, and cache writes must never follow one`)
    }
    if (!stats.isDirectory()) {
      fail(`refusing to use the cache ${what} at ${safe(target)}: it is not a directory`)
    }
  }
  let realRoot: string
  let realDir: string
  try {
    realRoot = fs.realpathSync(cacheRoot)
    realDir = fs.realpathSync(cacheDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return // root or entry absent: nothing to resolve yet
    fail(`refusing to use the cache: ${safe((error as Error).message)}`)
  }
  if (realDir !== path.join(realRoot, path.basename(cacheDir))) {
    fail(
      `refusing to use the cache entry at ${safe(cacheDir)}: its real location (${safe(realDir)}) ` +
        `escapes the cache root (${safe(realRoot)})`,
    )
  }
}

/** True when the path is an entry FILE (or a link — which the verify path then refuses), false when absent or a directory. */
function isEntryFile(target: string): boolean {
  try {
    const stats = fs.lstatSync(target)
    return stats.isFile() || stats.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Whether first-use remote fetching is consented. An explicit option wins:
 * `trustRemote: false` disables the fetch even when the environment asks for
 * it (mirrors freshnessEnabled). When the option is omitted,
 * `OC_BIFROST_TRUST === "github"` consents.
 */
export function remoteTrustEnabled(option: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (option !== undefined) return option
  return String(env?.OC_BIFROST_TRUST ?? "").trim().toLowerCase() === "github"
}

/**
 * The informed-consent refusal for a cold cache. Names exactly what is about
 * to be fetched, that it will execute with the host process's full user
 * rights, and the exact opt-in — before anything is fetched.
 */
export function consentMessage(spec: GithubSpec): string {
  const target =
    spec.path !== undefined
      ? `the file "${safe(spec.path)}"`
      : `one of, in order: ${candidatePaths(spec).join(", ")}`
  const refPart = spec.ref !== undefined ? `ref "${safe(spec.ref)}"` : `the repository's default branch (resolved at fetch time)`
  return (
    `[oc-bifrost] refusing to fetch "${safe(githubLabel(spec))}" (cold cache, first use): the first fetch would download ${target} ` +
    `from https://github.com/${spec.owner}/${spec.repo} at ${refPart} and EXECUTE it with this host process's full user rights. ` +
    `First-use fetching is opt-in, per oc-bifrost entry: set options.trustRemote: true, or set the environment variable OC_BIFROST_TRUST=github. ` +
    `Nothing was fetched and nothing was executed. A warm (hash-verified) cache never needs this consent.`
  )
}

/** Fail-closed wording for every network failure on the cold path. */
function offlineMessage(what: string, error: unknown): string {
  return (
    `[oc-bifrost] ${what} (${safe(error instanceof Error ? error.message : String(error))}). ` +
    `Cold-cache fetching is fail-closed — oc-bifrost never falls back to another source. ` +
    `If this machine is offline or air-gapped, pre-warm the cache on a networked machine (run oc-bifrost once with opt-in) ` +
    `and copy its legacy/cache directory across.`
  )
}

/**
 * The mount-report note. ALWAYS names the resolved commit, the digest, and
 * the fact that the plugin executes with the host process's full user
 * rights — so the consent (given once at first fetch) stays informed on
 * every later load.
 */
export function mountNote(meta: GithubMeta, fetched: boolean): string {
  const short = `${meta.sha256.slice(0, 12)}…`
  const head = fetched
    ? `fetched ${safe(meta.source)}:${safe(meta.owner)}/${safe(meta.repo)}@${safe(meta.ref)}#${safe(meta.path)} at commit ${safe(meta.resolvedCommit)} ` +
      `(sha256 ${short}, ${meta.bytes} bytes; trust-on-first-use)`
    : `loaded from cache (commit ${safe(meta.resolvedCommit)}, sha256 ${short} verified; fetched ${safe(meta.fetchedAt)})`
  return `${head}; executes with the host process's full user rights`
}

/** Component-aware URL builders on FIXED origins — no unchecked concatenation. */
function rawUrl(owner: string, repo: string, ref: string, filePath: string): string {
  // owner/repo pass a strict charset (encoding is a no-op but explicit); the
  // ref passes isValidRef and is deliberately unencoded (see isValidRef); the
  // path is encoded per SEGMENT so a segment can never introduce a separator.
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/")
  return `${RAW_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${ref}/${encodedPath}`
}

function apiRepoUrl(owner: string, repo: string): string {
  return `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

function apiCommitUrl(owner: string, repo: string, ref: string): string {
  return `${apiRepoUrl(owner, repo)}/commits/${encodeURIComponent(ref)}`
}

/** The response must not have left the fixed origin (defense against a proxy/mock redirect). */
function assertSameOrigin(requested: string, response: FetchResponseLike): void {
  if (response.url === undefined) return
  const originOf = (value: string): string | undefined => {
    try {
      return new URL(value).origin
    } catch {
      return undefined
    }
  }
  const from = originOf(requested)
  const to = originOf(response.url)
  if (from === undefined || to === undefined) {
    fail(`refusing to fetch: the response URL could not be parsed (${safe(response.url)}); redirects outside the fixed origins are never followed`)
  }
  if (to !== from) {
    fail(`refusing to fetch: the fetch left the allowed origin ${safe(from)} (landed on ${safe(to)}); redirects outside it are never followed`)
  }
}

function apiHeaders(): Record<string, string> {
  return { accept: "application/vnd.github+json", "user-agent": USER_AGENT }
}

/** Read + shape-check the provenance record. Any gap is a loud refusal. */
function readProvenance(cacheDir: string): GithubMeta {
  const missing =
    `the cached copy at ${safe(cacheDir)} has no readable provenance record (meta.json). ` +
    `Never loading unverified bytes; delete the cache directory to re-fetch`
  let raw: string
  try {
    raw = fs.readFileSync(path.join(cacheDir, META_FILENAME), "utf8")
  } catch (error) {
    fail(`${missing} (${safe((error as Error).message)})`)
  }
  let parsed: Partial<GithubMeta>
  try {
    parsed = JSON.parse(raw) as Partial<GithubMeta>
  } catch (error) {
    fail(`${missing} (invalid JSON: ${safe((error as Error).message)})`)
  }
  const complete =
    typeof parsed.source === "string" && parsed.source !== "" &&
    typeof parsed.owner === "string" && parsed.owner !== "" &&
    typeof parsed.repo === "string" && parsed.repo !== "" &&
    typeof parsed.ref === "string" && parsed.ref !== "" &&
    typeof parsed.resolvedCommit === "string" && COMMIT_PATTERN.test(parsed.resolvedCommit) &&
    typeof parsed.path === "string" && parsed.path !== "" &&
    typeof parsed.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(parsed.sha256) &&
    typeof parsed.bytes === "number" && Number.isFinite(parsed.bytes) &&
    typeof parsed.fetchedAt === "string"
  if (!complete) {
    fail(`${missing} (the record it holds is incomplete — this cache predates commit-pinning or is damaged; delete it to re-fetch)`)
  }
  return parsed as GithubMeta
}

/** Cache files must be real files, never links or odd node types. (The root/entry DIRECTORY checks live in validateCachePath.) */
function checkCacheFiles(pluginFile: string, metaFile: string): void {
  const files: ReadonlyArray<readonly [string, string]> = [
    [pluginFile, "plugin file"],
    [metaFile, "provenance record"],
  ]
  for (const [file, what] of files) {
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(file)
    } catch (error) {
      fail(`refusing to load: the cached ${what} at ${safe(file)} is unreadable (${safe((error as Error).message)}); delete the cache directory to re-fetch`)
    }
    if (stats.isSymbolicLink()) {
      fail(`refusing to load: the cached ${what} at ${safe(file)} is a symlink; delete the cache directory to re-fetch`)
    }
    if (!stats.isFile()) {
      fail(`refusing to load: the cached ${what} at ${safe(file)} is not a regular file; delete the cache directory to re-fetch`)
    }
  }
}

/** Cache-hit path: verify identity, type, and bytes, then hand over the URL. */
function loadVerified(spec: GithubSpec, cacheDir: string): GithubResolveResult {
  const pluginFile = path.join(cacheDir, GITHUB_PLUGIN_FILENAME)
  const metaFile = path.join(cacheDir, META_FILENAME)
  checkCacheFiles(pluginFile, metaFile)
  const meta = readProvenance(cacheDir)
  if (meta.owner !== spec.owner || meta.repo !== spec.repo) {
    fail(
      `refusing to load "${safe(githubLabel(spec))}": the cache at ${safe(cacheDir)} records ` +
        `${safe(meta.owner)}/${safe(meta.repo)}, not ${safe(spec.owner)}/${safe(spec.repo)}. ` +
        `Never loading unverified bytes; delete the cache directory to re-fetch`,
    )
  }
  let cached: string
  try {
    cached = fs.readFileSync(pluginFile, "utf8")
  } catch (error) {
    fail(
      `refusing to load "${safe(githubLabel(spec))}": the cache at ${safe(cacheDir)} holds a provenance record ` +
        `but its plugin file is unreadable (${safe((error as Error).message)}). ` +
        `Delete the cache directory to re-fetch — a broken cache is never silently re-fetched`,
    )
  }
  const actual = sha256Hex(cached)
  if (actual !== meta.sha256.toLowerCase()) {
    fail(
      `refusing to load "${safe(githubLabel(spec))}": the cached bytes at ${safe(pluginFile)} do not match the ` +
        `recorded sha256 (recorded ${safe(meta.sha256)}, computed ${actual}). The cache may be corrupt. ` +
        `Never loading unverified bytes and never re-fetching over a mismatch; ` +
        `inspect and delete the cache directory to re-fetch`,
    )
  }
  return { url: pathToFileURL(pluginFile).href, cacheDir, meta, fetched: false }
}

/** Resolve the repository's default branch. Any failure is loud and suggests the fix. */
async function resolveDefaultBranch(doFetch: FetchLike, spec: GithubSpec, signal: AbortSignal): Promise<string> {
  const hint = `pass an explicit ref: github:${spec.owner}/${spec.repo}@<ref>`
  const url = apiRepoUrl(spec.owner, spec.repo)
  let response: FetchResponseLike
  try {
    response = await doFetch(url, { headers: apiHeaders(), signal, redirect: "error" })
  } catch (error) {
    fail(offlineMessage(`could not resolve the default branch of ${safe(spec.owner)}/${safe(spec.repo)}`, error) + ` Alternatively, ${hint}.`)
  }
  assertSameOrigin(url, response)
  if (!response.ok) {
    fail(`could not resolve the default branch of ${safe(spec.owner)}/${safe(spec.repo)}: HTTP ${response.status}; ${hint}`)
  }
  let data: unknown
  try {
    data = await response.json()
  } catch (error) {
    fail(`could not resolve the default branch of ${safe(spec.owner)}/${safe(spec.repo)}: the response was not JSON (${safe((error as Error).message)}); ${hint}`)
  }
  const branch =
    data !== null && typeof data === "object" && typeof (data as Record<string, unknown>)["default_branch"] === "string"
      ? ((data as Record<string, unknown>)["default_branch"] as string).trim()
      : ""
  if (branch === "" || !isValidRef(branch) || branch.length > MAX_REF) {
    fail(
      `could not resolve the default branch of ${safe(spec.owner)}/${safe(spec.repo)}: the API returned no usable ` +
        `default_branch (${safe(branch, 80)}); ${hint}`,
    )
  }
  return branch
}

/** Resolve a ref to its commit sha — the immutable identity recorded in meta. */
async function resolveCommit(
  doFetch: FetchLike,
  spec: GithubSpec,
  ref: string,
  signal: AbortSignal,
): Promise<string> {
  const url = apiCommitUrl(spec.owner, spec.repo, ref)
  let response: FetchResponseLike
  try {
    response = await doFetch(url, { headers: apiHeaders(), signal, redirect: "error" })
  } catch (error) {
    fail(offlineMessage(`could not resolve ${safe(ref)} to a commit for ${safe(spec.owner)}/${safe(spec.repo)}`, error))
  }
  assertSameOrigin(url, response)
  if (!response.ok) {
    fail(`could not resolve ref "${safe(ref)}" to a commit for ${safe(spec.owner)}/${safe(spec.repo)}: HTTP ${response.status}`)
  }
  let data: unknown
  try {
    data = await response.json()
  } catch (error) {
    fail(`could not resolve ref "${safe(ref)}" to a commit: the response was not JSON (${safe((error as Error).message)})`)
  }
  const sha =
    data !== null && typeof data === "object" && typeof (data as Record<string, unknown>)["sha"] === "string"
      ? ((data as Record<string, unknown>)["sha"] as string).trim()
      : ""
  if (!COMMIT_PATTERN.test(sha)) {
    fail(`could not resolve ref "${safe(ref)}" to a commit: the API returned no usable commit sha (${safe(sha, 80)})`)
  }
  return sha.toLowerCase()
}

/** Atomic, least-permissive write: temp file + rename, never a partial artifact. */
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // best effort: the temp file may never have existed
    }
    throw error
  }
}

/**
 * Incremental size cap: consume the body chunk by chunk and REFUSE the
 * moment the running byte count exceeds the cap — reading stops mid-body
 * (the reader is cancelled) instead of buffering an unbounded payload. When
 * the implementation exposes no streaming body, fall back to text() and
 * enforce the cap before any use — the fallback is honest, but not
 * incremental.
 */
async function readBodyCapped(response: FetchResponseLike, what: string): Promise<string> {
  const body = response.body
  if (body === null || body === undefined || typeof body.getReader !== "function") {
    const text = await response.text()
    const bytes = Buffer.byteLength(text, "utf8")
    if (bytes > MAX_RESPONSE_BYTES) {
      fail(
        `refusing the response for ${what}: it is ${bytes} bytes, larger than the ${MAX_RESPONSE_BYTES}-byte cap. ` +
          `Nothing was cached and nothing was executed.`,
      )
    }
    return text
  }
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8")
  let total = 0
  let text = ""
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array }
    try {
      chunk = await reader.read()
    } catch (error) {
      fail(offlineMessage(`could not read the response body for ${what}`, error))
    }
    if (chunk.done) break
    const value = chunk.value
    if (value !== undefined) {
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // best effort — the refusal below is the real control
        }
        fail(
          `refusing the response for ${what}: it exceeded the ${MAX_RESPONSE_BYTES}-byte cap after ${total} bytes ` +
            `and reading was stopped mid-body. Nothing was cached and nothing was executed.`,
        )
      }
      text += decoder.decode(value, { stream: true })
    }
  }
  return text + decoder.decode()
}

/** First-fetch path (consented): resolve ref + commit, probe candidates, record, cache. */
async function fetchAndRecord(
  spec: GithubSpec,
  cacheDir: string,
  opts: GithubResolveOptions,
): Promise<GithubResolveResult> {
  const doFetch: FetchLike = opts.fetchImpl ?? globalThis.fetch
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)

  const ref = spec.ref ?? (await resolveDefaultBranch(doFetch, spec, signal))
  const resolvedCommit = await resolveCommit(doFetch, spec, ref, signal)

  const tried: string[] = []
  let content: string | undefined
  let contentPath: string | undefined
  for (const candidate of candidatePaths(spec)) {
    // The content is downloaded BY the resolved commit, never by the ref: a
    // ref that moves between the commit lookup and the download can never
    // produce meta/bytes disagreement — the recorded commit IS the URL's
    // identity, so the cached bytes and the recorded provenance are the same
    // snapshot by construction.
    const url = rawUrl(spec.owner, spec.repo, resolvedCommit, candidate)
    let response: FetchResponseLike
    try {
      response = await doFetch(url, {
        headers: { accept: "text/plain", "user-agent": USER_AGENT },
        signal,
        redirect: "error",
      })
    } catch (error) {
      fail(offlineMessage(`could not download ${safe(candidate)} from ${safe(spec.owner)}/${safe(spec.repo)} at commit ${safe(resolvedCommit)}`, error))
    }
    assertSameOrigin(url, response)
    if (response.status === 404) {
      tried.push(`${safe(candidate)} (HTTP 404)`)
      continue
    }
    if (!response.ok) {
      fail(
        `could not download ${safe(candidate)} from ${safe(spec.owner)}/${safe(spec.repo)} at commit ${safe(resolvedCommit)}: HTTP ${response.status}. ` +
          `Cold-cache fetching is fail-closed — oc-bifrost never falls back to another source.`,
      )
    }
    const text = await readBodyCapped(response, `${safe(candidate)} from ${safe(spec.owner)}/${safe(spec.repo)} at commit ${safe(resolvedCommit)}`)
    if (text.trim() === "") {
      tried.push(`${safe(candidate)} (empty response)`)
      continue
    }
    content = text
    contentPath = candidate
    break
  }
  if (content === undefined || contentPath === undefined) {
    if (spec.path !== undefined) {
      fail(
        `plugin file "${safe(spec.path)}" not found in ${safe(spec.owner)}/${safe(spec.repo)} at ref ${safe(ref)}` +
          `${tried.length > 0 ? `: ${tried[0] as string}` : ""}`,
      )
    }
    fail(
      `no plugin file found for ${safe(spec.owner)}/${safe(spec.repo)} at ref ${safe(ref)}. Tried, in order: ${tried.join("; ")}. ` +
        `Pass an explicit path: github:${safe(spec.owner)}/${safe(spec.repo)}#<path>`,
    )
  }

  // Prepare everything, then write atomically: a failed write leaves no
  // half-trust cache. Permissions are best-effort restricted (POSIX honors
  // them; Windows ignores the mode bits, which the docs state openly).
  const meta: GithubMeta = {
    source: "github",
    owner: spec.owner,
    repo: spec.repo,
    ref,
    resolvedCommit,
    path: contentPath,
    sha256: sha256Hex(content),
    bytes: Buffer.byteLength(content, "utf8"),
    fetchedAt: (opts.now ?? (() => new Date()))().toISOString(),
  }
  const pluginFile = path.join(cacheDir, GITHUB_PLUGIN_FILENAME)
  const metaFile = path.join(cacheDir, META_FILENAME)
  try {
    // The boundary was validated before the fetch; re-validate now that the
    // entry exists, immediately before any write — the no-follow shrink of
    // the race window (see validateCachePath).
    // The boundary was validated before the fetch; re-validate now that the
    // entry exists, immediately before any write — the no-follow shrink of
    // the race window (see validateCachePath).
    validateCachePath(opts.cacheRoot, cacheDir)
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    atomicWrite(pluginFile, content)
    atomicWrite(metaFile, `${JSON.stringify(meta, null, 2)}\n`)
    try {
      fs.chmodSync(pluginFile, 0o600)
      fs.chmodSync(metaFile, 0o600)
      fs.chmodSync(cacheDir, 0o700)
    } catch {
      // best effort — platforms without POSIX mode bits ignore this
    }
  } catch (error) {
    // Roll back OUR artifacts only: a failed first-fetch must leave NO
    // partial plugin file and NO temp leftover. The entry directory itself
    // and anything the user put there are left alone.
    for (const victim of [pluginFile, metaFile]) {
      try {
        fs.rmSync(victim, { force: true })
      } catch {
        // best effort
      }
    }
    try {
      for (const name of fs.readdirSync(cacheDir)) {
        if (name.startsWith(`${GITHUB_PLUGIN_FILENAME}.tmp-`) || name.startsWith(`${META_FILENAME}.tmp-`)) {
          fs.rmSync(path.join(cacheDir, name), { force: true })
        }
      }
    } catch {
      // best effort
    }
    fail(
      `could not write the github: cache at ${safe(cacheDir)}: ${safe((error as Error).message)}; ` +
        `partial state was removed — nothing will be executed from an incomplete cache`,
    )
  }
  return { url: pathToFileURL(pluginFile).href, cacheDir, meta, fetched: true }
}

/**
 * Resolve a `github:` spec to an importable `file://` URL.
 *
 * Order: the cache-path boundary (root and entry must be absent or real
 * directories, realpath-contained — before ANY fetch or write) → cache hit
 * (file types checked, provenance-checked, hash-verified, zero network) →
 * consent gate (cold + unconsented refuses BEFORE any fetch) → consented
 * first fetch (ref → commit → candidates-by-commit → atomic cache write with
 * rollback).
 */
export async function resolveGithubPlugin(
  spec: GithubSpec,
  opts: GithubResolveOptions,
): Promise<GithubResolveResult> {
  const cacheDir = path.join(opts.cacheRoot, githubCacheId(spec))
  assertInsideRoot(opts.cacheRoot, cacheDir)
  validateCachePath(opts.cacheRoot, cacheDir)
  const pluginFile = path.join(cacheDir, GITHUB_PLUGIN_FILENAME)
  const metaFile = path.join(cacheDir, META_FILENAME)
  // A directory-named plugin.ts/meta.json is NOT a cached entry: it routes to
  // the cold path, whose write then fails and rolls back (fail closed) —
  // while real files and links route to the verify path, which refuses links.
  if (isEntryFile(pluginFile) || isEntryFile(metaFile)) return loadVerified(spec, cacheDir)
  if (opts.trusted !== true) fail(consentMessage(spec))
  return fetchAndRecord(spec, cacheDir, opts)
}
