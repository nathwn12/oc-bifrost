/**
 * The bridge: V1 hook keys -> V2 registration calls.
 *
 * Every entry in the map is either bridged, approximated, or refused out loud.
 * The mapping follows OpenCode's own published V1 -> V2 migration table, plus
 * the refinements verified in the V2 source (mutating the single event object
 * is honoured; `execute.before` is the only hook whose throw rejects a call).
 */
import type { OCContext, V1Hooks } from "./types.js"
import type { Reporter } from "./report.js"

type Handler = (...args: unknown[]) => unknown

function asHandler(value: unknown): Handler | undefined {
  return typeof value === "function" ? (value as Handler) : undefined
}

/**
 * The V1-era tool name for the bridged hook input. V2 registers the shell tool
 * as `shell` (`packages/core/src/tool/plugin/shell.ts:22`); V1 plugins gate on
 * `"bash"`. Presenting the V1 name is regression-safe: the vendored rtk
 * accepts both spellings (`vendor/rtk.ts:20-21`), and any other V2 tool name
 * passes through unchanged.
 */
function v1ToolName(tool: unknown): unknown {
  return tool === "shell" ? "bash" : tool
}

/**
 * V2 event payload -> V1 `{ type, properties }` envelope, for the one event
 * both eras name: session idle.
 *
 * V2 replaced `session.idle` with `session.status` carrying
 * `{ sessionID, status: { type: "idle" | "busy" | "retry" } }`
 * (`packages/schema/src/session-status-event.ts:35-51`), and V2 payloads carry
 * `data`, not V1's `properties`. Without the synthesis a V1 hook that checks
 * `event.type === "session.idle"` never matches. The deprecated `session.idle`
 * event is still emitted by V2 and only needs its `properties` alias.
 *
 * Nothing else is translated: the two eras' names and payloads differ
 * elsewhere, and inventing more would be a lie.
 */
function toV1Event(event: Record<string, unknown>): Record<string, unknown> {
  const data = (event.data ?? {}) as Record<string, unknown>
  const status = data.status as { type?: unknown } | undefined
  if (event.type === "session.status" && status?.type === "idle") {
    return { ...event, type: "session.idle", properties: { sessionID: data.sessionID } }
  }
  if (event.type === "session.idle") {
    return { ...event, properties: { sessionID: data.sessionID } }
  }
  return event
}

export interface RegisterResult {
  cleanups: Array<() => void | Promise<void>>
}

export async function registerV1Hooks(
  ctx: OCContext,
  hooks: V1Hooks,
  reporter: Reporter,
): Promise<RegisterResult> {
  const cleanups: Array<() => void | Promise<void>> = []
  const table = hooks as unknown as Record<string, unknown>

  /* ---------------- tool.execute.before ---------------- */
  const before = asHandler(table["tool.execute.before"])
  if (before) {
    await ctx.tool.hook("execute.before", async (event) => {
      const input = { tool: v1ToolName(event.tool), sessionID: event.sessionID, callID: String(event.id) }
      const output = { args: event.input }
      await before(input, output)
      if (output.args !== event.input) event.input = output.args
    })
    reporter.record("tool.execute.before", "full", "mutable event.input write-back")
  }

  /* ---------------- tool.execute.after ---------------- */
  const after = asHandler(table["tool.execute.after"])
  if (after) {
    await ctx.tool.hook("execute.after", async (event) => {
      const input = {
        tool: v1ToolName(event.tool),
        sessionID: event.sessionID,
        callID: String(event.id),
        args: event.input,
      }
      const output: { title: string; output: string; metadata: unknown } = {
        title: "",
        output: "",
        metadata: undefined,
      }
      await after(input, output)
      if (event.status === "completed" && event.result) {
        if (output.output) event.result.output = output.output
        if (output.metadata !== undefined) event.result.metadata = output.metadata
      }
    })
    reporter.record("tool.execute.after", "partial", "result.output/metadata write-back; title ignored")
  }

  /* ---------------- shell.env ---------------- */
  const shellEnv = asHandler(table["shell.env"])
  if (shellEnv) {
    await ctx.shell.hook("create.before", async (event) => {
      const output = { env: { ...event.env } as Record<string, string> }
      await shellEnv({ cwd: event.cwd }, output)
      event.env = { ...event.env, ...output.env }
    })
    reporter.record("shell.env", "full", "shell create.before event.env")
  }

  /* ---------------- chat.params ---------------- */
  const chatParams = asHandler(table["chat.params"])
  if (chatParams) {
    await ctx.session.hook("context", async (event) => {
      const options = (event.options ?? {}) as Record<string, unknown>
      const output = {
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        maxOutputTokens: options.maxTokens,
        options: {} as Record<string, unknown>,
      }
      await chatParams({ sessionID: event.sessionID, model: event.model }, output)
      if (output.temperature !== undefined) options.temperature = output.temperature
      if (output.topP !== undefined) options.topP = output.topP
      if (output.topK !== undefined) options.topK = output.topK
      if (output.maxOutputTokens !== undefined) options.maxTokens = output.maxOutputTokens
      Object.assign(options, output.options ?? {})
      event.options = options
    })
    reporter.record("chat.params", "partial", "mapped onto session context generation options")
  }

  /* ---------------- chat.headers ---------------- */
  const chatHeaders = asHandler(table["chat.headers"])
  if (chatHeaders) {
    await ctx.session.hook("model.request", async (event) => {
      const output = { headers: { ...(event.headers ?? {}) } as Record<string, string> }
      await chatHeaders({ sessionID: event.sessionID, model: event.model }, output)
      event.headers = output.headers
    })
    reporter.record("chat.headers", "full", "session model.request headers")
  }

  /* ---------------- chat.message ---------------- */
  const chatMessage = asHandler(table["chat.message"])
  if (chatMessage) {
    await ctx.session.hook("prompt", async (event) => {
      // V2 reads `event.prompt` back as the message text (`session/prompt.ts:40-52`),
      // so the V1 write must land on `event.prompt.text`. The V1 hook is handed the
      // V1-era shapes pre-filled from the V2 prompt text — `output.message` (whole
      // message) and `output.parts` (a leading text part) — and its rewrite is read
      // back: a changed `message.content`, or text parts that changed from the
      // pre-fill, replace the prompt text. Idempotent: a no-op hook changes nothing.
      const prompt = (event as { prompt?: { text?: string } }).prompt
      const original = (prompt && typeof prompt.text === "string" ? prompt.text : "") as string
      const output = {
        message: { role: "user", content: original },
        parts: [{ type: "text", text: original }] as unknown[],
      }
      await chatMessage({ sessionID: event.sessionID, messageID: event.messageID }, output)
      const content = (output.message as { content?: unknown } | undefined)?.content
      const textParts = Array.isArray(output.parts)
        ? (output.parts as Array<{ type?: string; text?: unknown }>)
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
        : []
      const partsJoin = textParts.join("")
      const rewritten =
        typeof content === "string" && content !== original && content.length > 0
          ? content
          : partsJoin !== original && partsJoin.length > 0
            ? partsJoin
            : original
      if (prompt && rewritten !== original) prompt.text = rewritten
    })
    reporter.record("chat.message", "partial", "prompt hook; pre-filled V1 message/parts -> event.prompt.text write-back")
  }

  /* ---------------- permission.ask ---------------- */
  const permissionAsk = asHandler(table["permission.ask"])
  if (permissionAsk) {
    await ctx.permission.hook("evaluate", async (event) => {
      const output = { status: event.effect }
      await permissionAsk(
        { sessionID: event.sessionID, action: event.action, resources: event.resources },
        output,
      )
      if (typeof output.status === "string") event.effect = output.status
    })
    reporter.record("permission.ask", "full", "permission evaluate effect")
  }

  /* ---------------- experimental.chat.messages.transform ---------------- */
  // Registered BEFORE the system.transform block: V1 plugins that pair the two
  // (agent-identity) rely on messages.transform firing first, and V2 runs the
  // session:context callbacks in registration order.
  const messagesTransform = asHandler(table["experimental.chat.messages.transform"])
  if (messagesTransform) {
    await ctx.session.hook("context", async (event) => {
      // Pre-fill the V1 {info, parts}[] envelope per V2 message so plugins that
      // read `m.info.role` / `m.info.model` unguarded never crash. `model` is
      // built from the real V2 Model.Ref shape (packages/schema/src/model.ts:18-22):
      // `id` is the BARE model id and `providerID` is a separate field — the
      // "providerID/modelID" string exists only in Model.Ref.parse. When both are
      // strings they win; a string-only id falls back to splitting on the FIRST "/",
      // so nested ids (openrouter/deepseek/deepseek-chat) keep the rest as modelID.
      const v2Messages = (event.messages ?? []) as Array<Record<string, unknown>>
      const output: { messages: Array<{ info: Record<string, unknown>; parts: unknown[] }> } = {
        messages: v2Messages.map((message) => {
          const info: Record<string, unknown> = { role: message.role }
          if (message.id !== undefined) info.id = message.id
          const sessionID = (message.sessionID as string | undefined) ?? (event.sessionID as string | undefined)
          if (sessionID !== undefined) info.sessionID = sessionID
          if (event.agent !== undefined) info.agent = event.agent
          const modelRef = event.model as { id?: unknown; providerID?: unknown } | undefined
          if (typeof modelRef?.providerID === "string" && typeof modelRef?.id === "string") {
            info.model = { providerID: modelRef.providerID, modelID: modelRef.id }
          } else if (typeof modelRef?.id === "string") {
            const slash = modelRef.id.indexOf("/")
            if (slash > 0) {
              info.model = {
                providerID: modelRef.id.slice(0, slash),
                modelID: modelRef.id.slice(slash + 1),
              }
            }
          }
          const content = message.content
          return { info, parts: Array.isArray(content) ? (content as unknown[]) : [] }
        }),
      }
      await messagesTransform({ sessionID: event.sessionID }, output)
      if (Array.isArray(output.messages)) {
        event.messages = output.messages.map((m, i) => {
          const original = v2Messages[i] ?? {}
          return { ...original, content: Array.isArray(m.parts) ? m.parts : original.content }
        })
      }
    })
    reporter.record("experimental.chat.messages.transform", "full", "V2 Message[] -> V1 {info,parts}[] pre-fill; parts write-back to content")
  }

  /* ---------------- experimental.chat.system.transform ---------------- */
  const systemTransform = asHandler(table["experimental.chat.system.transform"])
  if (systemTransform) {
    await ctx.session.hook("context", async (event) => {
      const parts = (event.system ?? []) as Array<{ type?: string; text?: string }>
      const output = { system: parts.map((part) => part.text ?? "") }
      await systemTransform({ sessionID: event.sessionID, model: event.model }, output)
      if (Array.isArray(output.system)) {
        event.system = output.system.map((text) => ({ type: "text", text }))
      }
    })
    reporter.record("experimental.chat.system.transform", "partial", "string[] <-> SystemPart[] conversion")
  }

  /* ---------------- experimental.session.compacting ---------------- */
  const compacting = asHandler(table["experimental.session.compacting"])
  if (compacting) {
    await ctx.session.hook("compaction", async (event) => {
      const output = { context: [] as string[], prompt: undefined as string | undefined }
      await compacting({ sessionID: event.sessionID }, output)
      if (Array.isArray(output.context)) {
        const system = (event.system ?? []) as Array<{ type?: string; text?: string }>
        for (const text of output.context) system.push({ type: "text", text })
      }
    })
    reporter.record("experimental.session.compacting", "partial", "context appended to compaction system; prompt replacement ignored")
  }

  /* ---------------- tool.definition ---------------- */
  const toolDefinition = asHandler(table["tool.definition"])
  if (toolDefinition) {
    const snapshot = new Map<string, { description?: string; parameters?: unknown }>()
    for (const tool of await ctx.tool.list()) {
      const output: { description: string; parameters: unknown } = {
        description: tool.description ?? "",
        parameters: tool.input,
      }
      await toolDefinition({ toolID: tool.id }, output)
      snapshot.set(tool.id, { description: output.description, parameters: output.parameters })
    }
    await ctx.tool.transform((editor) => {
      for (const [id, applied] of snapshot) {
        editor.update(id, (tool) => {
          if (applied.description) tool.description = applied.description
          if (applied.parameters !== undefined) tool.input = applied.parameters
        })
      }
    })
    reporter.record("tool.definition", "partial", "apply-time snapshot; transform callbacks must stay synchronous")
  }

  /* ---------------- tool map ---------------- */
  const toolMap = (table.tool ?? undefined) as Record<string, { description?: string; args?: unknown; execute?: unknown }> | undefined
  if (toolMap && typeof toolMap === "object" && Object.keys(toolMap).length > 0) {
    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(toolMap)) {
        const execute = typeof definition.execute === "function" ? definition.execute : async () => ({ content: "" })
        editor.add({
          name,
          description: definition.description ?? name,
          input: definition.args ?? { type: "object", properties: {}, additionalProperties: true },
          execute: async (input: unknown) => {
            const result = await (execute as (args: unknown) => Promise<unknown>)(input)
            return typeof result === "string" ? { content: result } : result
          },
        })
      }
    })
    reporter.record("tool", "partial", `${Object.keys(toolMap).length} V1 tool(s) registered via ctx.tool.transform`)
  }

  /* ---------------- event ---------------- */
  const eventHook = asHandler(table.event)
  if (eventHook) {
    const controller = new AbortController()
    cleanups.push(() => controller.abort())
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          await eventHook({ event: toV1Event(event) })
        } catch (error) {
          reporter.warn(`event hook threw: ${(error as Error).message}`)
        }
      }
    })()
    reporter.record(
      "event",
      "partial",
      "V2 session.status[idle] synthesised to the V1 session.idle envelope; other names/payloads pass through",
    )
  }

  /* ---------------- dispose ---------------- */
  const dispose = asHandler(table.dispose)
  if (dispose) {
    cleanups.push(async () => {
      await dispose()
    })
    reporter.record("dispose", "full", "setup cleanup")
  }

  /* ---------------- explicitly refused ---------------- */
  const refused: Array<[string, string]> = [
    ["config", "V1 global config mutation maps to per-domain transforms with different semantics"],
    ["auth", "V1 auth hook maps to ctx.integration.transform + integration APIs"],
    ["provider", "V1 provider hook maps to ctx.provider.transform / ctx.model.transform"],
    ["command.execute.before", "no one-to-one global V2 hook; use command transforms or the prompt hook"],
    ["experimental.provider.small_model", "no V2 equivalent"],
    ["experimental.compaction.autocontinue", "no V2 equivalent"],
    ["experimental.text.complete", "no V2 equivalent"],
  ]
  for (const [hook, note] of refused) {
    if (asHandler(table[hook])) reporter.record(hook, "unsupported", note)
  }

  return { cleanups }
}
