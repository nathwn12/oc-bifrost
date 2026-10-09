/** A parsed `github:` specifier. `ref`/`path` are absent when the spec omits them. */
export interface GithubSpec {
    owner: string;
    repo: string;
    ref?: string;
    path?: string;
}
/** Provenance record. Field set is fixed: see the package security notes. */
export interface GithubMeta {
    source: string;
    owner: string;
    repo: string;
    ref: string;
    /** The commit sha the ref resolved to at first fetch (immutable identity). */
    resolvedCommit: string;
    /** The entry file's repo-relative path (snapshot) or the probed path (single-file). */
    path: string;
    /** sha256 of the entry FILE's bytes — verified on every later load. */
    sha256: string;
    bytes: number;
    fetchedAt: string;
    /**
     * How the entry was materialized:
     *   - "snapshot"    — the whole repository tree at the resolved commit; the
     *                     entry is imported from its real place inside it, so
     *                     sibling files exist.
     *   - "single-file" — one file only; siblings are NOT available and a plugin
     *                     that reads them by relative path is inert.
     */
    layout: "snapshot" | "single-file";
    /** sha256 of the compressed tarball (snapshot layout only). */
    tarballSha256?: string;
    /** Compressed tarball size in bytes (snapshot layout only). */
    tarballBytes?: number;
    /** Regular files materialized (snapshot layout only). */
    files?: number;
    /** Total regular-file bytes materialized (snapshot layout only). */
    treeBytes?: number;
    /** Why the snapshot was not used, sanitized (single-file layout only). */
    snapshotFallback?: string;
}
/**
 * Hard caps on the snapshot. Named, documented, and enforced before anything
 * is cached. A breach never truncates: it downgrades to the single-file route
 * with a loud mount note, or refuses when the offending input is hostile.
 */
export interface GithubSnapshotLimits {
    /** Compressed tarball download cap (stop reading mid-body past it). */
    tarballBytes: number;
    /** Uncompressed archive cap (headers + padding included). */
    treeBytes: number;
    /** Regular-file count cap. */
    files: number;
}
export interface GithubResolveOptions {
    /** Cache root: the plugin is cached at `<cacheRoot>/v2/<safe-id>/`. */
    cacheRoot: string;
    /**
     * Explicit informed consent to fetch + execute a plugin whose cache is cold
     * (`options.trustRemote: true`, or `OC_BIFROST_TRUST=github`). A cold cache
     * without it is refused BEFORE anything is fetched. A warm cache needs no
     * consent.
     */
    trusted?: boolean;
    /**
     * How a fetched snapshot's declared dependencies are provided before its
     * entry is imported: `"host"` (the default) junctions each dependency from
     * the host stores (zero network); `"npm"` adds an `npm install --no-save`
     * fallback for packages the stores lack; `"off"` keeps 1.3.x behavior
     * (nothing provisioned, no provision rows). An explicit value wins over the
     * `OC_BIFROST_PROVISION` environment variable; an invalid value is a loud
     * refusal.
     */
    provision?: ProvisionMode;
    /**
     * True turns a provisioning REFUSAL into a thrown refusal (the setup-abort
     * pattern; false records the refusal as a loud row and the mount proceeds).
     */
    strict?: boolean;
    /**
     * Host-store roots probed in order for each declared dependency. Defaults to
     * the shared OpenCode npm cache root (`<XDG_CACHE_HOME or ~/.cache>/
     * opencode/npm`); tests inject temp stores.
     */
    hostStores?: readonly string[];
    /** Injectable fetch for tests; defaults to `globalThis.fetch`. */
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    /** Injectable clock for tests; defaults to `new Date`. */
    now?: () => Date;
    /** Snapshot cap overrides (tests; unusually large repositories). */
    limits?: Partial<GithubSnapshotLimits>;
}
export interface GithubResolveResult {
    /** `file://` URL of the verified cached entry module — the import target. */
    url: string;
    cacheDir: string;
    meta: GithubMeta;
    /** True when this call downloaded the bytes; false on a verified cache hit. */
    fetched: boolean;
    /** Load-time warnings that belong in the mount note (never silent). */
    warnings?: string[];
    /**
     * Provision rows for the mount note (`provision <pkg> - host:<path>`,
     * `npm install --no-save` - one per npm run, `provision refused <pkg> - <reason>`,
     * `provision skipped: no package.json`). Present only when provisioning
     * actually ran this cycle (a first fetch, or a warm re-provision on marker
     * drift/staleness) and is not `"off"`.
     */
    provision?: string[];
}
/** Structural subset of a streaming response body, for the incremental size cap. */
export interface BodyReaderLike {
    read(): Promise<{
        done: boolean;
        value?: Uint8Array;
    }>;
    cancel(): Promise<void>;
}
export interface BodyLike {
    getReader(): BodyReaderLike;
}
/** Structural subset of a fetch Response that this module consumes. */
export interface FetchResponseLike {
    ok: boolean;
    status: number;
    /** Final URL after redirects, when the implementation exposes it. */
    url?: string;
    /** Streaming body when the implementation exposes one; the size caps consume it incrementally. */
    body?: BodyLike | null;
    /** Binary body fallback for the tarball when no streaming body is exposed. */
    arrayBuffer?(): Promise<ArrayBuffer>;
    text(): Promise<string>;
    json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "error";
}) => Promise<FetchResponseLike>;
/**
 * Caps on the repository snapshot. Sized for plugin-bearing repositories
 * (the real `obra/superpowers@v6.4.2` snapshot is 641 KB compressed / 2.1 MB
 * uncompressed / 229 files) while still bounding untrusted input. A breach
 * refuses the SNAPSHOT and falls back to the single-file route, loudly — it
 * never truncates, and never happens silently.
 */
export declare const MAX_TARBALL_BYTES: number;
export declare const MAX_TREE_BYTES: number;
export declare const MAX_TREE_FILES = 5000;
/**
 * Neutralise control characters and cap the length of ANY untrusted string
 * before it reaches a message: a loud refusal must never be a terminal or
 * log hazard. Control characters are escaped (`\u0000`-style), never raw.
 */
export declare function safe(value: string, max?: number): string;
/** Canonical display form used in every message about this spec. */
export declare function githubLabel(spec: GithubSpec): string;
/**
 * Parity with `scripts/vendor-lib.mjs` `isValidRef`: a ref is safe to
 * interpolate into a URL. The charset excludes `%`, control characters, and
 * `..`; the only separator it may contain is the legitimate `/` (branch
 * names like `feature/next`), which is why the ref is NOT percent-encoded
 * when building raw URLs — encoding it would break branch refs, and the
 * strict charset is the control that makes raw use safe.
 */
export declare function isValidRef(ref: string): boolean;
/** In-repo paths tried, in order, when the spec omits `#<path>`. */
export declare function candidatePaths(spec: GithubSpec): readonly string[];
/** sha256 hex of the utf8 bytes — the same digest the provenance record pins. */
export declare function sha256Hex(content: string): string;
/** Parse and validate a `github:` specifier. Throws loudly on any malformed form. */
export declare function parseGithubSpec(spec: string): GithubSpec;
/**
 * Deterministic, collision-resistant cache directory name for the
 * NORMALIZED spec. Derived ONLY from the spec (owner/repo and the spec's own
 * ref/path, with `default` standing in for omitted parts) so a cache hit
 * needs zero network. A sha256-derived suffix keys the RAW parts, so two
 * specs whose sanitized readable forms coincide can never share a directory.
 */
export declare function githubCacheId(spec: GithubSpec): string;
/**
 * The STABLE prefix of that spec's cache directory name: `owner--repo--`,
 * independent of the resolved ref, path, and digest. A tree's cli.json entry
 * URL always contains `/<family>` (the cache dir name begins with it), so a
 * re-provision at a new resolved ref - a new cache dir and a new URL - is
 * still recognizable as the SAME plugin and its previous entry can be pruned.
 */
export declare function githubCacheRepoPrefix(spec: Pick<GithubSpec, "owner" | "repo">): string;
/**
 * The stable, ref-independent identity of the plugin a spec names: a sha256
 * over owner/repo/path. The cache directory name is ref-bearing (it changes
 * with every resolved commit), so it cannot serve as identity; this key is
 * recorded in the managed cli.json entry marker and claimed exactly.
 */
export declare function githubPluginKey(spec: Pick<GithubSpec, "owner" | "repo" | "path">): string;
/**
 * The layout-versioned cache root. Directory versioning is what keeps a flat
 * single-file cache written by an earlier oc-bifrost (`<root>/<id>`) from ever
 * being read as if it were a materialized snapshot: the new code only looks
 * under `<root>/v2/`, so the old entry is cold, re-fetched (with the same
 * one-time consent), and reported in the mount note.
 */
export declare function githubCacheLayoutRoot(cacheRoot: string): string;
/**
 * Fail-closed guard: after resolving the cache path, assert it stays INSIDE
 * the cache root. Exported pure for tests.
 */
export declare function assertInsideRoot(cacheRoot: string, dir: string): void;
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
export declare function validateCachePath(cacheRoot: string, cacheDir: string): void;
/**
 * Whether first-use remote fetching is consented. An explicit option wins:
 * `trustRemote: false` disables the fetch even when the environment asks for
 * it (mirrors freshnessEnabled). When the option is omitted,
 * `OC_BIFROST_TRUST === "github"` consents.
 */
export declare function remoteTrustEnabled(option: boolean | undefined, env?: NodeJS.ProcessEnv): boolean;
/** How a fetched tree's declared dependencies are provided (spec §3). */
export type ProvisionMode = "host" | "npm" | "off";
/**
 * The provisioning mode. An explicit option wins over the env var; omitted,
 * `OC_BIFROST_PROVISION` decides; unset, the default is `"host"`. Any other
 * value is a loud refusal (a typo must never silently disable provisioning).
 * Pure.
 */
export declare function provisionMode(option: ProvisionMode | undefined, env?: NodeJS.ProcessEnv): ProvisionMode;
/**
 * The default host-store root: the shared OpenCode npm cache - the `npm`
 * SIBLING of the bridge's own `oc-bifrost` cache dir under the same
 * `<XDG_CACHE_HOME or ~/.cache>/opencode` base `githubCacheRoot` derives from
 * (controller ruling R-2; the `oc-bifrost` dir itself is a known-wrong guess).
 * Live layout: `<root>/<name>@<version>/<cacheId>/node_modules/<name>`.
 */
export declare function defaultHostStoreRoot(homeDirectory?: string, env?: NodeJS.ProcessEnv): string;
/**
 * The informed-consent refusal for a cold cache. Names exactly what is about
 * to be fetched, that it will execute with the host process's full user
 * rights, and what provisioning the SAME opt-in also authorizes - before
 * anything is fetched.
 */
export declare function consentMessage(spec: GithubSpec): string;
/**
 * The mount-report note. ALWAYS names the resolved commit, the digest, and
 * the fact that the plugin executes with the host process's full user
 * rights — so the consent (given once at first fetch) stays informed on
 * every later load. When the single-file fallback was used (or a warm cache
 * holds one), it says so loudly: sibling files are NOT available and a plugin
 * that reads them by relative path is inert.
 */
export declare function mountNote(meta: GithubMeta, fetched: boolean): string;
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
export declare function resolveGithubPlugin(spec: GithubSpec, opts: GithubResolveOptions): Promise<GithubResolveResult>;
//# sourceMappingURL=github.d.ts.map