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
import { discover } from "./discover.js"
import { buildV1Context } from "./context.js"
import { registerV1Hooks } from "./hooks.js"
import { scanStrandedV1, strandedWarning } from "./scan.js"
import { PRESETS, checkPrerequisite, type Preset, type PrerequisiteCheck } from "./preset.js"
import type { BifrostOptions, OCContext, PluginEntry } from "./types.js"

export { COMPAT_MATRIX, matrixRow } from "./compat-matrix.js"
export type { MatrixRow } from "./compat-matrix.js"
export { PRESETS } from "./preset.js"
export type { Preset, PresetRequires } from "./preset.js"

function normalizeEntries(options: BifrostOptions | undefined): Array<{ spec: string; options?: Record<string, unknown> }> {
  const raw = options?.plugins ?? []
  return raw.map((entry: PluginEntry) =>
    typeof entry === "string" ? { spec: entry } : { spec: entry.spec, options: entry.options },
  )
}

/**
 * A resolved specifier. Discriminated so the caller can branch between a
 * mountable module URL and a bundled preset without re-parsing the string.
 */
export type ResolvedSpec = { kind: "module"; url: string } | { kind: "preset"; id: string }

/**
 * Resolve a user-supplied specifier against the session directory.
 *
 * Supported forms, in order:
 *   - `~/...`  -> expands against `os.homedir()`, then treated as absolute.
 *                A bare `~` is invalid and throws. This is the reliable way to
 *                name a global install location on every platform.
 *   - `preset:<id>` -> a bundled preset from `PRESETS`; unknown ids throw with
 *                the valid list.
 *   - `./`, `../`, absolute -> a `file://` URL resolved against `directory`
 *                (unchanged from 0.1.0 — the regression surface).
 *   - anything else (including `file://`) -> passed through as a bare module
 *                specifier.
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
  const isRelative = spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)
  if (!isRelative) return { kind: "module", url: spec }
  return { kind: "module", url: pathToFileURL(path.resolve(directory, spec)).href }
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
    `  For a global install use an absolute path, "~/...", or "preset:rtk".`,
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

    // Proactive, before any mount: a stranded V1 file in a discovery directory
    // is rejected by the host before this bridge ever runs. Warn while the
    // user can still move it.
    const stranded = scanStrandedV1({ directory })
    if (stranded.length > 0) {
      const scanReporter = createReporter("scan", { strict: options.strict, verbose: options.verbose })
      const MAX = 5
      for (const file of stranded.slice(0, MAX)) scanReporter.warn(strandedWarning(file))
      if (stranded.length > MAX) {
        scanReporter.warn(`...and ${stranded.length - MAX} more stranded V1 file(s) in plugin discovery directories`)
      }
    }

    if (entries.length === 0) {
      console.warn("[oc-bifrost] no plugins configured; set options.plugins to bridge legacy plugins")
      return
    }

    for (const entry of entries) {
      const reporter = createReporter(entry.spec, { strict: options.strict, verbose: options.verbose })

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
      if (resolved.kind === "preset") {
        const bundle: Preset = PRESETS[resolved.id] as Preset
        const check: PrerequisiteCheck = await checkPrerequisite(bundle)
        if (!check.ok) {
          if (options.strict) throw new Error(`[oc-bifrost] ${check.message}`)
          reporter.warn(check.message)
          continue
        }
        presetNote = check.message
        specifier = bundle.entry.href
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
        }
      } catch (error) {
        reporter.warn(`failed to mount "${entry.spec}": ${(error as Error).message}`)
        if (options.strict) throw error
      }

      if (options.verbose !== false) {
        console.log(`[oc-bifrost] ${entry.spec}\n${renderReport(reporter)}`)
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
