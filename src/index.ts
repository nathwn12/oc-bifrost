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
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin } from "@opencode/plugin"
import { createReporter, renderReport } from "./report.js"
import { discover } from "./discover.js"
import { buildV1Context } from "./context.js"
import { registerV1Hooks } from "./hooks.js"
import type { BifrostOptions, OCContext, PluginEntry } from "./types.js"

export { COMPAT_MATRIX, matrixRow } from "./compat-matrix.js"
export type { MatrixRow } from "./compat-matrix.js"

function normalizeEntries(options: BifrostOptions | undefined): Array<{ spec: string; options?: Record<string, unknown> }> {
  const raw = options?.plugins ?? []
  return raw.map((entry: PluginEntry) =>
    typeof entry === "string" ? { spec: entry } : { spec: entry.spec, options: entry.options },
  )
}

/** Resolve a user-supplied specifier against the project directory. */
function resolveSpec(spec: string, directory: string): string {
  const isRelative = spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)
  if (!isRelative) return spec
  return pathToFileURL(path.resolve(directory, spec)).href
}

export default Plugin.define({
  id: "oc.bifrost",
  async setup(ctx) {
    const context = ctx as unknown as OCContext
    const options = (context.options ?? {}) as BifrostOptions
    const entries = normalizeEntries(options)
    const cleanups: Array<() => void | Promise<void>> = []

    if (entries.length === 0) {
      console.warn("[oc-bifrost] no plugins configured; set options.plugins to bridge legacy plugins")
      return
    }

    for (const entry of entries) {
      const reporter = createReporter(entry.spec, { strict: options.strict, verbose: options.verbose })
      const specifier = resolveSpec(entry.spec, context.location?.directory ?? process.cwd())

      let module: Record<string, unknown>
      try {
        module = (await import(specifier)) as Record<string, unknown>
      } catch (error) {
        reporter.warn(`could not import "${entry.spec}": ${(error as Error).message}`)
        continue
      }

      const shape = discover(module, entry.spec)
      if (shape.kind === "unknown") {
        reporter.warn(`skipped "${entry.spec}": ${shape.reason}`)
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
      } catch (error) {
        reporter.warn(`failed to mount "${entry.spec}": ${(error as Error).message}`)
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
