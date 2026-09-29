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

/**
 * V2 projected message -> V1 `{ info, parts }` envelope.
 *
 * V2 messages are discriminated by `type` ("assistant", "user", ...) and carry
 * a `Model.Ref` (`packages/schema/src/model.ts:18-22`: bare `id` plus a separate
 * `providerID`), while V1 reads `info.role` and `info.modelID`. Everything else
 * the V1 tracker inspects - `tokens` (input/output/reasoning/cache.read/write),
 * `time.created/completed`, `cost`, `finish`, `id` - is already the same shape
 * (`packages/schema/src/session-message.ts:212-236`,
 * `packages/schema/src/token-usage.ts:6-14`).
 */
function toV1Message(message: unknown): { info: Record<string, unknown>; parts: unknown[] } {
  const source = (message ?? {}) as Record<string, unknown>
  const { type, model, content, ...rest } = source
  const info: Record<string, unknown> = { ...rest, role: type }
  if (model && typeof model === "object") {
    const ref = model as { id?: unknown; providerID?: unknown }
    if (typeof ref.providerID === "string") info.providerID = ref.providerID
    if (typeof ref.id === "string") info.modelID = ref.id
  }
  return { info, parts: Array.isArray(content) ? content : [] }
}

function createClientFacade(ctx: OCContext, reporter: Reporter): unknown {
  const unsupported = (path: string) => {
    reporter.warn(`client.${path} is not provided by the V1 compatibility layer`)
    throw new Error(`[oc-bifrost] client.${path} is not supported on the V2 runtime`)
  }

  // Refusals a V1 plugin will hit while running are stated at load time too, not
  // only when the plugin happens to call the method. A refusal is a feature:
  // the tracker's own blanket catch is what turns these into silence, and that
  // choice belongs to the plugin.
  reporter.warn(
    "client.tui.* is refused: V2 server plugins have no toast surface; tui.toast.show is rendered in the TUI process",
  )
  reporter.warn("client.session.children is refused: V2 exposes no plugin-scoped child-session listing")

  /**
   * `client.session.messages({ path: { id } })` -> `ctx.session.context`.
   *
   * Loss stated honestly: V2's plugin-visible `session.context` returns the
   * active context (messages after the last compaction), not the full
   * transcript. Dedup-by-message-id still works; pre-compaction messages are not
   * returned. The full read is the HTTP `GET /api/session/:id/message` route
   * (`packages/protocol/src/groups/message.ts:66-87`), but the plugin context
   * carries no server address, so this facade cannot reach it.
   */
  const session: Record<string, unknown> = {
    messages: async (input?: { path?: { id?: unknown } }) => {
      const id = input?.path?.id
      if (typeof id !== "string") {
        throw new Error("[oc-bifrost] client.session.messages requires { path: { id } }")
      }
      const context = ctx.session?.context
      if (typeof context !== "function") return unsupported("session.messages")
      const messages = await context({ sessionID: id })
      const list = Array.isArray(messages) ? messages : []
      return { data: list.map(toV1Message) }
    },
  }
  const sessionDomain = new Proxy(session, {
    get(target, property) {
      const key = String(property)
      if (key in target) return target[key]
      return () => unsupported(`session.${key}`)
    },
  })

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
    session: sessionDomain,
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
      if (["tui", "auth", "provider", "config", "file", "find", "event", "command"].includes(key)) {
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
