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
import { registerV1Hooks } from "./hooks.js"
import { scanStrandedV1, strandedWarning } from "./scan.js"
import { PRESETS, checkPrerequisite, type Preset, type PrerequisiteCheck } from "./preset.js"
import { checkFreshness, freshnessEnabled, pinnedNote } from "./freshness.js"
import {
  mountNote,
  parseGithubSpec,
  remoteTrustEnabled,
  resolveGithubPlugin,
  type GithubResolveResult,
  type GithubSpec,
} from "./github.js"
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

/**
 * A resolved specifier. Discriminated so the caller can branch between a
 * mountable module URL, a bundled preset, and a remote `github:` spec without
 * re-parsing the string.
 */
export type ResolvedSpec =
  | { kind: "module"; url: string }
  | { kind: "preset"; id: string }
  | { kind: "github"; spec: GithubSpec }

/** The honest refusal for a form this slice does not build. */
export function unsupportedSpecifierMessage(spec: string): string {
  return (
    `[oc-bifrost] unsupported specifier "${spec}": npm and bare package names are not yet supported; ` +
    `accepted forms are: preset:, github:, ~/path, ./path (or an absolute path)`
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
 *   - anything else — including `npm:` and bare package names — is refused
 *                with the accepted-forms message. npm support is not built
 *                yet; refusing honestly beats guessing.
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
        let gh: GithubResolveResult
        try {
          gh = await resolveGithubPlugin(resolved.spec, {
            cacheRoot: githubCacheRoot(),
            trusted: remoteTrustEnabled(options.trustRemote, process.env),
          })
        } catch (error) {
          reporter.warn((error as Error).message)
          if (options.strict) throw error
          continue
        }
        specifier = gh.url
        // Always names the resolved commit, the digest, and the host-rights
        // reality — the consent stays informed on every later load.
        githubNote = mountNote(gh.meta, gh.fetched)
      } else {
        specifier = resolved.url
      }

      let module: Record<string, unknown>
      try {
        module = (await import(specifier)) as Record<string, unknown>
      } catch (error) {
        reporter.warn(importFailureMessage(entry.spec, directory, specifier, error as Error))
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
            const cleanup = await shape.definition.setup(context)
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
          const registered = await registerV1Hooks(context, hooks, reporter)
          cleanups.push(...registered.cleanups)
          reporter.record(`v1:${shape.id}`, "mounted", shape.note ?? "V1 factory")
        }
        if (resolved.kind === "preset" && presetNote) {
          reporter.record(`preset:${resolved.id}`, "mounted", presetNote)
        } else if (resolved.kind === "github" && githubNote) {
          reporter.record(`github:${resolved.spec.owner}/${resolved.spec.repo}`, "mounted", githubNote)
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
