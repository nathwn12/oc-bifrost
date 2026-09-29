import { test } from "node:test"
import assert from "node:assert/strict"
import { buildV1Context } from "../dist/context.js"
import { createReporter } from "../dist/report.js"

/** Minimal V2 context. `session.context` is the one message read the facade maps. */
function fakeContext({ messages = [], context = true } = {}) {
  const calls = []
  const session = { hook: async () => {} }
  if (context) {
    session.context = async (input) => {
      calls.push(input)
      return messages
    }
  }
  return {
    calls,
    ctx: {
      location: { directory: process.cwd(), project: { id: "test" } },
      options: {},
      app: { name: "opencode", version: "2.0.0", channel: "test" },
      tool: {
        hook: async () => {},
        transform: async () => {},
        list: async () => [],
        reload: async () => {},
      },
      shell: { hook: async () => {} },
      session,
      permission: { hook: async () => {} },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {},
        }),
      },
      storage: { get: async () => undefined, set: async () => {} },
    },
  }
}

function facadeFor(options) {
  const { ctx, calls } = fakeContext(options)
  const lines = []
  const reporter = createReporter("facade", { sink: (line) => lines.push(line) })
  const facade = buildV1Context(ctx, reporter)
  return { client: facade.client, calls, lines }
}

/** A V2 projected assistant message, per packages/schema/src/session-message.ts:212-236. */
const assistant = {
  id: "msg_a1",
  type: "assistant",
  agent: "build",
  model: { id: "deepseek-v4-flash", providerID: "opencode-go", variant: "max" },
  content: [{ type: "text", text: "done" }],
  finish: "end_turn",
  cost: 0.42,
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
  time: { created: 1000, completed: 1500 },
}

test("facade: session.messages returns the V1 envelope with tokens", async () => {
  const { client, calls } = facadeFor({ messages: [assistant] })

  const response = await client.session.messages({ path: { id: "ses_main" } })

  assert.deepEqual(calls, [{ sessionID: "ses_main" }], "the V1 { path: { id } } shape maps to V2 { sessionID }")
  assert.equal(Array.isArray(response.data), true)
  assert.equal(response.data.length, 1)

  const message = response.data[0]
  assert.equal(message.info.id, "msg_a1")
  assert.equal(message.info.role, "assistant", "V2 `type` becomes the V1 `role`")
  assert.equal(message.info.providerID, "opencode-go")
  assert.equal(message.info.modelID, "deepseek-v4-flash", "the bare Model.Ref id becomes the V1 modelID")
  assert.deepEqual(message.info.tokens, assistant.tokens)
  assert.deepEqual(message.info.time, assistant.time)
  assert.equal(message.info.cost, 0.42)
  assert.equal(message.info.finish, "end_turn")
  assert.deepEqual(message.parts, assistant.content, "V2 content becomes the V1 parts array")
})

test("facade: session.messages refuses loudly without a V2 context read", async () => {
  const { client, lines } = facadeFor({ context: false })

  await assert.rejects(
    () => client.session.messages({ path: { id: "ses_main" } }),
    /client\.session\.messages is not supported on the V2 runtime/,
  )
  assert.ok(
    lines.some((line) => line.includes("client.session.messages is not provided")),
    "the refusal must be reported",
  )
})

test("facade: session.children is refused out loud", () => {
  const { client, lines } = facadeFor()

  assert.equal(typeof client.session.children, "function")
  assert.throws(
    () => client.session.children({ path: { id: "ses_main" } }),
    /client\.session\.children is not supported on the V2 runtime/,
  )
  assert.ok(
    lines.some((line) => line.includes("client.session.children is refused")),
    "the child-listing refusal is announced at load time",
  )
})

test("facade: tui.showToast is refused out loud", () => {
  const { client, lines } = facadeFor()

  assert.equal(typeof client.tui.showToast, "function")
  assert.throws(
    () => client.tui.showToast({ body: { message: "hi", variant: "success", duration: 1000 } }),
    /client\.tui\.showToast is not supported on the V2 runtime/,
  )
  assert.ok(
    lines.some((line) => line.includes("client.tui.* is refused")),
    "the toast refusal is announced at load time",
  )
})

test("facade: still-refused domains throw unsupported", () => {
  const { client } = facadeFor()

  for (const domain of ["auth", "provider", "config", "file", "find", "event", "command"]) {
    assert.throws(
      () => client[domain].anything(),
      new RegExp(`client\\.${domain}\\.anything is not supported on the V2 runtime`),
      `${domain} must stay refused`,
    )
  }
})
