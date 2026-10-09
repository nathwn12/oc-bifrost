/** The manager prefix named in the spec. `pnpm`/`bun` are aliases (see above). */
export type RegistryManager = "npm" | "pnpm" | "bun";
/** A parsed registry specifier. `bare` is the registry spec after prefix strip. */
export interface RegistrySpec {
    manager: RegistryManager;
    /** The bare registry spec, e.g. `oc-todo@^1.0.0` (prefix stripped). */
    bare: string;
    /** The package name, e.g. `oc-todo` or `@scope/pkg`. */
    name: string;
    /** The version/range/tag after `@`, absent when the spec names none. */
    range?: string;
}
/** Provenance record beside the installed tree. Field set is fixed. */
export interface RegistryMeta {
    source: "registry";
    bare: string;
    name: string;
    range: string;
    /** The installed version read from the installed package's own manifest. */
    version: string;
    /** The entry's path relative to the installed package directory. */
    entry: string;
    /** Which spawned command performed the install (the alias-honesty record). */
    installedBy: string;
    fetchedAt: string;
}
export interface RegistryResolveOptions {
    /** Cache root: the package installs at `<cacheRoot>/<safe-id>/`. */
    cacheRoot: string;
    /**
     * Injectable installer for tests; receives the cache directory and the bare
     * spec and returns the `installedBy` label for the mount note. Defaults to
     * the spawned bun-then-npm installer. Hermetic suites inject a fake that
     * materializes a fixture package and returns a canned label.
     */
    install?: (dir: string, bare: string) => string | Promise<string>;
    /** Injectable clock for tests; defaults to `new Date`. */
    now?: () => Date;
}
export interface RegistryResolveResult {
    /** `file://` URL of the verified installed entry module - the import target. */
    url: string;
    cacheDir: string;
    meta: RegistryMeta;
    /** True when this call installed the bytes; false on a verified cache hit. */
    fetched: boolean;
    manager: RegistryManager;
}
/**
 * Parse a registry specifier: an optional `npm:`/`pnpm:`/`bun:` prefix plus a
 * bare `name[@range]` / `@scope/name[@range]`. Throws loudly on any malformed
 * form - a refusal is a feature, never a guess.
 */
export declare function parseRegistrySpecifier(spec: string): RegistrySpec;
/**
 * True when the string is a bare registry specifier (no scheme prefix, no
 * path shape). Pure, exported so `resolveSpec` can branch without throwing.
 */
export declare function isBareRegistrySpecifier(spec: string): boolean;
/**
 * Deterministic, filesystem-safe cache directory name for the NORMALIZED bare
 * spec (mirrors `githubCacheId`: readable prefix plus a sha256-derived suffix
 * so sanitizer collisions can never share a directory).
 */
export declare function registryCacheId(bare: string): string;
/** The shared bifrost-owned cache root for installed registry plugins. */
export declare function registryCacheRoot(homeDirectory?: string, env?: NodeJS.ProcessEnv): string;
/**
 * Resolve the installed package's entry file: the manifest's declared entry
 * (`exports`/`module`/`main`) when it names a real file inside the package,
 * else the first conventional entry name. A declared entry that escapes the
 * package is refused, never read. Throws loudly when nothing resolves - the
 * caller must verify the entry exists before import.
 */
export declare function resolveRegistryEntry(packageDir: string): string;
/**
 * The default installer: spawn `bun add --exact <bare>` first (the host runs
 * on bun), falling back to `npm install --no-save --legacy-peer-deps <bare>`.
 * Returns the `installedBy` label for the mount note. Throws loudly when
 * neither manager is available or both fail.
 *
 * SECURITY - no user-controlled text may ever cross a shell boundary. Every
 * attempt below is executed DIRECTLY (`spawnSync` with `shell: false` and an
 * argv array), never through `cmd.exe /c` or any other shell: `bun` is a real
 * `.exe` that needs no shell, and the npm fallback runs npm's own JS entry
 * (`npm-cli.js`) through the current JS runtime (`process.execPath`) instead
 * of the `npm.cmd` shim. The shim previously ran as
 * `cmd.exe /d /c npm.cmd <args>`, so a specifier such as `pkg@1&...` was parsed
 * by `cmd.exe` as a SECOND command - arbitrary command execution as the user.
 * With direct exec the specifier travels as one argv element: metacharacters
 * reach the manager as data, never as syntax. The forbidden-character belt in
 * `parseRegistrySpecifier` / `resolveRegistryPlugin` is the second layer, not
 * the first.
 */
export declare function defaultRegistryInstall(dir: string, bare: string): string;
/**
 * Install (cold) or load (warm, verified) a registry plugin. Cache-first: a
 * warm cache whose provenance matches this exact bare spec and whose entry
 * file still exists loads with zero spawns and needs no network.
 */
export declare function resolveRegistryPlugin(spec: RegistrySpec, opts: RegistryResolveOptions): Promise<RegistryResolveResult>;
/**
 * The mount-report note. ALWAYS names the installed version, the entry, and
 * which spawned command performed the install - and, for `pnpm:`/`bun:`,
 * says plainly that the prefix is an alias (never implying a real pnpm/bun
 * install happened), per the README honesty rule.
 */
export declare function registryMountNote(result: RegistryResolveResult): string;
//# sourceMappingURL=registry.d.ts.map