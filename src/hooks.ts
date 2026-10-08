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
 * The reverse of `v1ToolName`: a V1-era tool name reassigned by a hook maps
 * back onto the V2 name before landing on the event (`bash` -> `shell`;
 * anything else passes through unchanged).
 */
function v2ToolName(tool: string): string {
  return tool === "bash" ? "shell" : tool
}

/**
 * Byte-identity for one pre-filled V1 message envelope. The snapshot is taken
 * BEFORE the V1 hook runs: pre-fill shares each parts array by reference, so
 * an in-place part edit must read as divergence. A value that refuses to
 * serialise degrades instead of pairing -- the snapshot and post-hook
 * sentinels deliberately differ, so an unserialisable envelope never claims
 * to be identical to anything.
 */
function messageFingerprint(message: unknown, original: boolean): string {
  try {
    return JSON.stringify(message) ?? (original ? "original" : "output")
  } catch {
    return original ? "__bifrost-unserializable-original__" : "__bifrost-unserializable-output__"
  }
}

/**
 * The degraded write-back for one V1 message envelope: built from the V1
 * hook's OWN info/parts, never from a positionally paired original, so a hook
 * that removes, adds, or reorders messages cannot hand a survivor the WRONG
 * original's id or V2-side fields. Event-level pre-fill (agent, model) stays
 * on the event and never lands on the message.
 */
function toPlainMessage(message: unknown): Record<string, unknown> {
  const envelope = (message ?? {}) as { info?: Record<string, unknown>; parts?: unknown }
  const info = (envelope.info ?? {}) as Record<string, unknown>
  const plain: Record<string, unknown> = {}
  plain.role = typeof info.role === "string" ? info.role : "user"
  if (info.id !== undefined) plain.id = info.id
  // NOTE: non-text V1-native parts (type:"tool"/"file"/...) land verbatim in content and are not valid V2 ContentParts.
  plain.content = Array.isArray(envelope.parts) ? envelope.parts : []
  return plain
}

const TERMINAL_EXECUTION_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

/**
 * V2 event payload -> V1 `{ type, properties }` envelope, for the one event
 * both eras name: session idle.
 *
 * Idle is synthesised from the terminal execution events - the durable events
 * V2 emits when a session run ends (`packages/schema/src/session-event.ts:
 * 246-257`). That is exactly how the client itself derives idle
 * (`packages/client/src/solid/data.ts:1025-1028`); V2 payloads carry `data`,
 * not V1's `properties`, so the terminal event needs its name and envelope
 * translated for a V1 hook that checks `event.type === "session.idle"`. The
 * deprecated `session.idle` event is still emitted by V2 and only needs its
 * `properties` alias.
 *
 * Nothing else is translated: the two eras' names and payloads differ
 * elsewhere, and inventing more would be a lie.
 */
function toV1Event(event: Record<string, unknown>): Record<string, unknown> {
  const data = (event.data ?? {}) as Record<string, unknown>
  if (TERMINAL_EXECUTION_EVENTS.has(event.type as string)) {
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

/**
 * Every V1 hook key oc-bifrost recognises - bridged, approximated, or refused
 * out loud. Discovery mounts ANY function export as a V1 factory by shape, so
 * a helper-only module mounts as V1; when its returned hooks expose none of
 * these keys the mount warns loudly (the mounting itself is unchanged).
 */
export const KNOWN_V1_HOOK_KEYS = [
  "tool.execute.before",
  "tool.execute.after",
  "shell.env",
  "chat.params",
  "chat.headers",
  "chat.message",
  "permission.ask",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "tool.definition",
  "tool",
  "event",
  "dispose",
  "config",
  "auth",
  "provider",
  "command.execute.before",
  "experimental.provider.small_model",
  "experimental.compaction.autocontinue",
  "experimental.text.complete",
] as const

export function hasKnownV1Hook(hooks: unknown): boolean {
  if (!hooks || typeof hooks !== "object") return false
  const table = hooks as Record<string, unknown>
  // `tool` is a definition map, not a function - non-empty means a real bridge.
  if (table.tool && typeof table.tool === "object" && Object.keys(table.tool).length > 0) return true
  return KNOWN_V1_HOOK_KEYS.some((key) => key !== "tool" && typeof table[key] === "function")
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
      // V2 reads BOTH `event.input` and `event.tool` back after the hook
      // (`packages/core/src/tool.ts:271-280`: `input.definitions?.get(event.tool)`,
      // then `requested?.name ?? event.tool` selects the executed tool), so a V1
      // reassignment of either must land back on the event. `input.tool` arrives
      // under its V1-era name (`shell` -> `bash`); the reassignment is compared
      // against the PRESENTED name so an untouched hook writes nothing back
      // (stamping the presented `bash` over a V2 `shell` would corrupt it), and
      // a real reassignment is mapped back (`bash` -> `shell`) before landing.
      const presented = v1ToolName(event.tool)
      const input = { tool: presented, sessionID: event.sessionID, callID: String(event.id) }
      const output = { args: event.input }
      await before(input, output)
      if (output.args !== event.input) event.input = output.args
      if (typeof input.tool === "string") {
        if (input.tool !== presented) event.tool = v2ToolName(input.tool)
      } else if (input.tool !== presented) {
        // Fail loud: a non-string reassignment has no V2 destination, so it
        // is dropped - and the drop is named instead of silent.
        let detail: string
        try {
          detail = JSON.stringify(input.tool) ?? String(input.tool)
        } catch {
          detail = typeof input.tool
        }
        reporter.warn(`tool.execute.before ignored a non-string input.tool reassignment (${detail}); event.tool unchanged`)
      }
    })
    reporter.record("tool.execute.before", "full", "mutable event.input + event.tool write-back")
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
      } else if (event.status === "error" && event.error) {
        // The error branch carries a `Tool.Error` (`{ message, metadata? }` -
        // packages/schema/src/tool.ts:61-65), so the V1 string output lands on
        // `error.message` and metadata onto `error.metadata`. `title` has no
        // destination on either branch - the same stated loss as before.
        if (output.output) event.error.message = output.output
        if (output.metadata !== undefined) event.error.metadata = output.metadata
      }
    })
    reporter.record("tool.execute.after", "partial", "completed: result.output/metadata, error: error.message/metadata; title ignored on both branches")
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
      // V1-era shapes pre-filled from the V2 prompt text - `output.message` (whole
      // message) and `output.parts` (a leading text part) - and its rewrite is read
      // back: a changed `message.content`, or text parts that changed from the
      // pre-fill, replace the prompt text. Idempotent: a no-op hook changes nothing.
      //
      // Attachments ride the same round-trip: V2 carries `files`/`agents`/`skills`
      // on the prompt (`packages/core/src/session/prompt.ts:40-52`), pre-filled
      // onto the synthetic message by reference. A reassignment lands back on the
      // prompt; an untouched reference (including in-place mutation, which already
      // shares the array) writes nothing. Non-text content parts still have no V2
      // destination and are ignored.
      const prompt = (event as { prompt?: { text?: string; files?: unknown; agents?: unknown; skills?: unknown } }).prompt
      const original = (prompt && typeof prompt.text === "string" ? prompt.text : "") as string
      const originalFiles = prompt?.files
      const originalAgents = prompt?.agents
      const originalSkills = prompt?.skills
      const output = {
        message: { role: "user", content: original, files: originalFiles, agents: originalAgents, skills: originalSkills },
        parts: [{ type: "text", text: original }] as unknown[],
      }
      await chatMessage({ sessionID: event.sessionID, messageID: event.messageID }, output)
      const message = output.message as { content?: unknown; files?: unknown; agents?: unknown; skills?: unknown }
      const content = message?.content
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
      if (prompt) {
        if (rewritten !== original) prompt.text = rewritten
        if (message.files !== originalFiles) prompt.files = message.files
        if (message.agents !== originalAgents) prompt.agents = message.agents
        if (message.skills !== originalSkills) prompt.skills = message.skills
      }
    })
    reporter.record("chat.message", "partial", "prompt hook; pre-filled V1 message/parts -> event.prompt.text/files/agents/skills write-back; non-text content parts ignored")
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
      const fingerprints = output.messages.map((message) => messageFingerprint(message, true))
      await messagesTransform({ sessionID: event.sessionID }, output)
      if (Array.isArray(output.messages)) {
        // Shape-aware write-back, mirroring the system.transform block below:
        // entries pair with originals ONLY when the pairing is provable. The
        // same count with every entry byte-identical keeps each original
        // whole; a longer array whose leading run the hook left byte-identical
        // (an append) keeps that run; anything else degrades to plain messages
        // built from the hook's own envelope. Same-index pairing on a shorter
        // or reordered shape would hand a surviving message the WRONG
        // original's object as soon as two messages share a text.
        const originals = v2Messages.slice()
        if (output.messages.length === originals.length) {
          event.messages = output.messages.map((message, index) =>
            messageFingerprint(message, false) === fingerprints[index]
              ? originals[index]
              : toPlainMessage(message),
          )
        } else if (output.messages.length > originals.length) {
          const prints = output.messages.map((message) => messageFingerprint(message, false))
          const diverged = prints.findIndex(
            (print, index) => index >= fingerprints.length || print !== fingerprints[index],
          )
          const stop = diverged === -1 ? output.messages.length : diverged
          event.messages = output.messages.map((message, index) =>
            index < stop && index < originals.length ? originals[index] : toPlainMessage(message),
          )
        } else {
          event.messages = output.messages.map((message) => toPlainMessage(message))
        }
      }
    })
    reporter.record("experimental.chat.messages.transform", "full", "V2 Message[] -> V1 {info,parts}[] pre-fill; originals kept whole only when the shape is unchanged, otherwise plain messages from the hook's own envelope")
  }

  /* ---------------- experimental.chat.system.transform ---------------- */
  const systemTransform = asHandler(table["experimental.chat.system.transform"])
  if (systemTransform) {
    await ctx.session.hook("context", async (event) => {
      // V1 sees `string[]`; V2 carries `SystemPart[]`
      // (`packages/ai/src/schema/messages.ts:21-27` - text parts with optional
      // cache/metadata). The write-back pairs entries with originals ONLY when
      // the pairing is provable: the same count (same positions), or a longer
      // array whose leading run the hook left byte-identical (an append). A
      // shorter array, or any divergence past the leading run, degrades to
      // plain `{ type: "text", text }` parts - same-index pairing there would
      // hand a surviving string the WRONG original's enrichment as soon as two
      // entries share a text.
      const system = (event.system ?? []) as unknown[]
      const originals = system.slice()
      const originalTexts = system.map((part) =>
        typeof part === "string" ? part : ((part as { text?: unknown } | null | undefined)?.text as string | undefined) ?? "",
      )
      const output = { system: originalTexts }
      await systemTransform({ sessionID: event.sessionID, model: event.model }, output)
      if (Array.isArray(output.system)) {
        if (output.system.length === originals.length) {
          event.system = output.system.map((text, index) =>
            text === originalTexts[index] ? originals[index] : { type: "text", text },
          )
        } else if (output.system.length > originals.length) {
          const diverged = output.system.findIndex(
            (text, index) => index >= originalTexts.length || text !== originalTexts[index],
          )
          const stop = diverged === -1 ? output.system.length : diverged
          event.system = output.system.map((text, index) =>
            index < stop && index < originals.length ? originals[index] : { type: "text", text },
          )
        } else {
          event.system = output.system.map((text) => ({ type: "text", text }))
        }
      }
    })
    reporter.record("experimental.chat.system.transform", "partial", "string[] <-> SystemPart[] round-trip; originals kept only when the shape is unchanged, otherwise plain text parts")
  }

  /* ---------------- experimental.session.compacting ---------------- */
  const compacting = asHandler(table["experimental.session.compacting"])
  if (compacting) {
    await ctx.session.hook("compaction", async (event) => {
      // V1 offers `output.prompt` as a full replacement of the compaction prompt,
      // but the V2 compaction event carries NO prompt field: SessionCompaction is
      // SessionContext (system/messages/options/tools) plus an optional pre-set
      // `result` (packages/plugin/src/promise/session.ts:45-48). There is no
      // destination to write to, so the replacement is accepted and ignored -
      // inventing one would be a lie. Only `context` (appended to system) lands.
      const output = { context: [] as string[], prompt: undefined as string | undefined }
      await compacting({ sessionID: event.sessionID }, output)
      if (Array.isArray(output.context)) {
        const system = (event.system ?? []) as Array<{ type?: string; text?: string }>
        for (const text of output.context) system.push({ type: "text", text })
      }
    })
    reporter.record("experimental.session.compacting", "partial", "context appended to compaction system; V1 prompt replacement has no V2 destination (SessionCompaction carries no prompt field)")
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
      "V2 session.execution.succeeded|failed|interrupted -> V1 session.idle envelope; other names/payloads pass through",
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
