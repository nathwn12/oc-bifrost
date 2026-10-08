import { test } from "node:test"
import assert from "node:assert/strict"
import { registerV1Hooks } from "../dist/hooks.js"
import { createReporter } from "../dist/report.js"

/** Minimal V2 context that records every registration. */
function fakeContext() {
  const registered = new Map()
  const record = (key, callback) => {
    const list = registered.get(key) ?? []
    list.push(callback)
    registered.set(key, list)
  }
  const subscriptions = []
  const queued = []
  let wake
  const ctx = {
    location: { directory: process.cwd(), project: { id: "test" } },
    options: {},
    app: { name: "opencode", version: "2.0.0", channel: "test" },
    tool: {
      hook: async (name, callback) => record(`tool:${name}`, callback),
      transform: async (callback) => record("tool:transform", callback),
      list: async () => [{ id: "shell", name: "shell", description: "d", input: {} }],
      reload: async () => {},
    },
    shell: { hook: async (name, callback) => record(`shell:${name}`, callback) },
    session: { hook: async (name, callback) => record(`session:${name}`, callback) },
    permission: { hook: async (name, callback) => record(`permission:${name}`, callback) },
    event: {
      subscribe: (options = {}) => {
        subscriptions.push(options)
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              if (queued.length === 0) await new Promise((resolve) => { wake = resolve })
              while (queued.length > 0) yield queued.shift()
            }
          },
        }
      },
    },
    storage: { get: async () => undefined, set: async () => {} },
  }
  const fire = async (key, event) => {
    for (const callback of registered.get(key) ?? []) await callback(event)
  }
  const pushEvent = (event) => {
    queued.push(event)
    wake?.()
    wake = undefined
  }
  return { ctx, registered, fire, subscriptions, pushEvent }
}

/**
 * A refused hook must be reported as unsupported out loud and must register
 * nothing on the V2 context — refusing is valid, faking is not.
 */
async function assertRefused(hook) {
  const { ctx, registered } = fakeContext()
  const reporter = createReporter(`refuse-${hook}`, {})
  await registerV1Hooks(ctx, { [hook]: async () => {} }, reporter)
  const report = reporter.reports.find((entry) => entry.hook === hook)
  assert.ok(report, `${hook} was never reported`)
  assert.equal(report.level, "unsupported", `${hook} must be refused, not bridged`)
  assert.equal(registered.size, 0, `${hook} must not register anything`)
}

test("bridge: tool.execute.before mutates the executed input", async () => {
  // Mirrors RTK's real plugin (`vendor/rtk.ts:20-21`): both-arms gate on the
  // tool name, then rewrite the command in place. The V1 hook sees `bash`
  // (the V1-era name) for a V2 `shell` execution, so the real vendor gate
  // matches.
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.before": async (input, output) => {
        const tool = String(input?.tool ?? "").toLowerCase()
        if (tool !== "bash" && tool !== "shell") return
        output.args.command = `rtk ${output.args.command}`
      },
    },
    createReporter("rtk", {}),
  )

  const event = { tool: "shell", sessionID: "s", agent: "a", messageID: "m", id: "c", input: { command: "git status" } }
  await fire("tool:execute.before", event)
  assert.equal(event.input.command, "rtk git status")
})

test("bridge: a V2 shell execution presents input.tool as the V1 bash name and the write-back still flows", async () => {
  const { ctx, fire } = fakeContext()
  const seen = []
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.before": async (input, output) => {
        seen.push(input.tool)
        output.args.command = `rtk ${output.args.command}`
      },
    },
    createReporter("alias", {}),
  )

  const event = { tool: "shell", sessionID: "s", agent: "a", messageID: "m", id: "c", input: { command: "git status" } }
  await fire("tool:execute.before", event)
  assert.deepEqual(seen, ["bash"])
  assert.equal(event.input.command, "rtk git status")
})

test("bridge: tool.execute.before writes a reassigned input.tool back onto the V2 event", async () => {
  // V2 reads `event.tool` back after the hook to select the executed tool
  // (`packages/core/src/tool.ts:271-280`: `input.definitions?.get(event.tool)`,
  // then `requested?.name ?? event.tool`), so a V1 `input.tool` reassignment
  // must land on the event - otherwise it is silently lost.
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.before": async (input, _output) => {
        input.tool = "read"
      },
    },
    createReporter("reassign", {}),
  )
  const event = { tool: "shell", sessionID: "s", agent: "a", messageID: "m", id: "c", input: { command: "ls" } }
  await fire("tool:execute.before", event)
  assert.equal(event.tool, "read")
})

test("bridge: tool.execute.before maps a reassigned bash back onto the V2 shell tool", async () => {
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.before": async (input, _output) => {
        input.tool = "bash"
      },
    },
    createReporter("reassign-alias", {}),
  )
  const event = { tool: "read", sessionID: "s", agent: "a", messageID: "m", id: "c", input: {} }
  await fire("tool:execute.before", event)
  assert.equal(event.tool, "shell")
})

test("bridge: tool.execute.before leaves event.tool alone when the V1 hook does not reassign it", async () => {
  // The V1 hook sees the aliased `bash` for a V2 `shell` execution; stamping
  // the presented name back unconditionally would corrupt `shell` into `bash`.
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.before": async (_input, output) => {
        output.args.command = "kept"
      },
    },
    createReporter("alias-safe", {}),
  )
  const event = { tool: "shell", sessionID: "s", agent: "a", messageID: "m", id: "c", input: { command: "ls" } }
  await fire("tool:execute.before", event)
  assert.equal(event.tool, "shell")
  assert.equal(event.input.command, "kept")
})

test("bridge: a throwing execute.before propagates (V1 reject semantics)", async () => {
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.before": async () => {
        throw new Error("blocked")
      },
    },
    createReporter("guard", {}),
  )
  await assert.rejects(() => fire("tool:execute.before", { tool: "shell", id: "c", input: {} }), /blocked/)
})

test("bridge: tool.execute.after writes result.output and metadata", async () => {
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.after": async (_input, output) => {
        output.output = "rewritten"
        output.metadata = { seen: true }
      },
    },
    createReporter("after", {}),
  )
  const event = { tool: "shell", id: "c", input: {}, status: "completed", result: { output: "original" } }
  await fire("tool:execute.after", event)
  assert.equal(event.result.output, "rewritten")
  assert.deepEqual(event.result.metadata, { seen: true })
})

test("bridge: tool.execute.after writes error.message and metadata on failure", async () => {
  // The V2 error branch carries a Tool.Error ({ message, metadata? } -
  // packages/schema/src/tool.ts:61-65), so the V1 string output lands on
  // error.message. Title has no destination on either branch.
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.after": async (_input, output) => {
        output.title = "ignored everywhere"
        output.output = "failure detail"
        output.metadata = { seen: true }
      },
    },
    createReporter("after", {}),
  )
  const event = { tool: "shell", id: "c", input: {}, status: "error", error: { message: "original" } }
  await fire("tool:execute.after", event)
  assert.equal(event.error.message, "failure detail")
  assert.deepEqual(event.error.metadata, { seen: true })
  assert.equal(event.title, undefined, "V1 title has no error-shape destination")

  // A no-op hook leaves the error untouched.
  const idleCtx = fakeContext()
  await registerV1Hooks(idleCtx.ctx, { "tool.execute.after": async () => {} }, createReporter("after", {}))
  const idle = { tool: "shell", id: "c", input: {}, status: "error", error: { message: "keep" } }
  await idleCtx.fire("tool:execute.after", idle)
  assert.deepEqual(idle.error, { message: "keep" })
})

test("bridge: shell.env merges into event.env", async () => {
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "shell.env": async (_input, output) => {
        output.env.COMPANY_ENV = "development"
      },
    },
    createReporter("env", {}),
  )
  const event = { command: "echo", cwd: ".", timeout: 0, shell: "sh", env: { PATH: "/bin" } }
  await fire("shell:create.before", event)
  assert.equal(event.env.COMPANY_ENV, "development")
  assert.equal(event.env.PATH, "/bin")
})

test("bridge: permission.ask writes the evaluate effect", async () => {
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "permission.ask": async (_input, output) => {
        output.status = "deny"
      },
    },
    createReporter("perm", {}),
  )
  const event = { sessionID: "s", action: "shell", resources: ["rm -rf /"], effect: "ask" }
  await fire("permission:evaluate", event)
  assert.equal(event.effect, "deny")
})

test("bridge: chat.headers writes model.request headers", async () => {
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "chat.headers": async (_input, output) => {
        output.headers["x-plugin"] = "review"
      },
    },
    createReporter("headers", {}),
  )
  const event = { sessionID: "s", model: {}, headers: { existing: "1" } }
  await fire("session:model.request", event)
  assert.equal(event.headers["x-plugin"], "review")
  assert.equal(event.headers.existing, "1")
})

test("bridge: dispose runs on cleanup", async () => {
  const { ctx } = fakeContext()
  let disposed = false
  const result = await registerV1Hooks(
    ctx,
    {
      dispose: async () => {
        disposed = true
      },
    },
    createReporter("dispose", {}),
  )
  for (const cleanup of result.cleanups) await cleanup()
  assert.equal(disposed, true)
})

test("bridge: config is refused out loud", async () => {
  await assertRefused("config")
})

/* ------------------------------------------------------------------ */
/* Rows below were reported by the compat-matrix audit as naming a test */
/* that did not exist; each one now exercises the real bridge path.     */
/* ------------------------------------------------------------------ */

test("bridge: chat.params maps onto context generation options", async () => {
  const { ctx, fire } = fakeContext()
  const seen = []
  await registerV1Hooks(
    ctx,
    {
      "chat.params": async (input, output) => {
        seen.push(input)
        output.temperature = 0.2
        output.topP = 0.9
        output.topK = 40
        output.maxOutputTokens = 512
        output.options.custom = "flag"
      },
    },
    createReporter("params", {}),
  )
  const event = {
    sessionID: "s",
    model: { id: "m" },
    options: { temperature: 1, topP: 1, topK: 0, maxTokens: 4096, keep: true },
  }
  await fire("session:context", event)
  assert.equal(seen[0].sessionID, "s")
  assert.equal(seen[0].model.id, "m")
  assert.equal(event.options.temperature, 0.2)
  assert.equal(event.options.topP, 0.9)
  assert.equal(event.options.topK, 40)
  assert.equal(event.options.maxTokens, 512)
  assert.equal(event.options.custom, "flag")
  assert.equal(event.options.keep, true, "unrelated options must survive")
})

test("bridge: chat.message registers a prompt hook", async () => {
  const { ctx, fire } = fakeContext()
  const seen = []
  await registerV1Hooks(
    ctx,
    {
      "chat.message": async (input, output) => {
        seen.push(input)
        // The V1 hook sees the message text pre-filled as a text part.
        const part = output.parts.find((entry) => entry.type === "text")
        if (part) part.text = "rewritten"
      },
    },
    createReporter("message", {}),
  )
  const event = { sessionID: "s", messageID: "m", prompt: { text: "original" } }
  await fire("session:prompt", event)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionID, "s")
  assert.equal(seen[0].messageID, "m")
  // The V1 text rewrite lands on the V2 prompt event: changed text parts are joined.
  assert.equal(event.prompt.text, "rewritten")
  assert.equal(event.parts, undefined, "the V1 parts envelope itself is not injected")
})

test("bridge: chat.message is idempotent for a no-op hook", async () => {
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    { "chat.message": async () => {} },
    createReporter("message", {}),
  )
  const event = { sessionID: "s", messageID: "m", prompt: { text: "original" } }
  await fire("session:prompt", event)
  assert.equal(event.prompt.text, "original", "a no-op hook leaves the pre-filled text untouched")
})

test("bridge: chat.message message.content replaces prompt text; partial parts are not injected", async () => {
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "chat.message": async (input, output) => {
        output.message = { role: "user", content: "whole replacement" }
        output.parts = [{ type: "text", text: "partial" }]
      },
    },
    createReporter("message", {}),
  )
  const event = { sessionID: "s", messageID: "m", prompt: { text: "original" } }
  await fire("session:prompt", event)
  assert.equal(event.prompt.text, "whole replacement")
})

test("bridge: chat.message ignores a non-text write-back", async () => {
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "chat.message": async (input, output) => {
        output.parts = [{ type: "tool", text: "not a text part" }, { text: "untyped" }]
      },
    },
    createReporter("message", {}),
  )
  const event = { sessionID: "s", messageID: "m", prompt: { text: "original" } }
  await fire("session:prompt", event)
  assert.equal(event.prompt.text, "original", "only text parts are joined; nothing else is written")
})

test("bridge: chat.message writes prompt files, agents and skills", async () => {
  // V2 carries attachments on the prompt event (packages/core/src/session/
  // prompt.ts:40-52). The V1 hook sees them pre-filled on the synthetic message;
  // a reassignment lands back on the prompt, a no-op writes nothing.
  const { ctx, fire } = fakeContext()
  const seen = []
  await registerV1Hooks(
    ctx,
    {
      "chat.message": async (input, output) => {
        seen.push(input)
        assert.deepEqual(
          output.message.files,
          [{ uri: "file:///old.ts" }],
          "the V2 attachments arrive pre-filled on the message",
        )
        output.message.content = "rewritten"
        output.message.files = [{ uri: "file:///a.ts", name: "a.ts" }]
        output.message.agents = [{ id: "agent-1" }]
        output.message.skills = [{ id: "skill-1" }]
      },
    },
    createReporter("message", {}),
  )
  const event = {
    sessionID: "s",
    messageID: "m",
    prompt: { text: "original", files: [{ uri: "file:///old.ts" }], agents: [], skills: [] },
  }
  await fire("session:prompt", event)
  assert.equal(seen.length, 1)
  assert.equal(event.prompt.text, "rewritten")
  assert.deepEqual(event.prompt.files, [{ uri: "file:///a.ts", name: "a.ts" }])
  assert.deepEqual(event.prompt.agents, [{ id: "agent-1" }])
  assert.deepEqual(event.prompt.skills, [{ id: "skill-1" }])

  // An in-place push shares the pre-filled array, so it lands with no write-back.
  const pushCtx = fakeContext()
  await registerV1Hooks(
    pushCtx.ctx,
    {
      "chat.message": async (input, output) => {
        output.message.files.push({ uri: "file:///b.ts" })
      },
    },
    createReporter("message", {}),
  )
  const pushed = { sessionID: "s", messageID: "m", prompt: { text: "t", files: [] } }
  await pushCtx.fire("session:prompt", pushed)
  assert.deepEqual(pushed.prompt.files, [{ uri: "file:///b.ts" }])

  // A no-op hook is idempotent across every prompt field.
  const idleCtx = fakeContext()
  await registerV1Hooks(idleCtx.ctx, { "chat.message": async () => {} }, createReporter("message", {}))
  const idle = {
    sessionID: "s",
    messageID: "m",
    prompt: { text: "keep", files: [{ uri: "file:///k.ts" }], agents: [{ id: "a" }], skills: [{ id: "sk" }] },
  }
  const snapshot = structuredClone(idle.prompt)
  await idleCtx.fire("session:prompt", idle)
  assert.deepEqual(idle.prompt, snapshot)
})

test("bridge: tool.definition applies a snapshot through a transform", async () => {
  const { ctx, registered } = fakeContext()
  const seen = []
  await registerV1Hooks(
    ctx,
    {
      "tool.definition": async (input, output) => {
        seen.push({ toolID: input.toolID, description: output.description })
        if (input.toolID !== "shell") return
        output.description = "listed shell"
        output.parameters = { type: "object", properties: { command: { type: "string" } } }
      },
    },
    createReporter("definition", {}),
  )
  assert.deepEqual(seen, [{ toolID: "shell", description: "d" }], "the listed tool is snapshotted at register time")

  const tool = { id: "shell", name: "shell", description: "d", input: {} }
  const editor = {
    update: (id, apply) => {
      if (id === tool.id) apply(tool)
    },
  }
  const [transform] = registered.get("tool:transform")
  transform(editor)
  assert.equal(tool.description, "listed shell")
  assert.deepEqual(tool.input, { type: "object", properties: { command: { type: "string" } } })
})

test("bridge: V1 tool map registers tools", async () => {
  const { ctx, registered } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      tool: {
        echo: {
          description: "echo tool",
          args: { type: "object", properties: { text: { type: "string" } } },
          execute: async (args) => `echo:${args.text}`,
        },
        objectResult: {
          execute: async () => ({ content: "object" }),
        },
      },
    },
    createReporter("tools", {}),
  )
  const added = []
  const editor = { add: (tool) => added.push(tool) }
  const [transform] = registered.get("tool:transform")
  transform(editor)

  assert.equal(added.length, 2)
  const echo = added.find((tool) => tool.name === "echo")
  assert.equal(echo.description, "echo tool")
  assert.deepEqual(echo.input, { type: "object", properties: { text: { type: "string" } } })
  assert.deepEqual(await echo.execute({ text: "hi" }), { content: "echo:hi" })

  const objectResult = added.find((tool) => tool.name === "objectResult")
  assert.equal(objectResult.description, "objectResult", "a missing description defaults to the tool name")
  assert.deepEqual(objectResult.input, { type: "object", properties: {}, additionalProperties: true })
  assert.deepEqual(await objectResult.execute({}), { content: "object" }, "object results pass through")
})

test("bridge: event hook registers a subscription", async () => {
  const { ctx, subscriptions, pushEvent } = fakeContext()
  const seen = []
  let firstDelivered
  let lastDelivered
  const first = new Promise((resolve) => { firstDelivered = resolve })
  const last = new Promise((resolve) => { lastDelivered = resolve })
  const warnings = []
  const reporter = createReporter("events", {})
  const warn = reporter.warn.bind(reporter)
  reporter.warn = (message) => {
    warnings.push(message)
    warn(message)
  }

  const result = await registerV1Hooks(
    ctx,
    {
      event: async ({ event }) => {
        seen.push(event)
        if (seen.length === 1) firstDelivered()
        if (event.id === "boom") throw new Error("handler exploded")
        if (event.id === "two") lastDelivered()
      },
    },
    reporter,
  )

  assert.equal(subscriptions.length, 1)
  assert.ok(subscriptions[0].signal instanceof AbortSignal, "the subscription must be abortable")

  pushEvent({ id: "one" })
  await first
  pushEvent({ id: "boom" })
  pushEvent({ id: "two" })
  await last

  assert.deepEqual(
    seen.map((event) => event.id),
    ["one", "boom", "two"],
    "a throwing hook must warn and leave the subscription running",
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /handler exploded/)

  for (const cleanup of result.cleanups) await cleanup()
  assert.equal(subscriptions[0].signal.aborted, true, "cleanup must abort the subscription")
})

test("bridge: terminal execution events are synthesised to the V1 session.idle envelope", async () => {
  const { ctx, pushEvent } = fakeContext()
  const seen = []
  let delivered
  const all = new Promise((resolve) => { delivered = resolve })
  const result = await registerV1Hooks(
    ctx,
    {
      event: async ({ event }) => {
        seen.push(event)
        if (seen.length === 5) delivered()
      },
    },
    createReporter("idle", {}),
  )

  // Every terminal execution event is the V2 idle signal - the same three
  // events the client itself converges on (packages/client/src/solid/data.ts:
  // 1025-1028, and packages/schema/src/session-event.ts:246-257).
  pushEvent({ id: "evt_done", created: 1, type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
  pushEvent({ id: "evt_fail", created: 2, type: "session.execution.failed", data: { sessionID: "ses_b", error: { message: "boom" } } })
  pushEvent({ id: "evt_stop", created: 3, type: "session.execution.interrupted", data: { sessionID: "ses_a", reason: "user" } })
  // The deprecated session.idle event is still emitted and keeps its own name.
  pushEvent({ id: "evt_legacy", created: 4, type: "session.idle", data: { sessionID: "ses_c" } })
  // Anything else passes through untouched: only idle has a V1 name to land on.
  pushEvent({ id: "evt_started", created: 5, type: "session.execution.started", data: { sessionID: "ses_a" } })
  await all

  assert.equal(seen.length, 5)
  assert.equal(seen[0].type, "session.idle")
  assert.deepEqual(seen[0].properties, { sessionID: "ses_a" })
  assert.equal(seen[0].id, "evt_done", "the V2 payload is preserved alongside the V1 envelope")
  assert.equal(seen[1].type, "session.idle")
  assert.deepEqual(seen[1].properties, { sessionID: "ses_b" })
  assert.ok("error" in seen[1].data, "the failed payload keeps its error detail")
  assert.equal(seen[2].type, "session.idle")
  assert.deepEqual(seen[2].properties, { sessionID: "ses_a" })
  assert.equal(seen[2].id, "evt_stop")
  assert.equal(seen[3].type, "session.idle")
  assert.deepEqual(seen[3].properties, { sessionID: "ses_c" })
  assert.equal(seen[4].type, "session.execution.started")
  assert.deepEqual(seen[4].data, { sessionID: "ses_a" })

  for (const cleanup of result.cleanups) await cleanup()
})

test("bridge: string[] system transform round-trips", async () => {
  const { ctx, fire } = fakeContext()
  const seen = []
  await registerV1Hooks(
    ctx,
    {
      "experimental.chat.system.transform": async (input, output) => {
        seen.push({ input, system: [...output.system] })
        output.system = ["first", ...output.system.slice(1), "appended"]
      },
    },
    createReporter("system", {}),
  )
  const event = {
    sessionID: "s",
    model: { id: "m" },
    system: [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }],
  }
  await fire("session:context", event)
  assert.equal(seen[0].input.sessionID, "s")
  assert.deepEqual(seen[0].system, ["alpha", "beta"], "V1 receives the system as a string[]")
  assert.deepEqual(event.system, [
    { type: "text", text: "first" },
    { type: "text", text: "beta" },
    { type: "text", text: "appended" },
  ])
})

test("bridge: system transform preserves untouched parts", async () => {
  // V2 parts may carry enrichment (cache/metadata) or a non-text shape; the
  // index-aligned write-back keeps whatever the V1 hook did not touch whole.
  const { ctx, fire } = fakeContext()
  const seen = []
  const enriched = { type: "text", text: "alpha", cache: { key: "k" }, metadata: { source: "t" } }
  const foreign = { type: "other", text: "beta", custom: true }
  await registerV1Hooks(
    ctx,
    {
      "experimental.chat.system.transform": async (input, output) => {
        seen.push({ input, system: [...output.system] })
        output.system = [output.system[0], "BETA!", "appended"]
      },
    },
    createReporter("system", {}),
  )
  const event = { sessionID: "s", model: { id: "m" }, system: [enriched, foreign] }
  await fire("session:context", event)
  assert.deepEqual(seen[0].system, ["alpha", "beta"], "V1 still sees the system as a string[]")
  assert.ok(event.system[0] === enriched, "an untouched part keeps its whole original object (cache/metadata survive)")
  assert.deepEqual(event.system[1], { type: "text", text: "BETA!" }, "an edited entry collapses to a plain text part")
  assert.deepEqual(event.system[2], { type: "text", text: "appended" })
})

test("bridge: system transform removal degrades to plain parts instead of misattributing originals", async () => {
  // Duplicate strings prove the pairing: two identical texts carry different
  // enrichment, so same-index mapping would hand the survivor the REMOVED
  // part's object. A shorter shape is never index-paired.
  const { ctx, fire } = fakeContext()
  const enriched = { type: "text", text: "dup", cache: { key: "k" }, metadata: { source: "t" } }
  await registerV1Hooks(
    ctx,
    {
      "experimental.chat.system.transform": async (_input, output) => {
        output.system = output.system.slice(1)
      },
    },
    createReporter("system", {}),
  )
  const event = { sessionID: "s", model: { id: "m" }, system: [enriched, { type: "text", text: "dup" }] }
  await fire("session:context", event)
  assert.equal(event.system.length, 1)
  assert.ok(event.system[0] !== enriched, "the surviving string must not inherit the removed part's enrichment")
  assert.deepEqual(event.system[0], { type: "text", text: "dup" })
})

test("bridge: system transform append preserves existing originals", async () => {
  const { ctx, fire } = fakeContext()
  const enriched = { type: "text", text: "alpha", cache: { key: "k" }, metadata: { source: "t" } }
  const second = { type: "text", text: "beta" }
  await registerV1Hooks(
    ctx,
    {
      "experimental.chat.system.transform": async (_input, output) => {
        output.system.push("appended")
      },
    },
    createReporter("system", {}),
  )
  const event = { sessionID: "s", model: { id: "m" }, system: [enriched, second] }
  await fire("session:context", event)
  assert.ok(event.system[0] === enriched, "an untouched leading part keeps its whole original object")
  assert.ok(event.system[1] === second, "an untouched leading part keeps its whole original object")
  assert.deepEqual(event.system[2], { type: "text", text: "appended" })
})

test("bridge: tool.execute.before warns on a non-string input.tool reassignment", async () => {
  const { ctx, fire } = fakeContext()
  const warnings = []
  const reporter = createReporter("tool-guard", {})
  const warn = reporter.warn.bind(reporter)
  reporter.warn = (message) => {
    warnings.push(message)
    warn(message)
  }
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.before": async (input, _output) => {
        input.tool = 42
      },
    },
    reporter,
  )
  const event = { tool: "shell", sessionID: "s", agent: "a", messageID: "m", id: "c", input: { command: "ls" } }
  await fire("tool:execute.before", event)
  assert.equal(event.tool, "shell", "a non-string reassignment must not land on the event")
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /non-string input\.tool/)
})

test("bridge: messages transform round-trips the V1 {info,parts} envelope", async () => {
  // Mirrors BOTH real V1 plugins at once — model-announcer unshifts a synthetic
  // part onto the last USER message's parts; agent-identity pairs messages.transform
  // (stores info.agent by session) with system.transform (appends the identity
  // line) and depends on messages firing FIRST in V1.
  const { ctx, fire } = fakeContext()
  const seen = []
  const models = []
  const agentBySession = new Map()
  const order = []
  await registerV1Hooks(
    ctx,
    {
      "experimental.chat.messages.transform": async (input, output) => {
        seen.push(input)
        order.push("messages")
        const lastUser = output.messages.findLast((m) => m.info.role === "user")
        assert.ok(lastUser, "pre-filled V1 envelope must expose the user message")
        assert.equal(lastUser.info.role, "user")
        assert.equal(lastUser.info.id, "m1")
        assert.equal(lastUser.info.sessionID, "s")
        assert.equal(lastUser.info.agent, "build")
        models.push(lastUser.info.model)
        lastUser.parts.unshift({
          type: "text",
          text: "[SYSTEM: CURRENT_MODEL_ANNOUNCEMENT - You are opencode-go/deepseek-v4-flash.]",
          synthetic: true,
        })
        if (lastUser.info.agent) agentBySession.set(lastUser.info.sessionID, lastUser.info.agent)
      },
      "experimental.chat.system.transform": async (input, output) => {
        order.push("system")
        if (!input.sessionID) return
        const agent = agentBySession.get(input.sessionID)
        if (!agent) return
        output.system.push(`You are currently operating as the "${agent}" agent.`)
      },
    },
    createReporter("messages", {}),
  )
  const v2Messages = [
    { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "hi" }] },
    { id: "m1", role: "user", content: [{ type: "text", text: "hello" }] },
  ]
  const event = {
    sessionID: "s",
    agent: "build",
    // The real V2 Model.Ref shape (packages/schema/src/model.ts:18-22): `id` is
    // the BARE model id; the provider is the separate `providerID` field.
    model: { id: "deepseek-v4-flash", providerID: "opencode-go", variant: "max" },
    messages: v2Messages,
    system: [],
  }
  await fire("session:context", event)
  assert.deepEqual(seen[0], { sessionID: "s" }, "the V1 hook input carries sessionID")
  assert.deepEqual(
    models[0],
    { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    "Model.Ref providerID + bare id must pre-fill info.model",
  )
  // Write-back: the synthetic part landed on the LAST USER message's content.
  assert.equal(event.messages[1].content[0].text, "[SYSTEM: CURRENT_MODEL_ANNOUNCEMENT - You are opencode-go/deepseek-v4-flash.]")
  assert.equal(event.messages[1].content[0].synthetic, true)
  assert.equal(event.messages[1].content[0].type, "text")
  // The assistant message is untouched — parts round-trip in place.
  assert.equal(event.messages[0].id, "assistant-1")
  assert.equal(event.messages[0].role, "assistant")
  assert.deepEqual(event.messages[0].content, [{ type: "text", text: "hi" }])
  // V1 fire order: messages.transform runs before system.transform.
  assert.deepEqual(order.slice(0, 2), ["messages", "system"], "messages.transform must register before system.transform")
  // The system write-back carried the agent stored by messages.transform.
  assert.deepEqual(event.system, [
    { type: "text", text: 'You are currently operating as the "build" agent.' },
  ])

  // Fallback: a string-only id still splits on the first '/' (nested ids keep the rest).
  const stringOnlyEvent = {
    sessionID: "s",
    agent: "build",
    model: { id: "opencode-go/deepseek/deepseek-chat" },
    messages: v2Messages.map((m) => ({
      ...m,
      content: m.content.map((part) => ({ ...part })),
    })),
    system: [],
  }
  await fire("session:context", stringOnlyEvent)
  assert.deepEqual(
    models[1],
    { providerID: "opencode-go", modelID: "deepseek/deepseek-chat" },
    "string-only Model.Ref id must split on the first '/' with nested ids kept as modelID",
  )
})

test("bridge: messages transform removal degrades to plain messages instead of misattributing originals", async () => {
  // Duplicate texts prove the pairing: two messages with identical parts carry
  // different V2-side fields, so same-index mapping would hand the survivor the
  // REMOVED message's object. A shorter shape is never index-paired.
  const { ctx, fire } = fakeContext()
  const enriched = {
    role: "user",
    id: "m1",
    content: [{ type: "text", text: "dup" }],
    custom: { flag: true },
  }
  await registerV1Hooks(
    ctx,
    {
      "experimental.chat.messages.transform": async (_input, output) => {
        output.messages = output.messages.slice(1)
      },
    },
    createReporter("messages", {}),
  )
  const event = {
    sessionID: "s",
    agent: "build",
    model: { id: "m", providerID: "p" },
    messages: [enriched, { role: "user", id: "m2", content: [{ type: "text", text: "dup" }] }],
    system: [],
  }
  await fire("session:context", event)
  assert.equal(event.messages.length, 1)
  assert.ok(event.messages[0] !== enriched, "the surviving message must not inherit the removed message's object")
  assert.deepEqual(event.messages[0], {
    role: "user",
    id: "m2",
    content: [{ type: "text", text: "dup" }],
  })
})

test("bridge: messages transform degraded write-back always carries a string role and no sessionID", async () => {
  // V2 Message REQUIRES role (packages/ai/src/schema/messages.ts:238) and has
  // no sessionID field (messages.ts:236-243): a hook-supplied envelope without
  // a role degrades to role "user" (never the positionally-paired original's
  // role), and info.sessionID never lands on the message.
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "experimental.chat.messages.transform": async (_input, output) => {
        output.messages = [
          { info: {}, parts: [{ type: "text", text: "role-less" }] },
          { info: { sessionID: "s" }, parts: [{ type: "text", text: "session-scoped" }] },
        ]
      },
    },
    createReporter("messages", {}),
  )
  const event = {
    sessionID: "s",
    agent: "build",
    model: { id: "m", providerID: "p" },
    messages: [
      { role: "assistant", id: "m1", content: [{ type: "text", text: "hi" }] },
      { role: "user", id: "m2", content: [{ type: "text", text: "hello" }] },
    ],
    system: [],
  }
  await fire("session:context", event)
  assert.equal(event.messages.length, 2)
  for (const message of event.messages) {
    assert.equal(typeof message.role, "string", "every degraded message must carry a string role")
    assert.equal("sessionID" in message, false, "sessionID is not a V2 Message field and must not land on the message")
  }
  assert.deepEqual(event.messages[0], { role: "user", content: [{ type: "text", text: "role-less" }] })
  assert.deepEqual(event.messages[1], { role: "user", content: [{ type: "text", text: "session-scoped" }] })
})

test("bridge: messages transform append preserves existing originals", async () => {
  const { ctx, fire } = fakeContext()
  const first = { role: "user", id: "m1", content: [{ type: "text", text: "hello" }] }
  const second = { role: "assistant", id: "m2", content: [{ type: "text", text: "hi" }] }
  await registerV1Hooks(
    ctx,
    {
      "experimental.chat.messages.transform": async (_input, output) => {
        output.messages.push({ info: { role: "user" }, parts: [{ type: "text", text: "appended" }] })
      },
    },
    createReporter("messages", {}),
  )
  const event = { sessionID: "s", model: { id: "m" }, messages: [first, second], system: [] }
  await fire("session:context", event)
  assert.equal(event.messages.length, 3)
  assert.ok(event.messages[0] === first, "an untouched leading message keeps its whole original object")
  assert.ok(event.messages[1] === second, "an untouched leading message keeps its whole original object")
  assert.deepEqual(event.messages[2], { role: "user", content: [{ type: "text", text: "appended" }] })
})

test("bridge: compacting appends context to the compaction system", async () => {
  const { ctx, fire } = fakeContext()
  const seen = []
  await registerV1Hooks(
    ctx,
    {
      "experimental.session.compacting": async (input, output) => {
        seen.push({ input, context: [...output.context] })
        output.context.push("remember the plan")
        output.prompt = "replacement prompt"
      },
    },
    createReporter("compacting", {}),
  )
  const event = { sessionID: "s", system: [{ type: "text", text: "base" }] }
  await fire("session:compaction", event)
  assert.deepEqual(seen[0].input, { sessionID: "s" })
  assert.deepEqual(seen[0].context, [])
  assert.deepEqual(event.system, [
    { type: "text", text: "base" },
    { type: "text", text: "remember the plan" },
  ])
  assert.equal(
    "prompt" in event,
    false,
    "the V2 compaction event carries no prompt field (SessionCompaction is system/messages/options/tools + result), so the V1 replacement must not leak onto the event",
  )
})

test("bridge: auth is refused out loud", async () => {
  await assertRefused("auth")
})

test("bridge: provider is refused out loud", async () => {
  await assertRefused("provider")
})

test("bridge: command.execute.before is refused out loud", async () => {
  await assertRefused("command.execute.before")
})

test("bridge: small_model is refused out loud", async () => {
  await assertRefused("experimental.provider.small_model")
})

test("bridge: autocontinue is refused out loud", async () => {
  await assertRefused("experimental.compaction.autocontinue")
})

test("bridge: text.complete is refused out loud", async () => {
  await assertRefused("experimental.text.complete")
})
