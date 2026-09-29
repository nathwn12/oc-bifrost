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
  // Mirrors RTK's real plugin: rewrite the command in place.
  const { ctx, fire } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      "tool.execute.before": async (input, output) => {
        if (!String(input.tool).includes("shell")) return
        output.args.command = `rtk ${output.args.command}`
      },
    },
    createReporter("rtk", {}),
  )

  const event = { tool: "shell", sessionID: "s", agent: "a", messageID: "m", id: "c", input: { command: "git status" } }
  await fire("tool:execute.before", event)
  assert.equal(event.input.command, "rtk git status")
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
