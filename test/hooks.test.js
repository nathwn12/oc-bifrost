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
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    storage: { get: async () => undefined, set: async () => {} },
  }
  const fire = async (key, event) => {
    for (const callback of registered.get(key) ?? []) await callback(event)
  }
  return { ctx, registered, fire }
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
  const { ctx } = fakeContext()
  const reporter = createReporter("refuse", {})
  await registerV1Hooks(ctx, { config: async () => {} }, reporter)
  assert.equal(reporter.reports[0].level, "unsupported")
  assert.equal(reporter.reports[0].hook, "config")
})
