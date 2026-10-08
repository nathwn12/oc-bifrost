/**
 * registry: - mount a plugin FROM THE NPM REGISTRY, installed into a
 * bifrost-owned cache directory.
 *
 * Specifier forms (verified facts: `src/index.ts:110-112` said "npm support
 * is not built yet" and `src/index.ts:114-139` (`resolveSpec`) threw
 * `unsupportedSpecifierMessage` (`:83-88`) for everything outside
 * `preset:`/`github:`/paths; `README.md:56,98` documented the refusal):
 *
 *   - `oc-todo`, `oc-todo@0.4.0`, `pkg@^1.0.0`, `pkg@latest`,
 *     `@scope/pkg@1.2.3` - a bare registry specifier.
 *   - `npm:<spec>`, `pnpm:<spec>`, `bun:<spec>` - the prefix is stripped and
 *     the remainder is treated as the bare spec above.
 *
 * The contract:
 *
 *   - THE HOST WILL NOT COVER THIS: its installer drops `npm:` alias specs
 *     (`npm.ts:73`) and ships no pnpm/bun installer - so bifrost installs the
 *     package itself by SPAWNING an available package manager.
 *   - `bun add --exact <bare>` first (the host runs on bun), with an
 *     `npm install --no-save --legacy-peer-deps <bare>` fallback. Zero
 *     runtime dependencies (`package.json:57`): node builtins only, the
 *     manager is spawned, never imported.
 *   - `pnpm:` and `bun:` are ALIASES that install through the SAME spawned
 *     manager. The mount note says so plainly (never implying a real
 *     pnpm/bun install happened) - the `README.md:143-151` honesty rule.
 *   - CACHE FIRST, mirroring the github cache-root convention
 *     (`src/index.ts:53-59`): `<cacheRoot>/registry/<safe-id>/`, where the
 *     default root is `<XDG_CACHE_HOME>/opencode/oc-bifrost/registry/`
 *     (`~/.cache/...` by default). A warm cache loads with zero spawns.
 *   - VERIFY BEFORE IMPORT: the installed entry must exist or the resolve
 *     fails loudly ("Fail loud, never silent"). Nothing is dropped silently.
 *   - The entry is resolved via the installed package's own `package.json`
 *     (`exports`/`module`/`main`), then classified by the existing
 *     `src/discover.ts` - V1 registry packages bridge, V2 ones run natively
 *     (`src/index.ts:285-301`).
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { assertInsideRoot, safe, validateCachePath } from "./github.js"

/** The manager prefix named in the spec. `pnpm`/`bun` are aliases (see above). */
export type RegistryManager = "npm" | "pnpm" | "bun"

/** A parsed registry specifier. `bare` is the registry spec after prefix strip. */
export interface RegistrySpec {
  manager: RegistryManager
  /** The bare registry spec, e.g. `oc-todo@^1.0.0` (prefix stripped). */
  bare: string
  /** The package name, e.g. `oc-todo` or `@scope/pkg`. */
  name: string
  /** The version/range/tag after `@`, absent when the spec names none. */
  range?: string
}

/** Provenance record beside the installed tree. Field set is fixed. */
export interface RegistryMeta {
  source: "registry"
  bare: string
  name: string
  range: string
  /** The installed version read from the installed package's own manifest. */
  version: string
  /** The entry's path relative to the installed package directory. */
  entry: string
  /** Which spawned command performed the install (the alias-honesty record). */
  installedBy: string
  fetchedAt: string
}

export interface RegistryResolveOptions {
  /** Cache root: the package installs at `<cacheRoot>/<safe-id>/`. */
  cacheRoot: string
  /**
   * Injectable installer for tests; receives the cache directory and the bare
   * spec and returns the `installedBy` label for the mount note. Defaults to
   * the spawned bun-then-npm installer. Hermetic suites inject a fake that
   * materializes a fixture package and returns a canned label.
   */
  install?: (dir: string, bare: string) => string | Promise<string>
  /** Injectable clock for tests; defaults to `new Date`. */
  now?: () => Date
}

export interface RegistryResolveResult {
  /** `file://` URL of the verified installed entry module - the import target. */
  url: string
  cacheDir: string
  meta: RegistryMeta
  /** True when this call installed the bytes; false on a verified cache hit. */
  fetched: boolean
  manager: RegistryManager
}

/** Every refusal carries the package prefix, like the rest of src/. */
function fail(message: string): never {
  throw new Error(`[oc-bifrost] ${message}`)
}

const MANAGER_PREFIXES = ["npm:", "pnpm:", "bun:"] as const

const PACKAGE_NAME_PATTERN = /^(@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+|[A-Za-z0-9._~-]+)$/
/**
 * A version, range, or tag. The charset is the npm range syntax that can
 * legally appear (`^ ~ * > < =`, spaces, hyphens) plus alphanumerics - and
 * NOTHING that is shell syntax: `&` and `|` are refused here (they used to be
 * accepted, letting `pkg@1&...` reach a `cmd.exe /c` boundary as a second
 * command). Anything outside this set fails the range check below.
 */
const RANGE_PATTERN = /^[A-Za-z0-9._~^+<>=*x -]+$/
/**
 * Belt over the whole bare spec: characters that can NEVER appear in a valid
 * registry spec (`& | ; ` `` ` `` `$ " ' ( ) { } [ ] \` plus newline, CR, NUL,
 * tab). Any one of them is a loud, named refusal - a refusal is a feature -
 * raised BEFORE any installer runs, so a hostile spec can never reach a spawn
 * even from a caller that skipped the parser. The shell removal in
 * `defaultRegistryInstall` is what makes specs safe; this belt is the second
 * layer, deliberately narrow so legal range syntax (`^ ~ * > < =` space) is
 * never blocked.
 */
const FORBIDDEN_SPECIFIER_CHARS = /[&|;`$"\'(){}\[\]\\\n\r\t\0]/

/** The named belt refusal for a bare spec carrying shell metacharacters. */
function assertNoShellMetacharacters(bare: string, spec: string): void {
  const hit = bare.match(FORBIDDEN_SPECIFIER_CHARS)
  if (hit !== null) {
    fail(
      `refusing to install: invalid registry specifier "${safe(spec)}": ` +
      `contains a forbidden shell metacharacter (${JSON.stringify(hit[0])}) ` +
      `that can never appear in a valid registry spec; nothing was installed`,
    )
  }
}

/**
 * Parse a registry specifier: an optional `npm:`/`pnpm:`/`bun:` prefix plus a
 * bare `name[@range]` / `@scope/name[@range]`. Throws loudly on any malformed
 * form - a refusal is a feature, never a guess.
 */
export function parseRegistrySpecifier(spec: string): RegistrySpec {
  let manager: RegistryManager = "npm"
  let bare = spec
  for (const prefix of MANAGER_PREFIXES) {
    if (spec.startsWith(prefix)) {
      manager = prefix.slice(0, -1) as RegistryManager
      bare = spec.slice(prefix.length)
      break
    }
  }
  if (bare === "") {
    fail(`invalid registry specifier "${safe(spec)}": expected "name[@version|range|tag]" or "@scope/name[@version|range|tag]" after the prefix`)
  }
  // The belt runs before every other shape check so a hostile spec gets the
  // NAMED shell-metacharacter refusal, never a generic shape message.
  assertNoShellMetacharacters(bare, spec)
  // A space is legal npm range syntax (`pkg@>=1.0.0 <2.0.0`), so only the
  // URL/path separators and scheme chars are refused here; a stray space in
  // the NAME still fails the package-name check below, and control whitespace
  // (newline, CR, NUL, tab) already failed the belt above.
  if (bare.includes(":") || bare.includes("?") || bare.includes("#")) {
    fail(`invalid registry specifier "${safe(spec)}": names carry no ":/?#" characters`)
  }
  // Split name from range at the LAST "@" past index 0 (a leading "@" opens a scope).
  const at = bare.lastIndexOf("@")
  const name = at <= 0 ? bare : bare.slice(0, at)
  const range = at <= 0 ? undefined : bare.slice(at + 1)
  if (!PACKAGE_NAME_PATTERN.test(name) || name.length > 214) {
    fail(`invalid registry specifier "${safe(spec)}": "${safe(name)}" is not a package name ("name" or "@scope/name")`)
  }
  if (range !== undefined) {
    if (range === "" || range.length > 100 || !RANGE_PATTERN.test(range) || range.includes("..")) {
      fail(`invalid registry specifier "${safe(spec)}": "${safe(range)}" is not a version, range, or tag`)
    }
  }
  return range === undefined ? { manager, bare, name } : { manager, bare, name, range }
}

/**
 * True when the string is a bare registry specifier (no scheme prefix, no
 * path shape). Pure, exported so `resolveSpec` can branch without throwing.
 */
export function isBareRegistrySpecifier(spec: string): boolean {
  try {
    const parsed = parseRegistrySpecifier(spec)
    // A prefixed form is never "bare"; a spec carrying another scheme's ":"
    // is rejected by the parser above, so reaching here with the default
    // manager and an unchanged bare means a genuine bare name.
    return parsed.manager === "npm" && parsed.bare === spec
  } catch {
    return false
  }
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "")
  return (cleaned === "" ? "x" : cleaned).slice(0, 64)
}

/**
 * Deterministic, filesystem-safe cache directory name for the NORMALIZED bare
 * spec (mirrors `githubCacheId`: readable prefix plus a sha256-derived suffix
 * so sanitizer collisions can never share a directory).
 */
export function registryCacheId(bare: string): string {
  const readable = sanitizeSegment(bare).slice(0, 96)
  const digest = createHash("sha256").update(bare, "utf8").digest("hex").slice(0, 16)
  return `${readable}-${digest}`
}

/** The shared bifrost-owned cache root for installed registry plugins. */
export function registryCacheRoot(
  homeDirectory = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const cacheHome = env.XDG_CACHE_HOME || path.join(homeDirectory, ".cache")
  return path.join(cacheHome, "opencode", "oc-bifrost", "registry")
}

const META_FILENAME = "meta.json"

function stripDotSlash(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p
}

/** The entry path declared by a manifest's `exports`/`module`/`main`, if any. */
function manifestEntry(record: Record<string, unknown>): string | undefined {
  const exportsValue = record.exports
  if (typeof exportsValue === "string") return stripDotSlash(exportsValue)
  if (exportsValue !== null && typeof exportsValue === "object") {
    const exp = exportsValue as Record<string, unknown>
    const dot = exp["."]
    if (typeof dot === "string") return stripDotSlash(dot)
    if (dot !== null && typeof dot === "object") {
      const d = dot as Record<string, unknown>
      for (const key of ["import", "default", "require"]) {
        const value = d[key]
        if (typeof value === "string") return stripDotSlash(value)
      }
    }
  }
  if (typeof record.module === "string") return stripDotSlash(record.module)
  if (typeof record.main === "string") return stripDotSlash(record.main)
  return undefined
}

/**
 * Resolve the installed package's entry file: the manifest's declared entry
 * (`exports`/`module`/`main`) when it names a real file inside the package,
 * else the first conventional entry name. A declared entry that escapes the
 * package is refused, never read. Throws loudly when nothing resolves - the
 * caller must verify the entry exists before import.
 */
export function resolveRegistryEntry(packageDir: string): string {
  const manifestPath = path.join(packageDir, "package.json")
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, "utf8")
  } catch (error) {
    fail(`could not install the registry plugin at ${safe(packageDir)}: no readable package.json (${safe((error as Error).message)}); delete the cache directory to retry`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw as string)
  } catch (error) {
    fail(`could not install the registry plugin at ${safe(packageDir)}: its package.json is not valid JSON (${safe((error as Error).message)}); delete the cache directory to retry`)
  }
  const candidates: string[] = []
  if (parsed !== null && typeof parsed === "object") {
    const entry = manifestEntry(parsed as Record<string, unknown>)
    if (entry !== undefined) candidates.push(entry)
  }
  candidates.push("index.mjs", "index.js", "index.cjs", "index.ts", "plugin.mjs", "plugin.js")
  for (const candidate of candidates) {
    const resolved = path.resolve(packageDir, candidate)
    const rel = path.relative(packageDir, resolved)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(resolved)
    } catch {
      continue
    }
    if (stats.isFile()) return resolved
  }
  fail(`could not install the registry plugin at ${safe(packageDir)}: its package.json names no importable entry; delete the cache directory to retry`)
}

/** Read + shape-check the provenance record. Any gap is a loud refusal. */
function readProvenance(cacheDir: string): RegistryMeta {
  const missing =
    `the cached copy at ${safe(cacheDir)} has no readable provenance record (meta.json). ` +
    `Never loading unverified bytes; delete the cache directory to re-install`
  let raw: string
  try {
    raw = fs.readFileSync(path.join(cacheDir, META_FILENAME), "utf8")
  } catch (error) {
    fail(`${missing} (${safe((error as Error).message)})`)
  }
  let parsed: Partial<RegistryMeta>
  try {
    parsed = JSON.parse(raw as string) as Partial<RegistryMeta>
  } catch (error) {
    fail(`${missing} (invalid JSON: ${safe((error as Error).message)})`)
  }
  const complete =
    parsed.source === "registry" &&
    typeof parsed.bare === "string" && parsed.bare !== "" &&
    typeof parsed.name === "string" && parsed.name !== "" &&
    typeof parsed.range === "string" &&
    typeof parsed.version === "string" && parsed.version !== "" &&
    typeof parsed.entry === "string" && parsed.entry !== "" &&
    typeof parsed.installedBy === "string" && parsed.installedBy !== "" &&
    typeof parsed.fetchedAt === "string"
  if (!complete) {
    fail(`${missing} (the record it holds is incomplete or damaged; delete the cache directory to re-install)`)
  }
  return parsed as RegistryMeta
}

/** A stored relative entry must never be trusted straight into `path.join`. */
function assertSafeRelativePath(relative: string): void {
  if (relative === "" || relative.startsWith("/") || relative.includes("\\") || relative.includes("\0")) {
    fail(`refusing to load: the recorded entry path (${safe(relative)}) is not a plain relative path; delete the cache directory to re-install`)
  }
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes(":")) {
      fail(`refusing to load: the recorded entry path (${safe(relative)}) contains an unsafe segment; delete the cache directory to re-install`)
    }
  }
}

/**
 * Locate npm's own JS entry (`npm-cli.js`) without touching the `npm.cmd`
 * shim: the shim is a `.cmd` file, so it can only run via a shell - the very
 * boundary this installer must never cross. Probes the runtime's own layout
 * first (`npm_execpath` when running under npm, then beside `process.execPath`
 * in both the Windows and posix install layouts). Returns `undefined` when no
 * entry is found, and the caller then skips the npm fallback loudly instead
 * of reaching for a shell.
 */
function npmCliEntry(): string | undefined {
  const candidates: string[] = []
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath)
  const exeDir = path.dirname(process.execPath)
  candidates.push(
    path.join(exeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(exeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  )
  for (const candidate of candidates) {
    try {
      if (fs.lstatSync(candidate).isFile()) return candidate
    } catch {
      // Not here - try the next candidate.
    }
  }
  return undefined
}

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
export function defaultRegistryInstall(dir: string, bare: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const stub = path.join(dir, "package.json")
  try {
    fs.lstatSync(stub)
  } catch {
    fs.writeFileSync(stub, JSON.stringify({ name: "oc-bifrost-registry-cache", private: true }, null, 2))
  }
  const attempts: Array<{ label: string; command: string; args: string[] }> = [
    { label: "bun (`bun add --exact`)", command: "bun", args: ["add", "--exact", bare] },
  ]
  // On Windows the `npm` name resolves only to the `npm.cmd` shim, which
  // cannot run without a shell - so there the fallback exists ONLY as the
  // shell-free `npm-cli.js` invocation. Elsewhere `npm` is directly
  // executable (no shell involved), with `npm-cli.js` preferred when found.
  const cli = npmCliEntry()
  if (cli !== undefined) {
    attempts.push({
      label: "npm (`npm install --no-save --legacy-peer-deps` via npm-cli.js)",
      command: process.execPath,
      args: [cli, "install", "--no-save", "--legacy-peer-deps", bare],
    })
  } else if (process.platform !== "win32") {
    attempts.push({ label: "npm (`npm install --no-save --legacy-peer-deps`)", command: "npm", args: ["install", "--no-save", "--legacy-peer-deps", bare] })
  }
  const failures: string[] = []
  if (attempts.length === 1 && process.platform === "win32") {
    failures.push("npm fallback unavailable: no shell-free npm entry (npm-cli.js) found, and the npm.cmd shim is never run through a shell")
  }
  for (const attempt of attempts) {
    let status: number | null = null
    try {
      const result = spawnSync(attempt.command, attempt.args, {
        encoding: "utf8",
        windowsHide: true,
        cwd: dir,
        shell: false,
      })
      status = result.status
      const spawnError = (result as { error?: Error }).error
      if (spawnError !== undefined) {
        failures.push(`${attempt.label}: ${safe(spawnError.message, 200)}`)
        continue
      }
    } catch (error) {
      failures.push(`${attempt.label}: ${safe((error as Error).message, 200)}`)
      continue
    }
    if (status === 0) return attempt.label
    failures.push(`${attempt.label}: exited ${String(status)}`)
  }
  fail(`could not install "${safe(bare)}" from the npm registry (${failures.join("; ")}). Nothing was mounted; delete the cache directory to retry`)
}

/**
 * Install (cold) or load (warm, verified) a registry plugin. Cache-first: a
 * warm cache whose provenance matches this exact bare spec and whose entry
 * file still exists loads with zero spawns and needs no network.
 */
export async function resolveRegistryPlugin(
  spec: RegistrySpec,
  opts: RegistryResolveOptions,
): Promise<RegistryResolveResult> {
  // Belt BEFORE anything else - including the cache lookup and, crucially,
  // the injected/real installer: a hostile bare handed to this function
  // directly (skipping the parser) is refused here, so the installer is never
  // called and no specifier text ever reaches a spawn.
  assertNoShellMetacharacters(spec.bare, spec.bare)
  const cacheDir = path.join(opts.cacheRoot, registryCacheId(spec.bare))
  assertInsideRoot(opts.cacheRoot, cacheDir)
  validateCachePath(opts.cacheRoot, cacheDir)

  // Warm path: provenance for THIS exact bare spec plus a real entry file.
  // Absent provenance means a cold cache (install below). Present-but-unreadable
  // provenance refuses loudly via readProvenance - never a silent re-install.
  let warm: RegistryMeta | null = null
  let hasProvenance = false
  try {
    fs.lstatSync(path.join(cacheDir, META_FILENAME))
    hasProvenance = true
  } catch {
    hasProvenance = false
  }
  if (hasProvenance) warm = readProvenance(cacheDir)
  if (warm !== null) {
    if (warm.bare !== spec.bare) {
      fail(
        `refusing to load the cached copy at ${safe(cacheDir)}: it records "${safe(warm.bare)}", not "${safe(spec.bare)}". ` +
        `A cached artifact is never silently replaced; delete the cache directory to re-install`,
      )
    }
    assertSafeRelativePath(warm.entry)
    const packageDir = path.join(cacheDir, "node_modules", ...warm.name.split("/"))
    const entryFile = path.resolve(packageDir, warm.entry)
    if (path.relative(packageDir, entryFile) === "" || path.relative(packageDir, entryFile).startsWith("..")) {
      fail(`refusing to load: the recorded entry path (${safe(warm.entry)}) escapes the installed package; delete the cache directory to re-install`)
    }
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(entryFile)
    } catch (error) {
      fail(`refusing to load: the cached entry file at ${safe(entryFile)} is unreadable (${safe((error as Error).message)}); delete the cache directory to re-install`)
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      fail(`refusing to load: the cached entry file at ${safe(entryFile)} is not a regular file; delete the cache directory to re-install`)
    }
    return { url: pathToFileURL(entryFile).href, cacheDir, meta: warm, fetched: false, manager: spec.manager }
  }

  // Cold path: spawn the install, then verify the entry exists before import.
  const install = opts.install ?? defaultRegistryInstall
  let installedBy: string
  try {
    installedBy = await install(cacheDir, spec.bare)
  } catch (error) {
    fail(`could not install "${safe(spec.bare)}" from the npm registry (${safe((error as Error).message, 300)}). Nothing was mounted; delete the cache directory to retry`)
  }
  const packageDir = path.join(cacheDir, "node_modules", ...spec.name.split("/"))
  let entryFile: string
  try {
    entryFile = resolveRegistryEntry(packageDir)
  } catch (error) {
    fail(`could not install "${safe(spec.bare)}" from the npm registry (${safe((error as Error).message, 300)}). Nothing was mounted; delete the cache directory to retry`)
  }
  let version = "unknown"
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as Record<string, unknown>
    if (typeof manifest.version === "string" && manifest.version !== "") version = manifest.version
  } catch {
    // version stays "unknown": the entry above already proved the install.
  }
  const meta: RegistryMeta = {
    source: "registry",
    bare: spec.bare,
    name: spec.name,
    range: spec.range ?? "",
    version,
    entry: path.relative(packageDir, entryFile as string),
    installedBy: installedBy as string,
    fetchedAt: (opts.now ?? (() => new Date()))().toISOString(),
  }
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    const tmp = path.join(cacheDir, `.meta.json.${process.pid}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, path.join(cacheDir, META_FILENAME))
  } catch (error) {
    fail(`could not write the registry cache at ${safe(cacheDir)} (${safe((error as Error).message)}); delete the cache directory to retry`)
  }
  return { url: pathToFileURL(entryFile as string).href, cacheDir, meta, fetched: true, manager: spec.manager }
}

/**
 * The mount-report note. ALWAYS names the installed version, the entry, and
 * which spawned command performed the install - and, for `pnpm:`/`bun:`,
 * says plainly that the prefix is an alias (never implying a real pnpm/bun
 * install happened), per the README honesty rule.
 */
export function registryMountNote(result: RegistryResolveResult): string {
  const meta = result.meta
  const what = `${safe(meta.name)}@${safe(meta.version)} (requested "${safe(meta.bare)}", entry ${safe(meta.entry)}; installed with ${safe(meta.installedBy)}${result.fetched ? "" : `, loaded from cache; fetched ${safe(meta.fetchedAt)}`})`
  const alias =
    result.manager === "npm"
      ? ""
      : `; requested via "${result.manager}:" - installed the same way, "${result.manager}:" is an alias, not a real ${result.manager} install`
  return `${what}${alias}; executes with the host process's full user rights`
}
