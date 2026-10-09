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
 *   - FIRST FETCHES ARE SERIALIZED PER CACHE ENTRY. Concurrent
 *     resolveGithubPlugin calls for the same spec (the host can activate the
 *     same configured package from several locations at once) share ONE
 *     fetch/materialize promise: a second pass awaiting the first can never
 *     observe the mid-write gap between the tree rename and the provenance
 *     write, so the "never overwrite an incomplete cache" refusal and its
 *     rollback (which would delete the first pass's partial state) never
 *     fire against a live sibling pass. A settled fetch clears the entry, so
 *     a later load behaves as before: warm cache hit, or a fresh retry after
 *     a failure.
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
 *   - PROVISIONING (spec §3, Phase 1). After a snapshot materializes and
 *     BEFORE its entry is imported, its declared dependencies
 *     (`dependencies` + `peerDependencies`) are provided into
 *     `<tree>/node_modules` - junctioned from the shared OpenCode npm cache
 *     root (zero network; `provision: "host"`, the default), with an
 *     `npm install --no-save` fallback when `provision: "npm"`. Every outcome
 *     is a loud mount-report row (`provision <pkg> - host:<path>` /
 *     `npm install --no-save` / `provision refused <pkg> - <reason>` /
 *     `provision skipped: no package.json`); a refusal under `strict` aborts
 *     setup. `node_modules` is a DERIVED layer: a marker
 *     (`<tree>/node_modules/.bifrost-provision.json`) lets every warm load
 *     re-verify cheaply (per-target realpath re-check + declared-deps drift)
 *     and re-provision only on drift or staleness; the meta digest never
 *     covers it. `provision: "off"` is 1.3.x behavior byte-for-byte.
 *     `OC_BIFROST_PROVISION` sets the mode when the option is omitted.
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
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ArchiveError, readTarGz } from "./archive.js";
import { provisionTree } from "./provision.js";
const GITHUB_SPEC_PATTERN = /^github:([^/@#\s]+)\/([^/@#\s]+)(?:@([^#\s]+))?(?:#(\S+))?$/;
/**
 * First-fetch serialization. Two concurrent resolveGithubPlugin calls for the
 * same cache entry must never run two fetchAndRecord passes against the same
 * cache directory: pass B can land mid-materialization, see `tree` without a
 * provenance record, fire the "never overwrite an incomplete cache" refusal,
 * and its rollback then REMOVES the partial state pass A is still writing -
 * so every reload re-fetches and the mount never completes. Keyed by the
 * fully derived cache directory (the cache id under its layout root), so
 * each in-flight first fetch is shared by every caller for that entry and
 * distinct roots never share a slot. A settled promise (fulfilled OR
 * rejected) removes the entry: a warm cache then serves later loads with
 * zero network and a failure leaves the next attempt free to retry exactly
 * like today.
 */
const inflightFetches = new Map();
/**
 * The warm-path counterpart of `inflightFetches`: the warm load WRITES when a
 * provisioned tree drifted or went stale (junctions and the marker), so two
 * concurrent warm loads of the same cache entry must share one verify pass -
 * otherwise a racing `linkIntoTree` EEXIST rows "provision refused" for a dep
 * the other caller provisioned (and, under strict, aborts setup for nothing).
 * Keyed on `cacheDir`, mirroring the cold-path pattern; a settled promise
 * removes its own entry.
 */
const inflightWarm = new Map();
const GITHUB_PLUGIN_FILENAME = "plugin.ts";
const META_FILENAME = "meta.json";
/** The materialized repository tree lives in this directory inside a snapshot cache entry. */
const TREE_DIRNAME = "tree";
/** Cache layout version directory. Ids stay stable per spec inside it; a flat single-file cache from earlier versions lives at `<root>/<id>` and is never mistaken for a snapshot. */
const GITHUB_CACHE_LAYOUT = "v2";
const RAW_ORIGIN = "https://raw.githubusercontent.com";
const API_ORIGIN = "https://api.github.com";
const CODELOAD_ORIGIN = "https://codeload.github.com";
const USER_AGENT = "oc-bifrost-github";
const TIMEOUT_MS = 10_000;
/** A plugin file larger than this is refused, never cached, never executed. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * Caps on the repository snapshot. Sized for plugin-bearing repositories
 * (the real `obra/superpowers@v6.4.2` snapshot is 641 KB compressed / 2.1 MB
 * uncompressed / 229 files) while still bounding untrusted input. A breach
 * refuses the SNAPSHOT and falls back to the single-file route, loudly — it
 * never truncates, and never happens silently.
 */
export const MAX_TARBALL_BYTES = 16 * 1024 * 1024;
export const MAX_TREE_BYTES = 64 * 1024 * 1024;
export const MAX_TREE_FILES = 5000;
const MAX_OWNER = 39;
const MAX_REPO = 100;
const MAX_REF = 200;
const MAX_PATH = 400;
const OWNER_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;
/** Every refusal carries the package prefix, like the rest of src/. */
function fail(message) {
    throw new Error(`[oc-bifrost] ${message}`);
}
/**
 * Neutralise control characters and cap the length of ANY untrusted string
 * before it reaches a message: a loud refusal must never be a terminal or
 * log hazard. Control characters are escaped (`\u0000`-style), never raw.
 */
export function safe(value, max = 200) {
    const escaped = String(value).replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return escaped.length > max ? `${escaped.slice(0, max)}…(truncated)` : escaped;
}
/** Canonical display form used in every message about this spec. */
export function githubLabel(spec) {
    let label = `github:${spec.owner}/${spec.repo}`;
    if (spec.ref !== undefined)
        label += `@${spec.ref}`;
    if (spec.path !== undefined)
        label += `#${spec.path}`;
    return label;
}
/**
 * Parity with `scripts/vendor-lib.mjs` `isValidRef`: a ref is safe to
 * interpolate into a URL. The charset excludes `%`, control characters, and
 * `..`; the only separator it may contain is the legitimate `/` (branch
 * names like `feature/next`), which is why the ref is NOT percent-encoded
 * when building raw URLs — encoding it would break branch refs, and the
 * strict charset is the control that makes raw use safe.
 */
export function isValidRef(ref) {
    if (ref === "")
        return false;
    if (ref.startsWith("-"))
        return false;
    if (!/^[A-Za-z0-9._/-]+$/.test(ref))
        return false;
    if (ref.includes(".."))
        return false;
    return true;
}
/** In-repo paths tried, in order, when the spec omits `#<path>`. */
export function candidatePaths(spec) {
    if (spec.path !== undefined)
        return [spec.path];
    return [`hooks/opencode/${spec.repo}.ts`, "hooks/opencode/index.ts", "plugin.ts", "index.ts"];
}
/** sha256 hex of the utf8 bytes — the same digest the provenance record pins. */
export function sha256Hex(content) {
    return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
/** sha256 hex of raw bytes — the digest form used for entry files and tarballs. */
function sha256BytesHex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
/** Parse and validate a `github:` specifier. Throws loudly on any malformed form. */
export function parseGithubSpec(spec) {
    const match = GITHUB_SPEC_PATTERN.exec(spec);
    if (!match) {
        fail(`invalid specifier "${safe(spec)}": expected "github:<owner>/<repo>[@<ref>][#<path>]"`);
    }
    const owner = match[1];
    const repo = match[2];
    const ref = match[3];
    const rawPath = match[4];
    const parsed = { owner: "", repo: "" };
    if (!OWNER_PATTERN.test(owner) || owner.length > MAX_OWNER) {
        fail(`invalid specifier "${safe(spec)}": the owner must be 1-${MAX_OWNER} GitHub-charset characters (letters, digits, single hyphens between them)`);
    }
    if (!REPO_PATTERN.test(repo) || repo === "." || repo === ".." || repo.length > MAX_REPO) {
        fail(`invalid specifier "${safe(spec)}": the repo must be 1-${MAX_REPO} GitHub-charset characters (letters, digits, ".", "_", "-") and must not be "." or ".."`);
    }
    parsed.owner = owner;
    parsed.repo = repo;
    if (ref !== undefined) {
        if (!isValidRef(ref) || ref.length > MAX_REF) {
            fail(`invalid specifier "${safe(spec)}": refs must match [A-Za-z0-9._/-] (max ${MAX_REF}), not start with "-", ` +
                `and contain no "..", "%", or control characters`);
        }
        parsed.ref = ref;
    }
    if (rawPath !== undefined)
        parsed.path = normalizeRepoPath(rawPath, spec);
    return parsed;
}
/**
 * Path validation: reject traversal, absolute paths, backslashes, `%`
 * (encoded separators), control characters, and empty/`.`/`..` segments.
 * A leading `./` is tolerated and stripped; a leading `/` is absolute and
 * refused, never normalized.
 */
function normalizeRepoPath(raw, spec) {
    if (raw.startsWith("/")) {
        fail(`invalid specifier "${safe(spec)}": the #<path> must be relative to the repository root, not "/${safe(raw)}"`);
    }
    const cleaned = raw.replace(/^\.?\//, "");
    if (cleaned === "")
        fail(`invalid specifier "${safe(spec)}": the #<path> must name a file in the repository`);
    if (cleaned.includes("\\"))
        fail(`invalid specifier "${safe(spec)}": paths use "/" separators, never backslashes`);
    if (cleaned.includes("%"))
        fail(`invalid specifier "${safe(spec)}": "%"/percent-encodings are not accepted in #<path> (nothing here may smuggle an encoded separator)`);
    for (const ch of cleaned) {
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
            fail(`invalid specifier "${safe(spec)}": control characters are not accepted in #<path>`);
        }
    }
    for (const segment of cleaned.split("/")) {
        if (segment === "" || segment === "." || segment === "..") {
            fail(`invalid specifier "${safe(spec)}": path segments must be non-empty and may not be "." or ".."`);
        }
    }
    if (cleaned.length > MAX_PATH)
        fail(`invalid specifier "${safe(spec)}": the #<path> exceeds ${MAX_PATH} characters`);
    return cleaned;
}
function sanitizeSegment(value) {
    const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    return (cleaned === "" ? "x" : cleaned).slice(0, 64);
}
/**
 * Deterministic, collision-resistant cache directory name for the
 * NORMALIZED spec. Derived ONLY from the spec (owner/repo and the spec's own
 * ref/path, with `default` standing in for omitted parts) so a cache hit
 * needs zero network. A sha256-derived suffix keys the RAW parts, so two
 * specs whose sanitized readable forms coincide can never share a directory.
 */
export function githubCacheId(spec) {
    const parts = [spec.owner, spec.repo, spec.ref ?? "default", spec.path ?? "default"];
    const readable = parts.map(sanitizeSegment).join("--").slice(0, 96);
    const digest = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16);
    return `${readable}-${digest}`;
}
/**
 * The STABLE prefix of that spec's cache directory name: `owner--repo--`,
 * independent of the resolved ref, path, and digest. A tree's cli.json entry
 * URL always contains `/<family>` (the cache dir name begins with it), so a
 * re-provision at a new resolved ref - a new cache dir and a new URL - is
 * still recognizable as the SAME plugin and its previous entry can be pruned.
 */
export function githubCacheRepoPrefix(spec) {
    return `${sanitizeSegment(spec.owner)}--${sanitizeSegment(spec.repo)}--`;
}
/**
 * The stable, ref-independent identity of the plugin a spec names: a sha256
 * over owner/repo/path. The cache directory name is ref-bearing (it changes
 * with every resolved commit), so it cannot serve as identity; this key is
 * recorded in the managed cli.json entry marker and claimed exactly.
 */
export function githubPluginKey(spec) {
    return createHash("sha256")
        .update([spec.owner, spec.repo, spec.path ?? ""].join("\u0000"), "utf8")
        .digest("hex")
        .slice(0, 16);
}
/**
 * The layout-versioned cache root. Directory versioning is what keeps a flat
 * single-file cache written by an earlier oc-bifrost (`<root>/<id>`) from ever
 * being read as if it were a materialized snapshot: the new code only looks
 * under `<root>/v2/`, so the old entry is cold, re-fetched (with the same
 * one-time consent), and reported in the mount note.
 */
export function githubCacheLayoutRoot(cacheRoot) {
    return path.join(cacheRoot, GITHUB_CACHE_LAYOUT);
}
/**
 * The full cache boundary, all levels: the base root, the layout-versioned
 * root, and the per-spec entry. Each level is checked with the same rule —
 * absent or a REAL directory, never a symlink, realpath-contained — so a
 * symlinked base root is caught even when the layout directory does not exist
 * yet.
 */
function validateCacheLevels(cacheRoot, layoutRoot, cacheDir) {
    assertInsideRoot(cacheRoot, layoutRoot);
    assertInsideRoot(layoutRoot, cacheDir);
    validateCachePath(cacheRoot, layoutRoot);
    validateCachePath(layoutRoot, cacheDir);
}
/**
 * Fail-closed guard: after resolving the cache path, assert it stays INSIDE
 * the cache root. Exported pure for tests.
 */
export function assertInsideRoot(cacheRoot, dir) {
    const rel = path.relative(cacheRoot, dir);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        fail(`internal guard tripped: the cache path ${safe(dir)} does not stay inside the cache root ${safe(cacheRoot)}; refusing (fail closed)`);
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
export function validateCachePath(cacheRoot, cacheDir) {
    for (const [target, what] of [
        [cacheRoot, "root"],
        [cacheDir, "entry"],
    ]) {
        let stats;
        try {
            stats = fs.lstatSync(target);
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            fail(`refusing to use the cache ${what} at ${safe(target)}: ${safe(error.message)}`);
        }
        if (stats.isSymbolicLink()) {
            fail(`refusing to use the cache ${what} at ${safe(target)}: it is a symlink, and cache writes must never follow one`);
        }
        if (!stats.isDirectory()) {
            fail(`refusing to use the cache ${what} at ${safe(target)}: it is not a directory`);
        }
    }
    let realRoot;
    let realDir;
    try {
        realRoot = fs.realpathSync(cacheRoot);
        realDir = fs.realpathSync(cacheDir);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return; // root or entry absent: nothing to resolve yet
        fail(`refusing to use the cache: ${safe(error.message)}`);
    }
    if (realDir !== path.join(realRoot, path.basename(cacheDir))) {
        fail(`refusing to use the cache entry at ${safe(cacheDir)}: its real location (${safe(realDir)}) ` +
            `escapes the cache root (${safe(realRoot)})`);
    }
}
/** True when the path is an entry FILE (or a link — which the verify path then refuses), false when absent or a directory. */
function isEntryFile(target) {
    try {
        const stats = fs.lstatSync(target);
        return stats.isFile() || stats.isSymbolicLink();
    }
    catch {
        return false;
    }
}
/**
 * Whether first-use remote fetching is consented. An explicit option wins:
 * `trustRemote: false` disables the fetch even when the environment asks for
 * it (mirrors freshnessEnabled). When the option is omitted,
 * `OC_BIFROST_TRUST === "github"` consents.
 */
export function remoteTrustEnabled(option, env = process.env) {
    if (option !== undefined)
        return option;
    return String(env?.OC_BIFROST_TRUST ?? "").trim().toLowerCase() === "github";
}
/**
 * The provisioning mode. An explicit option wins over the env var; omitted,
 * `OC_BIFROST_PROVISION` decides; unset, the default is `"host"`. Any other
 * value is a loud refusal (a typo must never silently disable provisioning).
 * Pure.
 */
export function provisionMode(option, env = process.env) {
    const raw = option !== undefined ? String(option) : env?.OC_BIFROST_PROVISION;
    const value = String(raw ?? "").trim().toLowerCase();
    if (value === "host" || value === "npm" || value === "off")
        return value;
    if (value === "")
        return "host";
    fail(`invalid provision mode "${safe(raw ?? "")}": expected "host", "npm", or "off" ` +
        `(options.provision, or the OC_BIFROST_PROVISION environment variable)`);
}
/**
 * The default host-store root: the shared OpenCode npm cache - the `npm`
 * SIBLING of the bridge's own `oc-bifrost` cache dir under the same
 * `<XDG_CACHE_HOME or ~/.cache>/opencode` base `githubCacheRoot` derives from
 * (controller ruling R-2; the `oc-bifrost` dir itself is a known-wrong guess).
 * Live layout: `<root>/<name>@<version>/<cacheId>/node_modules/<name>`.
 */
export function defaultHostStoreRoot(homeDirectory = os.homedir(), env = process.env) {
    const cacheHome = env.XDG_CACHE_HOME || path.join(homeDirectory, ".cache");
    return path.join(cacheHome, "opencode", "npm");
}
/**
 * The declared dependency names of a materialized tree - the union of
 * `dependencies` and `peerDependencies` keys, deduped, in declaration order.
 * Null when there is no readable, parseable manifest (a malformed manifest
 * conflates with a missing one, per controller ruling M5).
 */
function readDeclaredDeps(treeDir) {
    let raw;
    try {
        raw = fs.readFileSync(path.join(treeDir, "package.json"), "utf8");
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object")
        return null;
    const record = parsed;
    const declared = [];
    for (const field of ["dependencies", "peerDependencies"]) {
        const value = record[field];
        if (value !== null && typeof value === "object") {
            for (const key of Object.keys(value)) {
                if (!declared.includes(key))
                    declared.push(key);
            }
        }
    }
    return declared;
}
const PROVISION_MARKER_FILENAME = ".bifrost-provision.json";
/** Read and shape-check the marker; null when absent or in any way damaged. */
function readMarker(treeDir) {
    let raw;
    try {
        raw = fs.readFileSync(path.join(treeDir, "node_modules", PROVISION_MARKER_FILENAME), "utf8");
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object")
        return null;
    const record = parsed;
    if (record.version !== 1)
        return null;
    const deps = record.deps;
    const actions = record.actions;
    if (!Array.isArray(deps) || !deps.every((dep) => typeof dep === "string"))
        return null;
    if (!Array.isArray(actions))
        return null;
    for (const entry of actions) {
        if (entry === null || typeof entry !== "object")
            return null;
        const action = entry;
        if (typeof action.package !== "string" || typeof action.target !== "string")
            return null;
        if (action.source !== "host" && action.source !== "npm" && action.source !== "skip")
            return null;
    }
    return { version: 1, deps: deps, actions: actions };
}
/** True when `p` is a link (junction on Windows, symlink elsewhere). */
function isLink(p) {
    try {
        return fs.lstatSync(p).isSymbolicLink();
    }
    catch {
        return false;
    }
}
/** Remove a LINK only (junction/symlink - never a real directory, never recursive). */
function removeLink(p) {
    try {
        fs.rmdirSync(p);
        return true;
    }
    catch {
        // fall through to unlink (POSIX symlinks are files to the fs layer)
    }
    try {
        fs.unlinkSync(p);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The tree-local destination of a marker action: `<tree>/node_modules/<name>`.
 * Null when the marker name escapes that root (a hostile marker is refused
 * out loud, never followed - the marker is a derived-layer record, untrusted).
 */
function markerDestination(treeDir, action) {
    const dest = path.join(treeDir, "node_modules", ...action.package.split("/"));
    const rel = path.relative(path.join(treeDir, "node_modules"), dest);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
        return null;
    return dest;
}
/** Canonical realpath, case-folded on Windows; null when the path does not exist. */
function canonicalRealpath(p) {
    try {
        const real = fs.realpathSync(p);
        return process.platform === "win32" ? real.toLowerCase() : real;
    }
    catch {
        return null;
    }
}
/**
 * A marker action is coherent when its tree-local destination RESOLVES to the
 * recorded target: `realpath(dest)` must exist and equal `realpath(target)`.
 * This is spec §3's cheap realpath re-check - for `source: "host"` actions the
 * marker records the STORE directory, so only the junction's own resolution
 * can prove the tree can still reach it: a deleted or repointed junction whose
 * store stays alive fails here and routes to the re-provision path.
 */
function markerActionCoherent(treeDir, action) {
    const dest = markerDestination(treeDir, action);
    if (dest === null)
        return false;
    const destReal = canonicalRealpath(dest);
    if (destReal === null)
        return false;
    const targetReal = canonicalRealpath(action.target);
    return targetReal !== null && destReal === targetReal;
}
/**
 * Write the marker when a provision took actions. Creates the tree-local
 * `node_modules` first: an `npm install` that exits 0 without creating it is
 * a real possibility, and the marker must never destroy the fetch it records.
 * A write failure DEGRADES to a loud row (returned, never thrown): the cache
 * is complete and verified without the marker, and the next load simply
 * re-verifies and can re-provision. Returns null on success, else the reason.
 */
function writeMarker(treeDir, report) {
    const marker = {
        version: 1,
        deps: report.actions.map((action) => action.package),
        actions: report.actions.map((action) => ({ package: action.package, source: action.source, target: action.target })),
    };
    const markerFile = path.join(treeDir, "node_modules", PROVISION_MARKER_FILENAME);
    try {
        fs.mkdirSync(path.dirname(markerFile), { recursive: true });
        atomicWrite(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
        return null;
    }
    catch (error) {
        return `could not write the provision marker at ${safe(markerFile)}: ${safe(error.message, 200)}`;
    }
}
/** The mechanism-naming reason for a provision refusal, per mode. */
function provisionRefusalReason(mode) {
    return mode === "npm"
        ? "no host-store hit and npm install --no-save failed"
        : 'no host-store hit (npm fallback is off; to enable it set provision: "npm")';
}
/** The one-line refusal row text (matches the strict throw). */
function provisionRow(name, mode) {
    return `provision refused ${name} - ${provisionRefusalReason(mode)}`;
}
/** The mount-report rows for one provision pass. */
function provisionRows(report, mode) {
    const rows = [];
    let npmRowEmitted = false;
    for (const action of report.actions) {
        if (action.source === "host")
            rows.push(`provision ${action.package} - host:${safe(action.target)}`);
        else if (action.source === "npm") {
            // R-6: ONE row per npm install run, not one per package - emitted at the
            // first npm action's position.
            if (!npmRowEmitted) {
                rows.push("npm install --no-save");
                npmRowEmitted = true;
            }
        }
        // "skip" is status quo, not an event: no row.
    }
    for (const name of report.refused)
        rows.push(provisionRow(name, mode));
    return rows;
}
/**
 * The warm-reload counterpart of provisioning (spec §3): the marker written at
 * provision time lets every load re-verify the derived layer CHEAPLY - a
 * per-action realpath re-check of each tree-local destination (a store that
 * moves, or a junction that is deleted or repointed, leaves its resolution
 * stale) and a declared-deps drift check. A coherent marker means zero work
 * and zero re-provisioning; drift, a stale link, or a missing marker
 * re-provisions (idempotent for what is present, zero network while host hits
 * last) and rewrites the marker. Anything still refused is a loud row - and,
 * under `strict`, a throw.
 */
async function verifyProvisionedTree(treeDir, opts) {
    const mode = provisionMode(opts.provision, process.env);
    if (mode === "off")
        return [];
    const declared = readDeclaredDeps(treeDir);
    if (declared === null)
        return []; // nothing declares anything: nothing to verify
    const marker = readMarker(treeDir);
    const rows = [];
    if (marker !== null && !declared.some((dep) => !marker.deps.includes(dep))) {
        // The marker covers every declared dep: the cheap realpath re-check is
        // the whole re-verification. Coherent -> zero work, zero network.
        if (!marker.actions.some((action) => !markerActionCoherent(treeDir, action)))
            return [];
        // At least one tree-local link went stale (a store moved, a junction was
        // deleted or repointed, a package was removed): fall through and re-provision.
    }
    // Remove every stale link the marker knows about BEFORE re-provisioning, so
    // provisionTree's presence check can never mistake a dead junction for a
    // skip. The marker is a derived-layer record: its names are validated the
    // same way provisionTree validates them - a marker that names an escaping
    // path is refused out loud, never followed.
    if (marker !== null) {
        for (const action of marker.actions) {
            const dest = markerDestination(treeDir, action);
            if (dest === null) {
                rows.push(`provision refused ${safe(action.package)} - a marker entry names a path outside the tree's node_modules`);
                continue;
            }
            if (markerActionCoherent(treeDir, action))
                continue;
            if (isLink(dest) && !removeLink(dest)) {
                rows.push(`provision refused ${safe(action.package)} - a stale junction could not be replaced (locked or write-protected)`);
            }
        }
    }
    const report = await provisionTree(treeDir, {
        hostStores: opts.hostStores ?? [defaultHostStoreRoot()],
        npm: mode === "npm",
    });
    rows.push(...provisionRows(report, mode));
    if (report.actions.length > 0) {
        const markerFailure = writeMarker(treeDir, report);
        if (markerFailure !== null)
            rows.push(`provision refused - ${markerFailure}`);
    }
    if (opts.strict === true && report.refused.length > 0)
        fail(provisionRow(report.refused[0], mode));
    return rows;
}
/**
 * The informed-consent refusal for a cold cache. Names exactly what is about
 * to be fetched, that it will execute with the host process's full user
 * rights, and what provisioning the SAME opt-in also authorizes - before
 * anything is fetched.
 */
export function consentMessage(spec) {
    const target = spec.path !== undefined
        ? `the repository snapshot at the resolved commit (up to ${MAX_TARBALL_BYTES} compressed bytes), including the entry file "${safe(spec.path)}"`
        : `the repository snapshot at the resolved commit (up to ${MAX_TARBALL_BYTES} compressed bytes), including one of, in order: ${candidatePaths(spec).join(", ")}`;
    const refPart = spec.ref !== undefined ? `ref "${safe(spec.ref)}"` : `the repository's default branch (resolved at fetch time)`;
    return (`[oc-bifrost] refusing to fetch "${safe(githubLabel(spec))}" (cold cache, first use): the first fetch would download ${target} ` +
        `from https://github.com/${spec.owner}/${spec.repo} at ${refPart} and EXECUTE its entry file with this host process's full user rights. ` +
        `That same fetch also resolves and provisions the entry's declared dependencies before the entry is imported: with options.provision: "host" (the default) each dependency is linked in from the host's own plugin store, with options.provision: "npm" anything the host lacks is downloaded and installed by npm inside the verified cache tree, and with options.provision: "off" provisioning is skipped entirely (1.3.x behavior). ` +
        `Provisioning runs with the same host rights, under this one opt-in - no second consent. ` +
        `First-use fetching is opt-in, per oc-bifrost entry: set options.trustRemote: true, or set the environment variable OC_BIFROST_TRUST=github. ` +
        `Nothing was fetched and nothing was executed. A warm (hash-verified) cache never needs this consent.`);
}
/** Fail-closed wording for every network failure on the cold path. */
function offlineMessage(what, error) {
    return (`[oc-bifrost] ${what} (${safe(error instanceof Error ? error.message : String(error))}). ` +
        `Cold-cache fetching is fail-closed — oc-bifrost never falls back to another source. ` +
        `If this machine is offline or air-gapped, pre-warm the shared cache on a networked machine (run oc-bifrost once with opt-in) ` +
        `and copy its oc-bifrost/github cache directory across.`);
}
/**
 * The mount-report note. ALWAYS names the resolved commit, the digest, and
 * the fact that the plugin executes with the host process's full user
 * rights — so the consent (given once at first fetch) stays informed on
 * every later load. When the single-file fallback was used (or a warm cache
 * holds one), it says so loudly: sibling files are NOT available and a plugin
 * that reads them by relative path is inert.
 */
export function mountNote(meta, fetched) {
    const short = `${meta.sha256.slice(0, 12)}…`;
    const where = `${safe(meta.source)}:${safe(meta.owner)}/${safe(meta.repo)}@${safe(meta.ref)}#${safe(meta.path)}`;
    const snapshot = meta.layout === "snapshot";
    const snapshotDetail = snapshot
        ? ` as a repository snapshot (${meta.files ?? 0} files, ${meta.treeBytes ?? 0} bytes materialized; tarball sha256 ${String(meta.tarballSha256 ?? "").slice(0, 12)}…)`
        : ` as a SINGLE FILE — the repository snapshot was not used${meta.snapshotFallback !== undefined ? ` (${safe(meta.snapshotFallback)})` : ""}; sibling files are NOT available, and a plugin that reads them by relative path is inert`;
    const head = fetched
        ? `fetched ${where} at commit ${safe(meta.resolvedCommit)}${snapshotDetail} (entry sha256 ${short}, ${meta.bytes} bytes; trust-on-first-use)`
        : snapshot
            ? `loaded from cache (commit ${safe(meta.resolvedCommit)}, repository snapshot ${meta.files ?? 0} files; entry sha256 ${short} verified; fetched ${safe(meta.fetchedAt)})`
            : `loaded from cache (commit ${safe(meta.resolvedCommit)}, SINGLE FILE — sibling files are NOT available and a plugin that reads them by relative path is inert; sha256 ${short} verified; fetched ${safe(meta.fetchedAt)})`;
    return `${head}; executes with the host process's full user rights`;
}
/** Component-aware URL builders on FIXED origins — no unchecked concatenation. */
function rawUrl(owner, repo, ref, filePath) {
    // owner/repo pass a strict charset (encoding is a no-op but explicit); the
    // ref passes isValidRef and is deliberately unencoded (see isValidRef); the
    // path is encoded per SEGMENT so a segment can never introduce a separator.
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    return `${RAW_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${ref}/${encodedPath}`;
}
function apiRepoUrl(owner, repo) {
    return `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
function apiCommitUrl(owner, repo, ref) {
    return `${apiRepoUrl(owner, repo)}/commits/${encodeURIComponent(ref)}`;
}
/** The response must not have left the fixed origin (defense against a proxy/mock redirect). */
function assertSameOrigin(requested, response) {
    if (response.url === undefined)
        return;
    const originOf = (value) => {
        try {
            return new URL(value).origin;
        }
        catch {
            return undefined;
        }
    };
    const from = originOf(requested);
    const to = originOf(response.url);
    if (from === undefined || to === undefined) {
        fail(`refusing to fetch: the response URL could not be parsed (${safe(response.url)}); redirects outside the fixed origins are never followed`);
    }
    if (to !== from) {
        fail(`refusing to fetch: the fetch left the allowed origin ${safe(from)} (landed on ${safe(to)}); redirects outside it are never followed`);
    }
}
function apiHeaders() {
    return { accept: "application/vnd.github+json", "user-agent": USER_AGENT };
}
/** Read + shape-check the provenance record. Any gap is a loud refusal. */
function readProvenance(cacheDir) {
    const missing = `the cached copy at ${safe(cacheDir)} has no readable provenance record (meta.json). ` +
        `Never loading unverified bytes; delete the cache directory to re-fetch`;
    let raw;
    try {
        raw = fs.readFileSync(path.join(cacheDir, META_FILENAME), "utf8");
    }
    catch (error) {
        fail(`${missing} (${safe(error.message)})`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        fail(`${missing} (invalid JSON: ${safe(error.message)})`);
    }
    const complete = typeof parsed.source === "string" && parsed.source !== "" &&
        typeof parsed.owner === "string" && parsed.owner !== "" &&
        typeof parsed.repo === "string" && parsed.repo !== "" &&
        typeof parsed.ref === "string" && parsed.ref !== "" &&
        typeof parsed.resolvedCommit === "string" && COMMIT_PATTERN.test(parsed.resolvedCommit) &&
        typeof parsed.path === "string" && parsed.path !== "" &&
        typeof parsed.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(parsed.sha256) &&
        typeof parsed.bytes === "number" && Number.isFinite(parsed.bytes) &&
        typeof parsed.fetchedAt === "string" &&
        (parsed.layout === "snapshot" || parsed.layout === "single-file");
    const snapshotComplete = parsed.layout !== "snapshot" ||
        (typeof parsed.tarballSha256 === "string" && /^[0-9a-fA-F]{64}$/.test(parsed.tarballSha256) &&
            typeof parsed.tarballBytes === "number" && Number.isFinite(parsed.tarballBytes) &&
            typeof parsed.files === "number" && Number.isFinite(parsed.files) &&
            typeof parsed.treeBytes === "number" && Number.isFinite(parsed.treeBytes));
    if (!complete || !snapshotComplete) {
        fail(`${missing} (the record it holds is incomplete — it predates the snapshot layout or is damaged; ` +
            `delete the cache directory to re-fetch)`);
    }
    return parsed;
}
/** Cache files must be real files, never links or odd node types. (The root/entry DIRECTORY checks live in validateCachePath.) */
function checkCacheFile(file, what) {
    let stats;
    try {
        stats = fs.lstatSync(file);
    }
    catch (error) {
        fail(`refusing to load: the cached ${what} at ${safe(file)} is unreadable (${safe(error.message)}); delete the cache directory to re-fetch`);
    }
    if (stats.isSymbolicLink()) {
        fail(`refusing to load: the cached ${what} at ${safe(file)} is a symlink; delete the cache directory to re-fetch`);
    }
    if (!stats.isFile()) {
        fail(`refusing to load: the cached ${what} at ${safe(file)} is not a regular file; delete the cache directory to re-fetch`);
    }
}
/** A stored relative path must never be trusted straight into `path.join`. */
function assertSafeRelativePath(relative) {
    if (relative === "" || relative.startsWith("/") || relative.includes("\\") || relative.includes("\0")) {
        fail(`refusing to load: the recorded entry path (${safe(relative)}) is not a plain relative path; delete the cache directory to re-fetch`);
    }
    for (const segment of relative.split("/")) {
        if (segment === "" || segment === "." || segment === ".." || segment.includes(":")) {
            fail(`refusing to load: the recorded entry path (${safe(relative)}) contains an unsafe segment; delete the cache directory to re-fetch`);
        }
    }
}
/** A real directory, never a symlink — the walk between the cache entry and the entry file. */
function checkRealDirectory(directory, what) {
    let stats;
    try {
        stats = fs.lstatSync(directory);
    }
    catch (error) {
        fail(`refusing to load: the cached ${what} at ${safe(directory)} is unreadable (${safe(error.message)}); delete the cache directory to re-fetch`);
    }
    if (stats.isSymbolicLink()) {
        fail(`refusing to load: the cached ${what} at ${safe(directory)} is a symlink; delete the cache directory to re-fetch`);
    }
    if (!stats.isDirectory()) {
        fail(`refusing to load: the cached ${what} at ${safe(directory)} is not a directory; delete the cache directory to re-fetch`);
    }
}
/** Resolve the entry file inside a materialized snapshot, refusing symlinked ancestors. */
function snapshotEntryFile(cacheDir, relative) {
    assertSafeRelativePath(relative);
    const treeDir = path.join(cacheDir, TREE_DIRNAME);
    checkRealDirectory(treeDir, "snapshot tree");
    const segments = relative.split("/");
    let current = treeDir;
    for (let index = 0; index < segments.length - 1; index++) {
        current = path.join(current, segments[index]);
        checkRealDirectory(current, "snapshot directory");
    }
    const entry = path.join(current, segments[segments.length - 1]);
    assertInsideRoot(cacheDir, entry);
    return entry;
}
/** The entry file's on-disk location for a provenance record. */
function entryFileFor(cacheDir, meta) {
    if (meta.layout === "snapshot")
        return snapshotEntryFile(cacheDir, meta.path);
    const pluginFile = path.join(cacheDir, GITHUB_PLUGIN_FILENAME);
    checkCacheFile(pluginFile, "plugin file");
    return pluginFile;
}
/**
 * Cache-hit path: verify identity, type, and bytes, then hand over the URL.
 * Serialized per cache entry (`inflightWarm`): a warm load WRITES when it
 * re-provisions a drifted or stale tree (junctions + marker), so concurrent
 * warm loads of the same entry share one pass instead of racing each other.
 */
async function loadVerified(spec, cacheDir, opts) {
    const existing = inflightWarm.get(cacheDir);
    if (existing !== undefined)
        return existing;
    const promise = loadVerifiedInner(spec, cacheDir, opts).finally(() => {
        // The map holds at most one promise per key - the one this call created -
        // so a settled load always clears its own entry (mirrors inflightFetches).
        inflightWarm.delete(cacheDir);
    });
    inflightWarm.set(cacheDir, promise);
    return promise;
}
async function loadVerifiedInner(spec, cacheDir, opts) {
    const metaFile = path.join(cacheDir, META_FILENAME);
    checkCacheFile(metaFile, "provenance record");
    const meta = readProvenance(cacheDir);
    if (meta.owner !== spec.owner || meta.repo !== spec.repo) {
        fail(`refusing to load "${safe(githubLabel(spec))}": the cache at ${safe(cacheDir)} records ` +
            `${safe(meta.owner)}/${safe(meta.repo)}, not ${safe(spec.owner)}/${safe(spec.repo)}. ` +
            `Never loading unverified bytes; delete the cache directory to re-fetch`);
    }
    const entryFile = entryFileFor(cacheDir, meta);
    let cached;
    try {
        cached = fs.readFileSync(entryFile);
    }
    catch (error) {
        fail(`refusing to load "${safe(githubLabel(spec))}": the cache at ${safe(cacheDir)} holds a provenance record ` +
            `but its entry file is unreadable (${safe(error.message)}). ` +
            `Delete the cache directory to re-fetch — a broken cache is never silently re-fetched`);
    }
    const actual = sha256BytesHex(cached);
    if (actual !== meta.sha256.toLowerCase()) {
        fail(`refusing to load "${safe(githubLabel(spec))}": the cached bytes at ${safe(entryFile)} do not match the ` +
            `recorded sha256 (recorded ${safe(meta.sha256)}, computed ${actual}). The cache may be corrupt. ` +
            `Never loading unverified bytes and never re-fetching over a mismatch; ` +
            `inspect and delete the cache directory to re-fetch`);
    }
    const provision = [];
    if (meta.layout === "snapshot") {
        provision.push(...(await verifyProvisionedTree(path.join(cacheDir, TREE_DIRNAME), opts)));
    }
    return {
        url: pathToFileURL(entryFile).href,
        cacheDir,
        meta,
        fetched: false,
        ...(provision.length > 0 ? { provision } : {}),
    };
}
/** Resolve the repository's default branch. Any failure is loud and suggests the fix. */
async function resolveDefaultBranch(doFetch, spec, signal) {
    const hint = `pass an explicit ref: github:${spec.owner}/${spec.repo}@<ref>`;
    const url = apiRepoUrl(spec.owner, spec.repo);
    let response;
    try {
        response = await doFetch(url, { headers: apiHeaders(), signal, redirect: "error" });
    }
    catch (error) {
        fail(offlineMessage(`could not resolve the default branch of ${safe(spec.owner)}/${safe(spec.repo)}`, error) + ` Alternatively, ${hint}.`);
    }
    assertSameOrigin(url, response);
    if (!response.ok) {
        fail(`could not resolve the default branch of ${safe(spec.owner)}/${safe(spec.repo)}: HTTP ${response.status}; ${hint}`);
    }
    let data;
    try {
        data = await response.json();
    }
    catch (error) {
        fail(`could not resolve the default branch of ${safe(spec.owner)}/${safe(spec.repo)}: the response was not JSON (${safe(error.message)}); ${hint}`);
    }
    const branch = data !== null && typeof data === "object" && typeof data["default_branch"] === "string"
        ? data["default_branch"].trim()
        : "";
    if (branch === "" || !isValidRef(branch) || branch.length > MAX_REF) {
        fail(`could not resolve the default branch of ${safe(spec.owner)}/${safe(spec.repo)}: the API returned no usable ` +
            `default_branch (${safe(branch, 80)}); ${hint}`);
    }
    return branch;
}
/** Resolve a ref to its commit sha — the immutable identity recorded in meta. */
async function resolveCommit(doFetch, spec, ref, signal) {
    // A full 40-hex ref already IS the commit identity the API would return -
    // the resolution call could only echo it back, so it is skipped outright:
    // fully-pinned specs must mount even where the API is unreachable.
    if (COMMIT_PATTERN.test(ref)) {
        return ref.toLowerCase();
    }
    const url = apiCommitUrl(spec.owner, spec.repo, ref);
    let response;
    try {
        response = await doFetch(url, { headers: apiHeaders(), signal, redirect: "error" });
    }
    catch (error) {
        fail(offlineMessage(`could not resolve ${safe(ref)} to a commit for ${safe(spec.owner)}/${safe(spec.repo)}`, error));
    }
    assertSameOrigin(url, response);
    if (!response.ok) {
        fail(`could not resolve ref "${safe(ref)}" to a commit for ${safe(spec.owner)}/${safe(spec.repo)}: HTTP ${response.status}`);
    }
    let data;
    try {
        data = await response.json();
    }
    catch (error) {
        fail(`could not resolve ref "${safe(ref)}" to a commit: the response was not JSON (${safe(error.message)})`);
    }
    const sha = data !== null && typeof data === "object" && typeof data["sha"] === "string"
        ? data["sha"].trim()
        : "";
    if (!COMMIT_PATTERN.test(sha)) {
        fail(`could not resolve ref "${safe(ref)}" to a commit: the API returned no usable commit sha (${safe(sha, 80)})`);
    }
    return sha.toLowerCase();
}
/** Atomic, least-permissive write: temp file + rename, never a partial artifact. */
function atomicWrite(file, content) {
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
        fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, file);
    }
    catch (error) {
        try {
            fs.unlinkSync(tmp);
        }
        catch {
            // best effort: the temp file may never have existed
        }
        throw error;
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
async function readBodyCapped(response, what) {
    const body = response.body;
    if (body === null || body === undefined || typeof body.getReader !== "function") {
        const text = await response.text();
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > MAX_RESPONSE_BYTES) {
            fail(`refusing the response for ${what}: it is ${bytes} bytes, larger than the ${MAX_RESPONSE_BYTES}-byte cap. ` +
                `Nothing was cached and nothing was executed.`);
        }
        return text;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let total = 0;
    let text = "";
    for (;;) {
        let chunk;
        try {
            chunk = await reader.read();
        }
        catch (error) {
            fail(offlineMessage(`could not read the response body for ${what}`, error));
        }
        if (chunk.done)
            break;
        const value = chunk.value;
        if (value !== undefined) {
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
                try {
                    await reader.cancel();
                }
                catch {
                    // best effort — the refusal below is the real control
                }
                fail(`refusing the response for ${what}: it exceeded the ${MAX_RESPONSE_BYTES}-byte cap after ${total} bytes ` +
                    `and reading was stopped mid-body. Nothing was cached and nothing was executed.`);
            }
            text += decoder.decode(value, { stream: true });
        }
    }
    return text + decoder.decode();
}
/**
 * Incremental binary size cap — the tarball counterpart of readBodyCapped.
 * Consume the body chunk by chunk and refuse the moment the running byte
 * count exceeds the cap, cancelling the reader mid-body. A breach is an
 * `ArchiveError("limit")` so the caller can degrade LOUDLY (single-file
 * fallback) instead of aborting; a read error is fail-closed as usual.
 */
async function readBodyCappedBytes(response, what, cap) {
    const body = response.body;
    if (body === null || body === undefined || typeof body.getReader !== "function") {
        if (typeof response.arrayBuffer !== "function") {
            fail(`could not read the binary response for ${what}: the fetch implementation exposed neither a streaming body nor arrayBuffer()`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > cap) {
            throw new ArchiveError("limit", `the response for ${what} is ${buffer.byteLength} bytes, larger than the ${cap}-byte cap`);
        }
        return buffer;
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        let chunk;
        try {
            chunk = await reader.read();
        }
        catch (error) {
            fail(offlineMessage(`could not read the response body for ${what}`, error));
        }
        if (chunk.done)
            break;
        const value = chunk.value;
        if (value !== undefined) {
            total += value.byteLength;
            if (total > cap) {
                try {
                    await reader.cancel();
                }
                catch {
                    // best effort — the refusal below is the real control
                }
                throw new ArchiveError("limit", `the response for ${what} exceeded the ${cap}-byte cap after ${total} bytes; reading was stopped mid-body`);
            }
            chunks.push(value);
        }
    }
    return Buffer.concat(chunks);
}
/** The codeload tarball URL for a RESOLVED 40-hex commit — one request for the whole tree. */
function codeloadUrl(owner, repo, commit) {
    return `${CODELOAD_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${commit}`;
}
/**
 * Fetch and parse the repository snapshot at the resolved commit. Degrades by
 * RETURNING a reason (never silently): a network failure, a cap breach, a
 * malformed archive, or a non-materializable entry all route to the single
 * file fallback. One exception: an archive that tries to escape its root is
 * hostile and is refused outright — no fallback from a repository that serves
 * a traversal attempt.
 */
async function tryFetchSnapshot(spec, resolvedCommit, doFetch, signal, limits) {
    const where = `${safe(spec.owner)}/${safe(spec.repo)} at commit ${safe(resolvedCommit)}`;
    const url = codeloadUrl(spec.owner, spec.repo, resolvedCommit);
    let response;
    try {
        response = await doFetch(url, {
            headers: { accept: "application/gzip", "user-agent": USER_AGENT },
            signal,
            redirect: "error",
        });
    }
    catch (error) {
        return { ok: false, reason: `the tarball download of ${where} failed (${safe(error instanceof Error ? error.message : String(error), 120)})` };
    }
    assertSameOrigin(url, response);
    if (!response.ok) {
        return { ok: false, reason: `the tarball of ${where} answered HTTP ${response.status}` };
    }
    let compressed;
    try {
        compressed = await readBodyCappedBytes(response, `the repository tarball of ${where}`, limits.tarballBytes);
    }
    catch (error) {
        if (error instanceof ArchiveError && error.kind === "limit") {
            return { ok: false, reason: `the tarball of ${where} exceeded the ${limits.tarballBytes}-byte download cap` };
        }
        return { ok: false, reason: `the tarball of ${where} could not be read (${safe(error instanceof Error ? error.message : String(error), 120)})` };
    }
    let contents;
    try {
        contents = readTarGz(compressed, `${spec.repo}-${resolvedCommit}`, {
            maxBytes: limits.treeBytes,
            maxFiles: limits.files,
        });
    }
    catch (error) {
        if (!(error instanceof ArchiveError))
            throw error;
        if (error.kind === "unsafe") {
            fail(`refusing the repository snapshot of ${where}: ${safe(error.message)}. ` +
                `An archive that tries to escape its materialization root is never used — nothing was cached and nothing was executed`);
        }
        return { ok: false, reason: `the snapshot of ${where} was refused (${safe(error.message)})` };
    }
    const byPath = new Map(contents.files.map((file) => [file.path, file]));
    const entryPath = candidatePaths(spec).find((candidate) => byPath.has(candidate));
    if (entryPath === undefined) {
        return {
            ok: false,
            reason: `none of the candidate plugin paths is present in the snapshot of ${where}`,
        };
    }
    const entry = byPath.get(entryPath);
    return {
        ok: true,
        files: contents.files,
        entryPath,
        entryBytes: entry.bytes,
        tarballSha256: sha256BytesHex(compressed),
        tarballBytes: compressed.byteLength,
        treeBytes: contents.totalBytes,
    };
}
/**
 * Write the parsed tree under `<cacheDir>/tree` through a staging directory
 * and one rename: a failed materialization leaves no partial tree. The
 * archive reader already validated every path; `assertInsideRoot` re-checks
 * each write target as a second line of defense.
 */
function materializeSnapshot(cacheDir, files) {
    const treeDir = path.join(cacheDir, TREE_DIRNAME);
    if (fs.existsSync(treeDir)) {
        fail(`refusing to write the snapshot cache at ${safe(cacheDir)}: a "${TREE_DIRNAME}" directory is already present ` +
            `without a provenance record; delete the cache directory to re-fetch (an incomplete cache is never overwritten)`);
    }
    const staging = path.join(cacheDir, `${TREE_DIRNAME}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
        for (const file of files) {
            const target = path.join(staging, ...file.path.split("/"));
            assertInsideRoot(staging, target);
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            fs.writeFileSync(target, file.bytes, { mode: 0o600 });
        }
        fs.renameSync(staging, treeDir);
    }
    catch (error) {
        try {
            fs.rmSync(staging, { recursive: true, force: true });
        }
        catch {
            // best effort — the outer rollback runs too
        }
        throw error;
    }
}
/** The single-file fallback: probe the candidate raw files, always BY the resolved commit. */
async function fetchSingleFile(spec, ref, resolvedCommit, doFetch, signal) {
    const tried = [];
    for (const candidate of candidatePaths(spec)) {
        // The content is downloaded BY the resolved commit, never by the ref: a
        // ref that moves between the commit lookup and the download can never
        // produce meta/bytes disagreement — the recorded commit IS the URL's
        // identity, so the cached bytes and the recorded provenance are the same
        // snapshot by construction.
        const url = rawUrl(spec.owner, spec.repo, resolvedCommit, candidate);
        let response;
        try {
            response = await doFetch(url, {
                headers: { accept: "text/plain", "user-agent": USER_AGENT },
                signal,
                redirect: "error",
            });
        }
        catch (error) {
            fail(offlineMessage(`could not download ${safe(candidate)} from ${safe(spec.owner)}/${safe(spec.repo)} at commit ${safe(resolvedCommit)}`, error));
        }
        assertSameOrigin(url, response);
        if (response.status === 404) {
            tried.push(`${safe(candidate)} (HTTP 404)`);
            continue;
        }
        if (!response.ok) {
            fail(`could not download ${safe(candidate)} from ${safe(spec.owner)}/${safe(spec.repo)} at commit ${safe(resolvedCommit)}: HTTP ${response.status}. ` +
                `Cold-cache fetching is fail-closed — oc-bifrost never falls back to another source.`);
        }
        const text = await readBodyCapped(response, `${safe(candidate)} from ${safe(spec.owner)}/${safe(spec.repo)} at commit ${safe(resolvedCommit)}`);
        if (text.trim() === "") {
            tried.push(`${safe(candidate)} (empty response)`);
            continue;
        }
        return { content: text, contentPath: candidate };
    }
    if (spec.path !== undefined) {
        fail(`plugin file "${safe(spec.path)}" not found in ${safe(spec.owner)}/${safe(spec.repo)} at ref ${safe(ref)}` +
            `${tried.length > 0 ? `: ${tried[0]}` : ""}`);
    }
    fail(`no plugin file found for ${safe(spec.owner)}/${safe(spec.repo)} at ref ${safe(ref)}. Tried, in order: ${tried.join("; ")}. ` +
        `Pass an explicit path: github:${safe(spec.owner)}/${safe(spec.repo)}#<path>`);
}
/**
 * First-fetch path (consented): resolve ref + commit, then — in one request —
 * the repository snapshot at that commit. Over-cap or unreadable snapshots
 * fall back to the single raw file, recorded in meta (`layout` +
 * `snapshotFallback`) so every later mount note repeats the loss.
 */
async function fetchAndRecord(spec, cacheDir, opts) {
    const doFetch = opts.fetchImpl ?? globalThis.fetch;
    const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
    const limits = {
        tarballBytes: opts.limits?.tarballBytes ?? MAX_TARBALL_BYTES,
        treeBytes: opts.limits?.treeBytes ?? MAX_TREE_BYTES,
        files: opts.limits?.files ?? MAX_TREE_FILES,
    };
    const ref = spec.ref ?? (await resolveDefaultBranch(doFetch, spec, signal));
    const resolvedCommit = await resolveCommit(doFetch, spec, ref, signal);
    const warnings = [];
    // A flat single-file cache from an earlier oc-bifrost (`<root>/<id>`) is
    // NEVER read as a snapshot. The layout version makes that structural; this
    // names it out loud so the old bytes are not silently forgotten.
    const legacyDir = path.join(opts.cacheRoot, githubCacheId(spec));
    if (isEntryFile(path.join(legacyDir, GITHUB_PLUGIN_FILENAME)) || isEntryFile(path.join(legacyDir, META_FILENAME))) {
        warnings.push(`a pre-snapshot single-file cache for this spec exists at ${safe(legacyDir)}; it cannot provide sibling files, ` +
            `so it is not used (delete it to reclaim the space)`);
    }
    const fetchedAt = (opts.now ?? (() => new Date()))().toISOString();
    const snapshot = await tryFetchSnapshot(spec, resolvedCommit, doFetch, signal, limits);
    let meta;
    let entryFile;
    let singleContent = "";
    if (snapshot.ok) {
        const entryBytes = snapshot.entryBytes;
        meta = {
            source: "github",
            owner: spec.owner,
            repo: spec.repo,
            ref,
            resolvedCommit,
            path: snapshot.entryPath,
            sha256: sha256BytesHex(entryBytes),
            bytes: entryBytes.byteLength,
            fetchedAt,
            layout: "snapshot",
            tarballSha256: snapshot.tarballSha256,
            tarballBytes: snapshot.tarballBytes,
            files: snapshot.files?.length ?? 0,
            treeBytes: snapshot.treeBytes,
        };
        entryFile = path.join(cacheDir, TREE_DIRNAME, ...snapshot.entryPath.split("/"));
    }
    else {
        const single = await fetchSingleFile(spec, ref, resolvedCommit, doFetch, signal);
        singleContent = single.content;
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
        };
        entryFile = path.join(cacheDir, GITHUB_PLUGIN_FILENAME);
    }
    const metaFile = path.join(cacheDir, META_FILENAME);
    const provisionModeValue = provisionMode(opts.provision, process.env);
    const provisionRowsWritten = [];
    let provisionRefused = [];
    try {
        // The boundary was validated before the fetch; re-validate now that the
        // entry exists, immediately before any write - the no-follow shrink of
        // the race window (see validateCachePath).
        validateCacheLevels(opts.cacheRoot, githubCacheLayoutRoot(opts.cacheRoot), cacheDir);
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        if (meta.layout === "snapshot") {
            materializeSnapshot(cacheDir, snapshot.files);
        }
        else {
            atomicWrite(entryFile, singleContent);
        }
        atomicWrite(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
        try {
            fs.chmodSync(entryFile, 0o600);
            fs.chmodSync(metaFile, 0o600);
            fs.chmodSync(cacheDir, 0o700);
        }
        catch {
            // best effort - platforms without POSIX mode bits ignore this
        }
    }
    catch (error) {
        // Roll back OUR artifacts only: a failed first-fetch must leave NO
        // partial tree, NO partial plugin file, and NO temp leftover. The entry
        // directory itself and anything the user put there are left alone.
        const treeDir = path.join(cacheDir, TREE_DIRNAME);
        for (const victim of [entryFile, metaFile, treeDir]) {
            try {
                fs.rmSync(victim, { recursive: true, force: true });
            }
            catch {
                // best effort
            }
        }
        try {
            for (const name of fs.readdirSync(cacheDir)) {
                if (name.startsWith(`${TREE_DIRNAME}.tmp-`) ||
                    name.startsWith(`${GITHUB_PLUGIN_FILENAME}.tmp-`) ||
                    name.startsWith(`${META_FILENAME}.tmp-`)) {
                    fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true });
                }
            }
        }
        catch {
            // best effort
        }
        fail(`could not write the github: cache at ${safe(cacheDir)}: ${safe(error.message, 400)}; ` +
            `partial state was removed — nothing will be executed from an incomplete cache`);
    }
    // PROVISIONING (spec §3) runs AFTER the write-rollback boundary on purpose:
    // the fetched cache is complete and verified the moment the meta exists.
    // Provisioning never participates in the first-fetch rollback - a
    // provisioning failure (a marker write that cannot land, an npm run that
    // misbehaves) must leave the full cache intact with a loud row, never
    // destroy a complete verified fetch. The tree's deps declared in its
    // manifest are junctioned from the host stores (zero network) or, per the
    // provision option, installed with npm - BEFORE the entry's first import,
    // with every outcome a loud mount-report row. Only fetched trees are
    // provisioned; local and preset entries never reach this path.
    if (provisionModeValue !== "off") {
        if (meta.layout !== "snapshot") {
            provisionRowsWritten.push("provision skipped: no package.json");
        }
        else {
            const treeDir = path.join(cacheDir, TREE_DIRNAME);
            const declared = readDeclaredDeps(treeDir);
            if (declared === null) {
                // Missing OR malformed manifest (M5): same loud row, still mounts.
                provisionRowsWritten.push("provision skipped: no package.json");
            }
            else {
                const report = await provisionTree(treeDir, {
                    hostStores: opts.hostStores ?? [defaultHostStoreRoot()],
                    npm: provisionModeValue === "npm",
                });
                provisionRowsWritten.push(...provisionRows(report, provisionModeValue));
                provisionRefused = report.refused;
                if (report.actions.length > 0) {
                    const markerFailure = writeMarker(treeDir, report);
                    if (markerFailure !== null)
                        provisionRowsWritten.push(`provision refused - ${markerFailure}`);
                }
            }
        }
    }
    // A provision refusal is a completed cache, not a write failure: the refusal
    // row is the report; under strict it aborts SETUP here (the caller's
    // warn-and-throw pattern), leaving the provisioned cache intact for a later
    // non-strict load.
    if (opts.strict === true && provisionRefused.length > 0)
        fail(provisionRow(provisionRefused[0], provisionModeValue));
    return {
        url: pathToFileURL(entryFile).href,
        cacheDir,
        meta,
        fetched: true,
        warnings,
        ...(provisionRowsWritten.length > 0 ? { provision: provisionRowsWritten } : {}),
    };
}
/**
 * Resolve a `github:` spec to an importable `file://` URL.
 *
 * Order: the cache-path boundary (root and entry must be absent or real
 * directories, realpath-contained - before ANY fetch or write) -> cache hit
 * (file types checked, provenance-checked, entry hash-verified, zero network)
 * -> consent gate (cold + unconsented refuses BEFORE any fetch) -> consented
 * first fetch (ref -> commit -> repository snapshot by commit, single-file
 * fallback with a loud note, atomic cache write with rollback).
 *
 * The cold path is serialized per cache entry: a concurrent caller for the
 * same spec awaits the SAME fetch/materialize promise instead of starting
 * its own pass, so no second pass can ever observe (and roll back) the
 * first pass's mid-write cache state.
 */
export async function resolveGithubPlugin(spec, opts) {
    const layoutRoot = githubCacheLayoutRoot(opts.cacheRoot);
    const cacheDir = path.join(layoutRoot, githubCacheId(spec));
    validateCacheLevels(opts.cacheRoot, layoutRoot, cacheDir);
    const pluginFile = path.join(cacheDir, GITHUB_PLUGIN_FILENAME);
    const metaFile = path.join(cacheDir, META_FILENAME);
    // A directory-named plugin.ts/meta.json is NOT a cached entry: it routes to
    // the cold path, whose write then fails and rolls back (fail closed) -
    // while real files and links route to the verify path, which refuses links.
    if (isEntryFile(pluginFile) || isEntryFile(metaFile))
        return loadVerified(spec, cacheDir, opts);
    if (opts.trusted !== true)
        fail(consentMessage(spec));
    const existing = inflightFetches.get(cacheDir);
    if (existing !== undefined)
        return existing;
    const promise = fetchAndRecord(spec, cacheDir, opts).finally(() => {
        // The map holds at most one promise per key - the one this call created -
        // so a settled fetch always clears its own entry.
        inflightFetches.delete(cacheDir);
    });
    inflightFetches.set(cacheDir, promise);
    return promise;
}
//# sourceMappingURL=github.js.map