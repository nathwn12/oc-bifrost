import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { buildV1Context } from "../dist/context.js"
import { discover } from "../dist/discover.js"
import { registerV1Hooks } from "../dist/hooks.js"
import { createReporter } from "../dist/report.js"

/**
 * The live dogfood plugin: eserete/opencode-token-tracker, mounted from the
 * bridge's GitHub cache. The suite exercises the real file when the cache tree
 * is present and skips elsewhere; nothing is stubbed about the plugin itself.
 */
const trackerPath = path.join(
  os.homedir(),
  ".cache",
  "opencode",
  "oc-bifrost",
  "github",
  "v2",
  "eserete--opencode-token-tracker--main--token-tracker.js-ecd8b84835a85578",
  "tree",
  "token-tracker.js",
)
const available = existsSync(trackerPath)

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

/** Minimal V2 context with a driven event subscription. */
function fakeContext(messages) {
  const contextCalls = []
  const queued = []
  let wake
  const ctx = {
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
    session: {
      hook: async () => {},
      context: async (input) => {
        contextCalls.push(input)
        return messages
      },
    },
    permission: { hook: async () => {} },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queued.length === 0) await new Promise((resolve) => { wake = resolve })
            while (queued.length > 0) yield queued.shift()
          }
        },
      }),
    },
    storage: { get: async () => undefined, set: async () => {} },
  }
  const pushEvent = (event) => {
    queued.push(event)
    wake?.()
    wake = undefined
  }
  return { ctx, contextCalls, pushEvent }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the tracker")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test(
  "bridge: the real token-tracker.js fetches tokens and stops at the refused children call",
  { skip: !available && "token-tracker cache tree not present" },
  async () => {
    const lines = []
    const reporter = createReporter("token-tracker", { sink: (line) => lines.push(line) })
    const { ctx, contextCalls, pushEvent } = fakeContext([assistant])

    const module = await import(pathToFileURL(trackerPath).href)
    const shape = discover(module, trackerPath)
    assert.equal(shape.kind, "v1", "the tracker is recognised as a V1 factory")
    assert.equal(shape.factory, module.TokenTrackerPlugin)

    const v1Context = buildV1Context(ctx, reporter)
    const hooks = await shape.factory(v1Context)
    const registered = await registerV1Hooks(ctx, hooks, reporter)

    pushEvent({
      id: "evt_idle",
      created: 1,
      type: "session.execution.succeeded",
      data: { sessionID: "ses_main" },
    })

    await waitFor(() => contextCalls.length > 0)
    await waitFor(() => lines.some((line) => line.includes("client.session.children is not provided")))

    assert.deepEqual(
      contextCalls,
      [{ sessionID: "ses_main" }],
      "the synthesised session.idle event reached the tracker and it fetched the session's messages",
    )
    assert.ok(
      lines.some((line) => line.includes("client.tui.* is refused")),
      "the toast refusal is announced when the facade is built",
    )
    assert.ok(
      lines.some((line) => line.includes("client.session.children is refused")),
      "the child-listing refusal is announced when the facade is built",
    )
    assert.equal(
      lines.some((line) => line.includes("client.tui.showToast is not provided")),
      false,
      "the tracker never reaches the toast call: the earlier children refusal aborts its try block",
    )
    assert.equal(
      lines.some((line) => line.includes("event hook threw")),
      false,
      "the refusal never escapes the bridge: the tracker swallows it with its own blanket catch",
    )

    for (const cleanup of registered.cleanups) await cleanup()
  },
)
