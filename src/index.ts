/**
 * oc-bifrost — the OpenCode plugin compatibility bridge.
 *
 * Loads plugin modules of any era and mounts them on the V2 runtime:
 *
 *   - a V1 factory `async (input) => Hooks`  -> hook translation
 *   - a V1 module `{ server: factory }`      -> hook translation
 *   - a V2 definition `{ id, setup }`        -> mounted with the same context
 *
 * Nothing is dropped silently: every V1 hook is reported as full, partial, or
 * refused. See `compat-matrix.ts` for the contract.
 */
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin } from "@opencode/plugin"
import { createReporter, renderReport } from "./report.js"
import { createReportSink } from "./sink.js"
import { discover } from "./discover.js"
import { buildV1Context } from "./context.js"
import { hasKnownV1Hook, registerV1Hooks } from "./hooks.js"
import { scanStrandedV1, strandedWarning } from "./scan.js"
import { PRESETS, checkPrerequisite, type Preset, type PrerequisiteCheck } from "./preset.js"
import { checkFreshness, freshnessEnabled, pinnedNote } from "./freshness.js"
import {
  githubCacheRepoPrefix,
  githubPluginKey,
  mountNote,
  parseGithubSpec,
  remoteTrustEnabled,
  resolveGithubPlugin,
  type GithubResolveResult,
  type GithubSpec,
} from "./github.js"
import {
  isBareRegistrySpecifier,
  parseRegistrySpecifier,
  registryCacheRoot,
  registryMountNote,
  resolveRegistryPlugin,
  type RegistryResolveResult,
  type RegistrySpec,
} from "./registry.js"
import { wireTui } from "./wire-tui.js"
import type { BifrostOptions, OCContext, PluginEntry } from "./types.js"

export { COMPAT_MATRIX, matrixRow } from "./compat-matrix.js"
export type { MatrixRow } from "./compat-matrix.js"
export { PRESETS } from "./preset.js"
export type { Preset, PresetRequires } from "./preset.js"
export { compareTags, pinnedNote, freshnessEnabled, checkFreshness } from "./freshness.js"
export type { FreshnessResult } from "./freshness.js"

function normalizeEntries(options: BifrostOptions | undefined): Array<{ spec: string; options?: Record<string, unknown> }> {
  const raw = options?.plugins ?? []
  return raw.map((entry: PluginEntry) =>
    typeof entry === "string" ? { spec: entry } : { spec: entry.spec, options: entry.options },
  )
}

/** The shared OpenCode cache root for fetched GitHub plugins. */
export function githubCacheRoot(
  homeDirectory = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const cacheHome = env.XDG_CACHE_HOME || path.join(homeDirectory, ".cache")
  return path.join(cacheHome, "opencode", "oc-bifrost", "github")
}

/** The shared OpenCode cache root for installed registry plugins. */
export function registryCacheRootFor(
  homeDirectory = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return registryCacheRoot(homeDirectory, env)
}

/**
 * Whether opt-in TUI wiring is enabled. An explicit option wins; otherwise
 * `OC_BIFROST_WIRE_TUI` opts in with exactly `"1"` or `"true"`
 * (case-insensitive); any other value is off. Pure, exported for tests.
 */
export function wireTuiEnabled(option: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (option !== undefined) return option
  const raw = String(env?.OC_BIFROST_WIRE_TUI ?? "").trim().toLowerCase()
  return raw === "1" || raw === "true"
}

/**
 * A resolved specifier. Discriminated so the caller can branch between a
 * mountable module URL, a bundled preset, and a remote `github:` spec without
 * re-parsing the string.
 */
export type ResolvedSpec =
  | { kind: "module"; url: string }
  | { kind: "preset"; id: string }
  | { kind: "github"; spec: GithubSpec }
  | { kind: "registry"; spec: RegistrySpec }

/** The honest refusal for a form this slice does not build. */
export function unsupportedSpecifierMessage(spec: string): string {
  return (
    `[oc-bifrost] unsupported specifier "${spec}": accepted forms are: preset:, github:, ` +
    `a registry package (a bare name such as "oc-todo", "oc-todo@0.4.0", "@scope/pkg@^1.0.0", ` +
    `"pkg@latest", or the same behind an "npm:", "pnpm:", or "bun:" prefix), ~/path, ./path ` +
    `(or an absolute path), file://`
  )
}

/**
 * Resolve a user-supplied specifier against the session directory.
 *
 * Supported forms, in order:
 *   - `github:<owner>/<repo>[@<ref>][#<path>]` -> a remote V1 plugin, mounted
 *                BY SOURCE: resolved cache-first into a verified user-level
 *                OpenCode cache shared across project locations. The FIRST
 *                fetch requires explicit consent (`options.trustRemote: true`
 *                or `OC_BIFROST_TRUST=github`) — a cold cache refuses to
 *                fetch+execute otherwise. The ref resolves to a commit sha
 *                that is recorded with the sha256 and verified on every later
 *                load. See `github.ts`.
 *   - `~/...`  -> expands against `os.homedir()`, then treated as absolute.
 *                A bare `~` is invalid and throws. This is the reliable way to
 *                name a global install location on every platform.
 *   - `preset:<id>` -> a bundled preset from `PRESETS`; unknown ids throw with
 *                the valid list.
 *   - `./`, `../`, absolute -> a `file://` URL resolved against `directory`
 *                (unchanged from 0.1.0 — the regression surface).
 *   - `file://` -> passed through as a bare module specifier.
 *   - a bare registry name (`oc-todo`, `oc-todo@0.4.0`, `@scope/pkg@^1.0.0`,
 *                `pkg@latest`) or the same behind an `npm:`/`pnpm:`/`bun:`
 *                prefix -> installed from the npm registry into a
 *                bifrost-owned cache directory and mounted from there. The
 *                prefix is stripped and the remainder is treated as the bare
 *                spec; `pnpm:`/`bun:` are aliases that install through the
 *                same spawned manager (never a real pnpm/bun install), and
 *                the mount note says so plainly. See `registry.ts`.
 *   - anything else is refused with the accepted-forms message (see
 *                `unsupportedSpecifierMessage`); refusing honestly beats guessing.
 */
export function resolveSpec(spec: string, directory: string): ResolvedSpec {
  if (spec === "~") {
    throw new Error(`[oc-bifrost] invalid specifier "~": expected a home path such as "~/plugins/my-plugin.ts"`)
  }
  if (spec.startsWith("~")) {
    if (!spec.startsWith("~/") && !spec.startsWith("~\\")) {
      throw new Error(`[oc-bifrost] invalid specifier "${spec}": home paths must look like "~/..."`)
    }
    return { kind: "module", url: pathToFileURL(path.resolve(os.homedir(), spec.slice(2))).href }
  }
  if (spec.startsWith("preset:")) {
    const id = spec.slice("preset:".length)
    if (!PRESETS[id]) {
      const valid = Object.keys(PRESETS).join(", ") || "(none)"
      throw new Error(`[oc-bifrost] unknown preset "${id}"; valid presets: ${valid}`)
    }
    return { kind: "preset", id }
  }
  if (spec.startsWith("github:")) {
    return { kind: "github", spec: parseGithubSpec(spec) }
  }
  const isRelative = spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)
  if (isRelative) return { kind: "module", url: pathToFileURL(path.resolve(directory, spec)).href }
  if (spec.startsWith("file://")) return { kind: "module", url: spec }
  // Registry specifiers last: `github:` / `preset:` / paths above are matched
  // byte-for-byte as before, so only what used to be refused reaches here. A
  // prefixed form parses (malformed forms throw loudly); a bare name resolves
  // only when it parses as a registry spec - anything else is refused.
  if (spec.startsWith("npm:") || spec.startsWith("pnpm:") || spec.startsWith("bun:")) {
    return { kind: "registry", spec: parseRegistrySpecifier(spec) }
  }
  if (!spec.includes(":") && isBareRegistrySpecifier(spec)) {
    return { kind: "registry", spec: parseRegistrySpecifier(spec) }
  }
  throw new Error(unsupportedSpecifierMessage(spec))
}

/**
 * The loud, actionable message for a failed import.
 *
 * Pure and exported so it can be asserted without a host. The fix hint names
 * the single worst failure mode: a relative specifier resolves against the
 * SESSION directory, so a "successful" global install that used one silently
 * imports nothing useful.
 */
export function importFailureMessage(spec: string, directory: string, target: string, error: Error): string {
  return [
    `could not import "${spec}" — resolved against "${directory}" to "${target}".`,
    `  ${error.message}`,
    `  fix: relative specifiers resolve against the SESSION directory, not this plugin's own location.`,
    `  For a global install use an absolute path or "~/..."; the bundled offline fallback "preset:rtk" also works.`,
  ].join("\n")
}

export default Plugin.define({
  id: "oc.bifrost",
  async setup(ctx) {
    const context = ctx as unknown as OCContext
    const options = (context.options ?? {}) as BifrostOptions
    const entries = normalizeEntries(options)
    const cleanups: Array<() => void | Promise<void>> = []
    const directory = context.location?.directory ?? process.cwd()

    // Durable mirror of the report. stdout is discarded when the host runs as a
    // managed background service or a stdio server, so console output alone is
    // unreachable exactly where the proof matters. Console behaviour is kept.
    const sink = createReportSink({ env: process.env })

    // Proactive, before any mount: a stranded V1 file in a discovery directory
    // is rejected by the host before this bridge ever runs. Warn while the
    // user can still move it.
    const stranded = scanStrandedV1({ directory })
    if (stranded.length > 0) {
      const scanReporter = createReporter("scan", {
        strict: options.strict,
        verbose: options.verbose,
        sink: sink.write,
      })
      const MAX = 5
      for (const file of stranded.slice(0, MAX)) scanReporter.warn(strandedWarning(file))
      if (stranded.length > MAX) {
        scanReporter.warn(`...and ${stranded.length - MAX} more stranded V1 file(s) in plugin discovery directories`)
      }
    }

    if (entries.length === 0) {
      const notice = "[oc-bifrost] no plugins configured; set options.plugins to bridge legacy plugins"
      console.warn(notice)
      sink.write(notice)
      return
    }

    for (const entry of entries) {
      const reporter = createReporter(entry.spec, {
        strict: options.strict,
        verbose: options.verbose,
        sink: sink.write,
      })

      let resolved: ResolvedSpec
      try {
        resolved = resolveSpec(entry.spec, directory)
      } catch (error) {
        reporter.warn((error as Error).message)
        if (options.strict) throw error
        continue
      }

      let specifier: string
      let presetNote: string | undefined
      let bundle: Preset | undefined
      let githubNote: string | undefined
      let registryNote: string | undefined
      // Hoisted so the post-mount wiring step can read the resolve result.
      let gh: GithubResolveResult | undefined
      if (resolved.kind === "preset") {
        bundle = PRESETS[resolved.id] as Preset
        const check: PrerequisiteCheck = await checkPrerequisite(bundle)
        if (!check.ok) {
          if (options.strict) throw new Error(`[oc-bifrost] ${check.message}`)
          reporter.warn(check.message)
          continue
        }
        // The offline pin is always reported, folded into the existing note so
        // the mount report names the vendored version with zero network access.
        presetNote = `${check.message}; ${pinnedNote(bundle)}`
        specifier = bundle.entry.href
      } else if (resolved.kind === "github") {
        // Cache-first with an explicit consent gate: a cold cache refuses to
        // fetch+execute unless opted in (`options.trustRemote` or the
        // OC_BIFROST_TRUST=github env); a warm, hash-verified cache loads
        // with zero network and no re-consent. The cache is user-level, not
        // tied to the project that happens to load the plugin.
        try {
          gh = await resolveGithubPlugin(resolved.spec, {
            cacheRoot: githubCacheRoot(),
            trusted: remoteTrustEnabled(options.trustRemote, process.env),
            provision: options.provision,
            strict: options.strict,
          })
        } catch (error) {
          reporter.warn((error as Error).message)
          if (options.strict) throw error
          continue
        }
        specifier = gh.url
        // Always names the resolved commit, the layout (repository snapshot or
        // the loud single-file fallback), the digest, the provision rows, and
        // the host-rights reality - the consent stays informed on every later
        // load. Load-time warnings (e.g. an ignored pre-snapshot cache) ride
        // in the same note, so nothing is silent.
        githubNote = [mountNote(gh.meta, gh.fetched), ...(gh.warnings ?? []), ...(gh.provision ?? [])].join("; ")
      } else if (resolved.kind === "registry") {
        // Cache-first WITHOUT a consent gate: the package comes from the
        // public npm registry (not an arbitrary repo), and naming it in
        // `options.plugins` IS the opt-in. A warm, verified cache loads with
        // zero spawns. The cache is user-level, mirroring the github layout.
        // The mount note always names the installed version, the spawner, and
        // - for `pnpm:`/`bun:` - the alias honesty line. Classification below
        // is unchanged: V1 bridges, V2 runs natively.
        try {
          const reg: RegistryResolveResult = await resolveRegistryPlugin(resolved.spec, {
            cacheRoot: registryCacheRootFor(),
          })
          specifier = reg.url
          registryNote = registryMountNote(reg)
        } catch (error) {
          reporter.warn((error as Error).message)
          if (options.strict) throw error
          continue
        }
      } else {
        specifier = resolved.url
      }

      let module: Record<string, unknown>
      try {
        module = (await import(specifier)) as Record<string, unknown>
      } catch (error) {
        // The import failed BEFORE the mount note could be rendered, but the
        // provisioning that already ran is a real outcome - never silently lost
        // with the failure (a refused peer is the reason the import failed in
        // the first place, and it must be visible).
        const provisionRows = gh?.provision ?? []
        const importMessage = importFailureMessage(entry.spec, directory, specifier, error as Error)
        reporter.warn(
          provisionRows.length === 0 ? importMessage : `${importMessage} (${provisionRows.join("; ")})`,
        )
        if (options.strict) throw error
        continue
      }

      const shape = discover(module, entry.spec)
      if (shape.kind === "unknown") {
        reporter.warn(`skipped "${entry.spec}": ${shape.reason}`)
        if (options.strict) throw new Error(`[oc-bifrost] skipped "${entry.spec}": ${shape.reason}`)
        continue
      }

      let mounted = false
      try {
        if (shape.kind === "v2") {
          if (typeof shape.definition.setup === "function") {
            // Per-plugin options are a defined V2 channel: the host mounts each
            // plugin as `{ ...host, options: operation.options }`, defaulting to
            // `{}` (packages/core/src/plugin/module.ts:149,
            // packages/core/src/config/plugin/source.ts:115-117). Mirror it: the
            // sub-plugin sees ITS entry options, never oc-bifrost's own.
            const cleanup = await shape.definition.setup({ ...context, options: entry.options ?? {} })
            if (typeof cleanup === "function") cleanups.push(cleanup as () => void | Promise<void>)
            reporter.record(`v2:${shape.id}`, "mounted", "V2 setup invoked with the host context")
          } else {
            reporter.record(
              `v2:${shape.id}`,
              "unsupported",
              "effect-only V2 definitions are not mountable as a promise plugin",
            )
          }
        } else {
          const v1Context = buildV1Context(context, reporter)
          const hooks = await shape.factory(v1Context, entry.options)
          // Discovery mounts ANY function export as a V1 factory by shape, so a
          // helper-only module mounts as V1. The mounting is unchanged; the
          // silence is removed: a mount exposing none of the known V1 hook keys
          // warns loudly, naming the file.
          if (!hasKnownV1Hook(hooks)) {
            reporter.warn(
              `"${entry.spec}" mounted as V1 but exposes none of the known V1 hook keys - likely a helper-only module picked by shape; nothing is bridged`,
            )
          }
          const registered = await registerV1Hooks(context, hooks, reporter)
          cleanups.push(...registered.cleanups)
          reporter.record(`v1:${shape.id}`, "mounted", shape.note ?? "V1 factory")
        }
        if (resolved.kind === "preset" && presetNote) {
          reporter.record(`preset:${resolved.id}`, "mounted", presetNote)
        } else if (resolved.kind === "github" && githubNote) {
          reporter.record(`github:${resolved.spec.owner}/${resolved.spec.repo}`, "mounted", githubNote)
        } else if (resolved.kind === "registry" && registryNote) {
          reporter.record(`registry:${resolved.spec.bare}`, "mounted", registryNote)
        }
        mounted = true
      } catch (error) {
        reporter.warn(`failed to mount "${entry.spec}": ${(error as Error).message}`)
        if (options.strict) throw error
      }

      // Opt-in freshness check. This does NOT delay plugin setup: the request
      // is fired without awaiting and the notice may appear shortly after the
      // mount report. Both handlers are attached so a rejection can never
      // surface as an unhandled rejection. `behind` warns; anything else is
      // silent (the pinned note already shows in the report). The request is
      // timeboxed by checkFreshness, which is the only bound it needs.
      if (mounted && bundle && freshnessEnabled(options.freshness, process.env)) {
        const spec = bundle
        void checkFreshness(spec).then(
          (freshness) => {
            if (freshness.status === "behind") reporter.warn(freshness.message)
          },
          () => {
            // checkFreshness never rejects by contract; belt and braces.
          },
        )
      }

      // Opt-in TUI wiring - AFTER the mount succeeded, and only for a github:
      // SNAPSHOT (the single-file fallback has no materialized tree to wire).
      // The cli.json path is CALLER-computed: the `cliJsonPath` option
      // overrides the default `~/.config/opencode/cli.json`, and wire-tui.ts
      // never guesses it. Whether a wrapper is needed is wire-tui's own
      // condition - not duplicated here. A tree that ships no TUI entry is a
      // clean skip (an informational row, nothing written); a wire failure or
      // refusal is a loud row (never silent, never swallowed) and can never
      // abort the mount itself: the plugin already mounted.
      if (
        mounted &&
        resolved.kind === "github" &&
        gh !== undefined &&
        gh.meta.layout === "snapshot" &&
        wireTuiEnabled(options.wireTui, process.env)
      ) {
        // github.ts layout contract: the materialized snapshot tree lives at
        // `<cacheDir>/tree` (a stable, documented constant of that module).
        const treeDir = path.join(gh.cacheDir, "tree")
        const cliJsonPath = options.cliJsonPath ?? path.join(os.homedir(), ".config", "opencode", "cli.json")
        try {
          const wired = await wireTui(treeDir, cliJsonPath, {
            treeFamily: githubCacheRepoPrefix(resolved.spec),
            pluginKey: githubPluginKey(resolved.spec),
          })
          reporter.record(
            `wire:${resolved.spec.owner}/${resolved.spec.repo}`,
            "mounted",
            wired.kind === "skipped" ? wired.reason : `TUI entry ${wired.entry} wired into ${cliJsonPath}`,
          )
        } catch (error) {
          reporter.warn(
            `could not wire the TUI entry for "${entry.spec}" into ${cliJsonPath}: ${(error as Error).message}`,
          )
        }
      }

      if (options.verbose !== false) {
        const block = `[oc-bifrost] ${entry.spec}\n${renderReport(reporter)}`
        console.log(block)
        sink.write(block)
      }
    }

    return async () => {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          console.warn(`[oc-bifrost] cleanup failed: ${(error as Error).message}`)
        }
      }
    }
  },
})
