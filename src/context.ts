/**
 * V1 PluginInput facade.
 *
 * A V1 factory is called with `{ client, project, directory, worktree, $, ... }`.
 * We reproduce that shape. Where V2 has no faithful equivalent we return a
 * guarded proxy that fails loudly rather than a plausible-looking lie.
 */
import type { OCContext, V1PluginInput } from "./types.js"
import { createShell, hostShell, type Shell } from "./shell.js"
import type { Reporter } from "./report.js"

export interface ContextFacadeOptions {
  reporter: Reporter
  /** Fallback used when V2 cannot describe a worktree. */
  directory?: string
}

function createClientFacade(ctx: OCContext, reporter: Reporter): unknown {
  const unsupported = (path: string) => {
    reporter.warn(`client.${path} is not provided by the V1 compatibility layer`)
    throw new Error(`[oc-bifrost] client.${path} is not supported on the V2 runtime`)
  }

  const app = {
    // The most common V1 call: structured logging. V2 has no app.log domain.
    log: async (input?: { body?: Record<string, unknown> }) => {
      const body = input?.body ?? {}
      const service = typeof body.service === "string" ? body.service : "plugin"
      const message = typeof body.message === "string" ? body.message : ""
      console.log(`[oc-bifrost:${service}] ${message}`)
      return {}
    },
    get: async () => ({ name: ctx.app.name, version: ctx.app.version, channel: ctx.app.channel }),
  }

  const target: Record<string, unknown> = {
    app,
    project: {
      get: async () => ctx.location.project,
      list: async () => [ctx.location.project],
    },
  }

  return new Proxy(target, {
    get(object, property) {
      const key = String(property)
      if (key in object) return object[key]
      // Known-but-unmapped V1 domains: fail with a clear reason, never undefined.
      if (["session", "tui", "auth", "provider", "config", "file", "find", "event", "command"].includes(key)) {
        return new Proxy(
          {},
          {
            get(_t, method) {
              return () => unsupported(`${key}.${String(method)}`)
            },
          },
        )
      }
      return undefined
    },
  })
}

export function buildV1Context(ctx: OCContext, reporter: Reporter): V1PluginInput {
  const directory = ctx.location?.directory ?? process.cwd()
  const shell: Shell = hostShell() ?? createShell()

  const facade = {
    client: createClientFacade(ctx, reporter),
    project: ctx.location?.project,
    directory,
    worktree: directory,
    serverUrl: new URL("http://127.0.0.1"),
    experimental_workspace: {
      register(type: string) {
        reporter.warn(`experimental_workspace.register("${type}") is not supported on V2`)
      },
    },
    $: shell,
  }

  return facade as unknown as V1PluginInput
}
