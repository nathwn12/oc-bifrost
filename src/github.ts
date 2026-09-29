/**
 * github: — mount a plugin BY SOURCE, with a verified local cache and an
 * explicit consent gate on the first fetch.
 *
 * Specifier form: `github:<owner>/<repo>[@<ref>][#<path>]`
 *
 *   - `github:obra/superpowers`
 *   - `github:rtk-ai/rtk@v0.50.0#hooks/opencode/rtk.ts`
 *
 * The contract:
 *
 *   - WHOLE-REPO BY DEFAULT. The ref resolves to a commit sha (as before), then
 *     the repository SNAPSHOT at that commit is fetched as one gzip tarball
 *     from codeload (`https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>`)
 *     and materialized in the cache with repo-relative paths preserved. The
 *     entry file is imported from its real place inside that tree, so a plugin
 *     that reads a sibling by relative path (a bundled skills directory, a
 *     fixture, a template) actually finds it. No tree walk: one request.
 *   - SINGLE-FILE FALLBACK, NEVER SILENT. If the snapshot is over a named cap,
 *     is malformed, or carries non-regular entries (links/device nodes), the
 *     old one-file fetch still mounts — but the mount note says, loudly, that
 *     sibling files are NOT available and a plugin that reads them is inert.
 *     A silent downgrade would be a defect. An archive that attempts a path
 *     escape (absolute, `..`, outside its top-level directory) is refused
 *     outright: hostile input is never executed.
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
 *     and recorded in meta.json (`resolvedCommit`), and every byte is
 *     downloaded BY that commit — never by the ref — so a ref that moves
 *     cannot produce meta/bytes disagreement. The compressed tarball digest
 *     AND the entry file digest are both recorded. A cached artifact is NEVER
 *     silently replaced because a ref moved: refresh is explicit — deleting
 *     the cache directory is the documented refresh.
 *   - CACHE-PATH INTEGRITY. One shared boundary (validateCachePath) runs
 *     before ANY fetch or write: root and entry must each be absent or real
 *     directories — never symlinks — and realpath-contained. Snapshot writes
 *     land in a staging directory and are renamed into place, so a failed
 *     materialization leaves no partial tree. On load, every directory between
 *     the cache entry and the entry file is re-checked as a real directory,
 *     never a symlink.
 *   - VERIFICATION IS DRIFT DETECTION, NOT A DEFENSE AGAINST A LOCAL
 *     ADVERSARY. The digest lives beside the file it pins (meta.json in the
 *     same directory), so same-user malware can rewrite both. It catches
 *     corruption and accidental drift; it cannot protect against an attacker
 *     with the user's own rights.
 *   - FAIL CLOSED. Cold cache + no network refuses with the offline path; the
 *     only fallback source is the same repository's raw single-file endpoint,
 *     announced loudly in the mount note. Refusals are sanitized: control
 *     characters from specs, URLs, archive entry names, or remote responses
 *     are escaped before they reach a message, and a remote body is never
 *     dumped.
 *
 * The cache lives in the OpenCode user's shared cache directory
 * (`<XDG_CACHE_HOME>/opencode/oc-bifrost/github/v2/<safe-id>/`, defaulting to
 * `~/.cache/opencode/oc-bifrost/github/v2/<safe-id>/`). The `v2` layout level
 * means a flat single-file cache written by an earlier oc-bifrost can never be
 * mistaken for a snapshot: it is ignored (with a loud note) and re-fetched.
 * The safe id is filesystem-safe and derived only from the normalized spec;
 * no host path ever flows into it.
 *
 * Zero runtime dependencies: plain `globalThis.fetch`, node builtins only.
 */
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ArchiveError, readTarGz, type ArchiveFile, type ArchiveContents } from "./archive.js"

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
  /** The entry file's repo-relative path (snapshot) or the probed path (single-file). */
  path: string
  /** sha256 of the entry FILE's bytes — verified on every later load. */
  sha256: string
  bytes: number
  fetchedAt: string
  /**
   * How the entry was materialized:
   *   - "snapshot"    — the whole repository tree at the resolved commit; the
   *                     entry is imported from its real place inside it, so
   *                     sibling files exist.
   *   - "single-file" — one file only; siblings are NOT available and a plugin
   *                     that reads them by relative path is inert.
   */
  layout: "snapshot" | "single-file"
  /** sha256 of the compressed tarball (snapshot layout only). */
  tarballSha256?: string
  /** Compressed tarball size in bytes (snapshot layout only). */
  tarballBytes?: number
  /** Regular files materialized (snapshot layout only). */
  files?: number
  /** Total regular-file bytes materialized (snapshot layout only). */
  treeBytes?: number
  /** Why the snapshot was not used, sanitized (single-file layout only). */
  snapshotFallback?: string
}

/**
 * Hard caps on the snapshot. Named, documented, and enforced before anything
 * is cached. A breach never truncates: it downgrades to the single-file route
 * with a loud mount note, or refuses when the offending input is hostile.
 */
export interface GithubSnapshotLimits {
  /** Compressed tarball download cap (stop reading mid-body past it). */
  tarballBytes: number
  /** Uncompressed archive cap (headers + padding included). */
  treeBytes: number
  /** Regular-file count cap. */
  files: number
}

export interface GithubResolveOptions {
  /** Cache root: the plugin is cached at `<cacheRoot>/v2/<safe-id>/`. */
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
  /** Snapshot cap overrides (tests; unusually large repositories). */
  limits?: Partial<GithubSnapshotLimits>
}

export interface GithubResolveResult {
  /** `file://` URL of the verified cached entry module — the import target. */
  url: string
  cacheDir: string
  meta: GithubMeta
  /** True when this call downloaded the bytes; false on a verified cache hit. */
  fetched: boolean
  /** Load-time warnings that belong in the mount note (never silent). */
  warnings?: string[]
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
  /** Streaming body when the implementation exposes one; the size caps consume it incrementally. */
  body?: BodyLike | null
  /** Binary body fallback for the tarball when no streaming body is exposed. */
  arrayBuffer?(): Promise<ArrayBuffer>
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
/** The materialized repository tree lives in this directory inside a snapshot cache entry. */
const TREE_DIRNAME = "tree"
/** Cache layout version directory. Ids stay stable per spec inside it; a flat single-file cache from earlier versions lives at `<root>/<id>` and is never mistaken for a snapshot. */
const GITHUB_CACHE_LAYOUT = "v2"
const RAW_ORIGIN = "https://raw.githubusercontent.com"
const API_ORIGIN = "https://api.github.com"
const CODELOAD_ORIGIN = "https://codeload.github.com"
const USER_AGENT = "oc-bifrost-github"
const TIMEOUT_MS = 10_000
/** A plugin file larger than this is refused, never cached, never executed. */
const MAX_RESPONSE_BYTES = 1024 * 1024
/**
 * Caps on the repository snapshot. Sized for plugin-bearing repositories
 * (the real `obra/superpowers@v6.4.2` snapshot is 641 KB compressed / 2.1 MB
 * uncompressed / 229 files) while still bounding untrusted input. A breach
 * refuses the SNAPSHOT and falls back to the single-file route, loudly — it
 * never truncates, and never happens silently.
 */
export const MAX_TARBALL_BYTES = 16 * 1024 * 1024
export const MAX_TREE_BYTES = 64 * 1024 * 1024
export const MAX_TREE_FILES = 5000
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

/** sha256 hex of raw bytes — the digest form used for entry files and tarballs. */
function sha256BytesHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
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
 * The layout-versioned cache root. Directory versioning is what keeps a flat
 * single-file cache written by an earlier oc-bifrost (`<root>/<id>`) from ever
 * being read as if it were a materialized snapshot: the new code only looks
 * under `<root>/v2/`, so the old entry is cold, re-fetched (with the same
 * one-time consent), and reported in the mount note.
 */
export function githubCacheLayoutRoot(cacheRoot: string): string {
  return path.join(cacheRoot, GITHUB_CACHE_LAYOUT)
}

/**
 * The full cache boundary, all levels: the base root, the layout-versioned
 * root, and the per-spec entry. Each level is checked with the same rule —
 * absent or a REAL directory, never a symlink, realpath-contained — so a
 * symlinked base root is caught even when the layout directory does not exist
 * yet.
 */
function validateCacheLevels(cacheRoot: string, layoutRoot: string, cacheDir: string): void {
  assertInsideRoot(cacheRoot, layoutRoot)
  assertInsideRoot(layoutRoot, cacheDir)
  validateCachePath(cacheRoot, layoutRoot)
  validateCachePath(layoutRoot, cacheDir)
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
      ? `the repository snapshot at the resolved commit (up to ${MAX_TARBALL_BYTES} compressed bytes), including the entry file "${safe(spec.path)}"`
      : `the repository snapshot at the resolved commit (up to ${MAX_TARBALL_BYTES} compressed bytes), including one of, in order: ${candidatePaths(spec).join(", ")}`
  const refPart = spec.ref !== undefined ? `ref "${safe(spec.ref)}"` : `the repository's default branch (resolved at fetch time)`
  return (
    `[oc-bifrost] refusing to fetch "${safe(githubLabel(spec))}" (cold cache, first use): the first fetch would download ${target} ` +
    `from https://github.com/${spec.owner}/${spec.repo} at ${refPart} and EXECUTE its entry file with this host process's full user rights. ` +
    `First-use fetching is opt-in, per oc-bifrost entry: set options.trustRemote: true, or set the environment variable OC_BIFROST_TRUST=github. ` +
    `Nothing was fetched and nothing was executed. A warm (hash-verified) cache never needs this consent.`
  )
}

/** Fail-closed wording for every network failure on the cold path. */
function offlineMessage(what: string, error: unknown): string {
  return (
    `[oc-bifrost] ${what} (${safe(error instanceof Error ? error.message : String(error))}). ` +
    `Cold-cache fetching is fail-closed — oc-bifrost never falls back to another source. ` +
    `If this machine is offline or air-gapped, pre-warm the shared cache on a networked machine (run oc-bifrost once with opt-in) ` +
    `and copy its oc-bifrost/github cache directory across.`
  )
}

/**
 * The mount-report note. ALWAYS names the resolved commit, the digest, and
 * the fact that the plugin executes with the host process's full user
 * rights — so the consent (given once at first fetch) stays informed on
 * every later load. When the single-file fallback was used (or a warm cache
 * holds one), it says so loudly: sibling files are NOT available and a plugin
 * that reads them by relative path is inert.
 */
export function mountNote(meta: GithubMeta, fetched: boolean): string {
  const short = `${meta.sha256.slice(0, 12)}…`
  const where = `${safe(meta.source)}:${safe(meta.owner)}/${safe(meta.repo)}@${safe(meta.ref)}#${safe(meta.path)}`
  const snapshot = meta.layout === "snapshot"
  const snapshotDetail = snapshot
    ? ` as a repository snapshot (${meta.files ?? 0} files, ${meta.treeBytes ?? 0} bytes materialized; tarball sha256 ${String(meta.tarballSha256 ?? "").slice(0, 12)}…)`
    : ` as a SINGLE FILE — the repository snapshot was not used${meta.snapshotFallback !== undefined ? ` (${safe(meta.snapshotFallback)})` : ""}; sibling files are NOT available, and a plugin that reads them by relative path is inert`
  const head = fetched
    ? `fetched ${where} at commit ${safe(meta.resolvedCommit)}${snapshotDetail} (entry sha256 ${short}, ${meta.bytes} bytes; trust-on-first-use)`
    : snapshot
      ? `loaded from cache (commit ${safe(meta.resolvedCommit)}, repository snapshot ${meta.files ?? 0} files; entry sha256 ${short} verified; fetched ${safe(meta.fetchedAt)})`
      : `loaded from cache (commit ${safe(meta.resolvedCommit)}, SINGLE FILE — sibling files are NOT available and a plugin that reads them by relative path is inert; sha256 ${short} verified; fetched ${safe(meta.fetchedAt)})`
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
    typeof parsed.fetchedAt === "string" &&
    (parsed.layout === "snapshot" || parsed.layout === "single-file")
  const snapshotComplete =
    parsed.layout !== "snapshot" ||
    (typeof parsed.tarballSha256 === "string" && /^[0-9a-fA-F]{64}$/.test(parsed.tarballSha256) &&
      typeof parsed.tarballBytes === "number" && Number.isFinite(parsed.tarballBytes) &&
      typeof parsed.files === "number" && Number.isFinite(parsed.files) &&
      typeof parsed.treeBytes === "number" && Number.isFinite(parsed.treeBytes))
  if (!complete || !snapshotComplete) {
    fail(
      `${missing} (the record it holds is incomplete — it predates the snapshot layout or is damaged; ` +
        `delete the cache directory to re-fetch)`,
    )
  }
  return parsed as GithubMeta
}

/** Cache files must be real files, never links or odd node types. (The root/entry DIRECTORY checks live in validateCachePath.) */
function checkCacheFile(file: string, what: string): void {
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

/** A stored relative path must never be trusted straight into `path.join`. */
function assertSafeRelativePath(relative: string): void {
  if (relative === "" || relative.startsWith("/") || relative.includes("\\") || relative.includes("\0")) {
    fail(`refusing to load: the recorded entry path (${safe(relative)}) is not a plain relative path; delete the cache directory to re-fetch`)
  }
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes(":")) {
      fail(`refusing to load: the recorded entry path (${safe(relative)}) contains an unsafe segment; delete the cache directory to re-fetch`)
    }
  }
}

/** A real directory, never a symlink — the walk between the cache entry and the entry file. */
function checkRealDirectory(directory: string, what: string): void {
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(directory)
  } catch (error) {
    fail(`refusing to load: the cached ${what} at ${safe(directory)} is unreadable (${safe((error as Error).message)}); delete the cache directory to re-fetch`)
  }
  if (stats.isSymbolicLink()) {
    fail(`refusing to load: the cached ${what} at ${safe(directory)} is a symlink; delete the cache directory to re-fetch`)
  }
  if (!stats.isDirectory()) {
    fail(`refusing to load: the cached ${what} at ${safe(directory)} is not a directory; delete the cache directory to re-fetch`)
  }
}

/** Resolve the entry file inside a materialized snapshot, refusing symlinked ancestors. */
function snapshotEntryFile(cacheDir: string, relative: string): string {
  assertSafeRelativePath(relative)
  const treeDir = path.join(cacheDir, TREE_DIRNAME)
  checkRealDirectory(treeDir, "snapshot tree")
  const segments = relative.split("/")
  let current = treeDir
  for (let index = 0; index < segments.length - 1; index++) {
    current = path.join(current, segments[index] as string)
    checkRealDirectory(current, "snapshot directory")
  }
  const entry = path.join(current, segments[segments.length - 1] as string)
  assertInsideRoot(cacheDir, entry)
  return entry
}

/** The entry file's on-disk location for a provenance record. */
function entryFileFor(cacheDir: string, meta: GithubMeta): string {
  if (meta.layout === "snapshot") return snapshotEntryFile(cacheDir, meta.path)
  const pluginFile = path.join(cacheDir, GITHUB_PLUGIN_FILENAME)
  checkCacheFile(pluginFile, "plugin file")
  return pluginFile
}

/** Cache-hit path: verify identity, type, and bytes, then hand over the URL. */
function loadVerified(spec: GithubSpec, cacheDir: string): GithubResolveResult {
  const metaFile = path.join(cacheDir, META_FILENAME)
  checkCacheFile(metaFile, "provenance record")
  const meta = readProvenance(cacheDir)
  if (meta.owner !== spec.owner || meta.repo !== spec.repo) {
    fail(
      `refusing to load "${safe(githubLabel(spec))}": the cache at ${safe(cacheDir)} records ` +
        `${safe(meta.owner)}/${safe(meta.repo)}, not ${safe(spec.owner)}/${safe(spec.repo)}. ` +
        `Never loading unverified bytes; delete the cache directory to re-fetch`,
    )
  }
  const entryFile = entryFileFor(cacheDir, meta)
  let cached: Buffer
  try {
    cached = fs.readFileSync(entryFile)
  } catch (error) {
    fail(
      `refusing to load "${safe(githubLabel(spec))}": the cache at ${safe(cacheDir)} holds a provenance record ` +
        `but its entry file is unreadable (${safe((error as Error).message)}). ` +
        `Delete the cache directory to re-fetch — a broken cache is never silently re-fetched`,
    )
  }
  const actual = sha256BytesHex(cached)
  if (actual !== meta.sha256.toLowerCase()) {
    fail(
      `refusing to load "${safe(githubLabel(spec))}": the cached bytes at ${safe(entryFile)} do not match the ` +
        `recorded sha256 (recorded ${safe(meta.sha256)}, computed ${actual}). The cache may be corrupt. ` +
        `Never loading unverified bytes and never re-fetching over a mismatch; ` +
        `inspect and delete the cache directory to re-fetch`,
    )
  }
  return { url: pathToFileURL(entryFile).href, cacheDir, meta, fetched: false }
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

/**
 * Incremental binary size cap — the tarball counterpart of readBodyCapped.
 * Consume the body chunk by chunk and refuse the moment the running byte
 * count exceeds the cap, cancelling the reader mid-body. A breach is an
 * `ArchiveError("limit")` so the caller can degrade LOUDLY (single-file
 * fallback) instead of aborting; a read error is fail-closed as usual.
 */
async function readBodyCappedBytes(response: FetchResponseLike, what: string, cap: number): Promise<Uint8Array> {
  const body = response.body
  if (body === null || body === undefined || typeof body.getReader !== "function") {
    if (typeof response.arrayBuffer !== "function") {
      fail(`could not read the binary response for ${what}: the fetch implementation exposed neither a streaming body nor arrayBuffer()`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > cap) {
      throw new ArchiveError("limit", `the response for ${what} is ${buffer.byteLength} bytes, larger than the ${cap}-byte cap`)
    }
    return buffer
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
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
      if (total > cap) {
        try {
          await reader.cancel()
        } catch {
          // best effort — the refusal below is the real control
        }
        throw new ArchiveError("limit", `the response for ${what} exceeded the ${cap}-byte cap after ${total} bytes; reading was stopped mid-body`)
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks)
}

/** The codeload tarball URL for a RESOLVED 40-hex commit — one request for the whole tree. */
function codeloadUrl(owner: string, repo: string, commit: string): string {
  return `${CODELOAD_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${commit}`
}

/** What a snapshot attempt produced: either a materializable tree, or the loud reason it was not used. */
interface SnapshotOutcome {
  ok: boolean
  /** Why the snapshot was not used (single-file fallback reason); only when `ok` is false. */
  reason?: string
  files?: ArchiveFile[]
  entryPath?: string
  entryBytes?: Uint8Array
  tarballSha256?: string
  tarballBytes?: number
  treeBytes?: number
}

/**
 * Fetch and parse the repository snapshot at the resolved commit. Degrades by
 * RETURNING a reason (never silently): a network failure, a cap breach, a
 * malformed archive, or a non-materializable entry all route to the single
 * file fallback. One exception: an archive that tries to escape its root is
 * hostile and is refused outright — no fallback from a repository that serves
 * a traversal attempt.
 */
async function tryFetchSnapshot(
  spec: GithubSpec,
  resolvedCommit: string,
  doFetch: FetchLike,
  signal: AbortSignal,
  limits: GithubSnapshotLimits,
): Promise<SnapshotOutcome> {
  const where = `${safe(spec.owner)}/${safe(spec.repo)} at commit ${safe(resolvedCommit)}`
  const url = codeloadUrl(spec.owner, spec.repo, resolvedCommit)
  let response: FetchResponseLike
  try {
    response = await doFetch(url, {
      headers: { accept: "application/gzip", "user-agent": USER_AGENT },
      signal,
      redirect: "error",
    })
  } catch (error) {
    return { ok: false, reason: `the tarball download of ${where} failed (${safe(error instanceof Error ? error.message : String(error), 120)})` }
  }
  assertSameOrigin(url, response)
  if (!response.ok) {
    return { ok: false, reason: `the tarball of ${where} answered HTTP ${response.status}` }
  }
  let compressed: Uint8Array
  try {
    compressed = await readBodyCappedBytes(response, `the repository tarball of ${where}`, limits.tarballBytes)
  } catch (error) {
    if (error instanceof ArchiveError && error.kind === "limit") {
      return { ok: false, reason: `the tarball of ${where} exceeded the ${limits.tarballBytes}-byte download cap` }
    }
    return { ok: false, reason: `the tarball of ${where} could not be read (${safe(error instanceof Error ? error.message : String(error), 120)})` }
  }
  let contents: ArchiveContents
  try {
    contents = readTarGz(compressed, `${spec.repo}-${resolvedCommit}`, {
      maxBytes: limits.treeBytes,
      maxFiles: limits.files,
    })
  } catch (error) {
    if (!(error instanceof ArchiveError)) throw error
    if (error.kind === "unsafe") {
      fail(
        `refusing the repository snapshot of ${where}: ${safe(error.message)}. ` +
          `An archive that tries to escape its materialization root is never used — nothing was cached and nothing was executed`,
      )
    }
    return { ok: false, reason: `the snapshot of ${where} was refused (${safe(error.message)})` }
  }
  const byPath = new Map(contents.files.map((file) => [file.path, file]))
  const entryPath = candidatePaths(spec).find((candidate) => byPath.has(candidate))
  if (entryPath === undefined) {
    return {
      ok: false,
      reason: `none of the candidate plugin paths is present in the snapshot of ${where}`,
    }
  }
  const entry = byPath.get(entryPath) as ArchiveFile
  return {
    ok: true,
    files: contents.files,
    entryPath,
    entryBytes: entry.bytes,
    tarballSha256: sha256BytesHex(compressed),
    tarballBytes: compressed.byteLength,
    treeBytes: contents.totalBytes,
  }
}

/**
 * Write the parsed tree under `<cacheDir>/tree` through a staging directory
 * and one rename: a failed materialization leaves no partial tree. The
 * archive reader already validated every path; `assertInsideRoot` re-checks
 * each write target as a second line of defense.
 */
function materializeSnapshot(cacheDir: string, files: ArchiveFile[]): void {
  const treeDir = path.join(cacheDir, TREE_DIRNAME)
  if (fs.existsSync(treeDir)) {
    fail(
      `refusing to write the snapshot cache at ${safe(cacheDir)}: a "${TREE_DIRNAME}" directory is already present ` +
        `without a provenance record; delete the cache directory to re-fetch (an incomplete cache is never overwritten)`,
    )
  }
  const staging = path.join(cacheDir, `${TREE_DIRNAME}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`)
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    for (const file of files) {
      const target = path.join(staging, ...file.path.split("/"))
      assertInsideRoot(staging, target)
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.writeFileSync(target, file.bytes, { mode: 0o600 })
    }
    fs.renameSync(staging, treeDir)
  } catch (error) {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      // best effort — the outer rollback runs too
    }
    throw error
  }
}

/** The single-file fallback: probe the candidate raw files, always BY the resolved commit. */
async function fetchSingleFile(
  spec: GithubSpec,
  ref: string,
  resolvedCommit: string,
  doFetch: FetchLike,
  signal: AbortSignal,
): Promise<{ content: string; contentPath: string }> {
  const tried: string[] = []
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
    return { content: text, contentPath: candidate }
  }
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

/**
 * First-fetch path (consented): resolve ref + commit, then — in one request —
 * the repository snapshot at that commit. Over-cap or unreadable snapshots
 * fall back to the single raw file, recorded in meta (`layout` +
 * `snapshotFallback`) so every later mount note repeats the loss.
 */
async function fetchAndRecord(
  spec: GithubSpec,
  cacheDir: string,
  opts: GithubResolveOptions,
): Promise<GithubResolveResult> {
  const doFetch: FetchLike = opts.fetchImpl ?? globalThis.fetch
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)
  const limits: GithubSnapshotLimits = {
    tarballBytes: opts.limits?.tarballBytes ?? MAX_TARBALL_BYTES,
    treeBytes: opts.limits?.treeBytes ?? MAX_TREE_BYTES,
    files: opts.limits?.files ?? MAX_TREE_FILES,
  }

  const ref = spec.ref ?? (await resolveDefaultBranch(doFetch, spec, signal))
  const resolvedCommit = await resolveCommit(doFetch, spec, ref, signal)
  const warnings: string[] = []

  // A flat single-file cache from an earlier oc-bifrost (`<root>/<id>`) is
  // NEVER read as a snapshot. The layout version makes that structural; this
  // names it out loud so the old bytes are not silently forgotten.
  const legacyDir = path.join(opts.cacheRoot, githubCacheId(spec))
  if (isEntryFile(path.join(legacyDir, GITHUB_PLUGIN_FILENAME)) || isEntryFile(path.join(legacyDir, META_FILENAME))) {
    warnings.push(
      `a pre-snapshot single-file cache for this spec exists at ${safe(legacyDir)}; it cannot provide sibling files, ` +
        `so it is not used (delete it to reclaim the space)`,
    )
  }

  const fetchedAt = (opts.now ?? (() => new Date()))().toISOString()
  const snapshot = await tryFetchSnapshot(spec, resolvedCommit, doFetch, signal, limits)

  let meta: GithubMeta
  let entryFile: string
  let singleContent = ""
  if (snapshot.ok) {
    const entryBytes = snapshot.entryBytes as Uint8Array
    meta = {
      source: "github",
      owner: spec.owner,
      repo: spec.repo,
      ref,
      resolvedCommit,
      path: snapshot.entryPath as string,
      sha256: sha256BytesHex(entryBytes),
      bytes: entryBytes.byteLength,
      fetchedAt,
      layout: "snapshot",
      tarballSha256: snapshot.tarballSha256,
      tarballBytes: snapshot.tarballBytes,
      files: snapshot.files?.length ?? 0,
      treeBytes: snapshot.treeBytes,
    }
    entryFile = path.join(cacheDir, TREE_DIRNAME, ...(snapshot.entryPath as string).split("/"))
  } else {
    const single = await fetchSingleFile(spec, ref, resolvedCommit, doFetch, signal)
    singleContent = single.content
    meta = {
      source: "github",
      owner: spec.owner,
      repo: spec.repo,
      ref,
      resolvedCommit,
      path: single.contentPath,
      sha256: sha256Hex(single.content),
      bytes: Buffer.byteLength(single.content, "utf8"),
      fetchedAt,
      layout: "single-file",
      snapshotFallback: snapshot.reason,
    }
    entryFile = path.join(cacheDir, GITHUB_PLUGIN_FILENAME)
  }

  const metaFile = path.join(cacheDir, META_FILENAME)
  try {
    // The boundary was validated before the fetch; re-validate now that the
    // entry exists, immediately before any write — the no-follow shrink of
    // the race window (see validateCachePath).
    validateCacheLevels(opts.cacheRoot, githubCacheLayoutRoot(opts.cacheRoot), cacheDir)
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    if (meta.layout === "snapshot") {
      materializeSnapshot(cacheDir, snapshot.files as ArchiveFile[])
    } else {
      atomicWrite(entryFile, singleContent)
    }
    atomicWrite(metaFile, `${JSON.stringify(meta, null, 2)}\n`)
    try {
      fs.chmodSync(entryFile, 0o600)
      fs.chmodSync(metaFile, 0o600)
      fs.chmodSync(cacheDir, 0o700)
    } catch {
      // best effort — platforms without POSIX mode bits ignore this
    }
  } catch (error) {
    // Roll back OUR artifacts only: a failed first-fetch must leave NO
    // partial tree, NO partial plugin file, and NO temp leftover. The entry
    // directory itself and anything the user put there are left alone.
    const treeDir = path.join(cacheDir, TREE_DIRNAME)
    for (const victim of [entryFile, metaFile, treeDir]) {
      try {
        fs.rmSync(victim, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
    try {
      for (const name of fs.readdirSync(cacheDir)) {
        if (
          name.startsWith(`${TREE_DIRNAME}.tmp-`) ||
          name.startsWith(`${GITHUB_PLUGIN_FILENAME}.tmp-`) ||
          name.startsWith(`${META_FILENAME}.tmp-`)
        ) {
          fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true })
        }
      }
    } catch {
      // best effort
    }
    fail(
      `could not write the github: cache at ${safe(cacheDir)}: ${safe((error as Error).message, 400)}; ` +
        `partial state was removed — nothing will be executed from an incomplete cache`,
    )
  }
  return { url: pathToFileURL(entryFile).href, cacheDir, meta, fetched: true, warnings }
}

/**
 * Resolve a `github:` spec to an importable `file://` URL.
 *
 * Order: the cache-path boundary (root and entry must be absent or real
 * directories, realpath-contained — before ANY fetch or write) → cache hit
 * (file types checked, provenance-checked, entry hash-verified, zero network)
 * → consent gate (cold + unconsented refuses BEFORE any fetch) → consented
 * first fetch (ref → commit → repository snapshot by commit, single-file
 * fallback with a loud note, atomic cache write with rollback).
 */
export async function resolveGithubPlugin(
  spec: GithubSpec,
  opts: GithubResolveOptions,
): Promise<GithubResolveResult> {
  const layoutRoot = githubCacheLayoutRoot(opts.cacheRoot)
  const cacheDir = path.join(layoutRoot, githubCacheId(spec))
  validateCacheLevels(opts.cacheRoot, layoutRoot, cacheDir)
  const pluginFile = path.join(cacheDir, GITHUB_PLUGIN_FILENAME)
  const metaFile = path.join(cacheDir, META_FILENAME)
  // A directory-named plugin.ts/meta.json is NOT a cached entry: it routes to
  // the cold path, whose write then fails and rolls back (fail closed) —
  // while real files and links route to the verify path, which refuses links.
  if (isEntryFile(pluginFile) || isEntryFile(metaFile)) return loadVerified(spec, cacheDir)
  if (opts.trusted !== true) fail(consentMessage(spec))
  return fetchAndRecord(spec, cacheDir, opts)
}
