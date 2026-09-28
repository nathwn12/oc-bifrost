/**
 * Compatibility matrix — the contract.
 *
 * One row per V1 hook. `level` is the promise oc-bifrost makes; `v2` names the
 * destination; `test` names the check that proves it. Anything not `full` says
 * so in the load-time report.
 *
 * Derived from OpenCode's own V1 -> V2 plugin migration guide, refined against
 * the V2 source (`packages/core/src/tool.ts` mutation write-back; the single
 * mutable event object; `execute.before` as the only rejecting hook).
 */
import type { SupportLevel } from "./types.js"

export interface MatrixRow {
  /** V1 hook key. */
  hook: string
  level: SupportLevel
  /** V2 destination, or the reason it is refused. */
  v2: string
  /** Test name that proves this row's behaviour. */
  test: string
}

export const COMPAT_MATRIX: readonly MatrixRow[] = [
  {
    hook: "tool.execute.before",
    level: "full",
    v2: 'ctx.tool.hook("execute.before")',
    test: "bridge: tool.execute.before mutates the executed input",
  },
  {
    hook: "tool.execute.after",
    level: "partial",
    v2: 'ctx.tool.hook("execute.after")',
    test: "bridge: tool.execute.after writes result.output and metadata",
  },
  {
    hook: "shell.env",
    level: "full",
    v2: 'ctx.shell.hook("create.before")',
    test: "bridge: shell.env merges into event.env",
  },
  {
    hook: "chat.params",
    level: "partial",
    v2: 'ctx.session.hook("context")',
    test: "bridge: chat.params maps onto context generation options",
  },
  {
    hook: "chat.headers",
    level: "full",
    v2: 'ctx.session.hook("model.request")',
    test: "bridge: chat.headers writes model.request headers",
  },
  {
    hook: "chat.message",
    level: "partial",
    v2: 'ctx.session.hook("prompt")',
    test: "bridge: chat.message registers a prompt hook",
  },
  {
    hook: "permission.ask",
    level: "full",
    v2: 'ctx.permission.hook("evaluate")',
    test: "bridge: permission.ask writes the evaluate effect",
  },
  {
    hook: "tool.definition",
    level: "partial",
    v2: "ctx.tool.transform",
    test: "bridge: tool.definition applies a snapshot through a transform",
  },
  {
    hook: "tool",
    level: "partial",
    v2: "ctx.tool.transform editor.add",
    test: "bridge: V1 tool map registers tools",
  },
  {
    hook: "event",
    level: "partial",
    v2: "ctx.event.subscribe()",
    test: "bridge: event hook registers a subscription",
  },
  {
    hook: "dispose",
    level: "full",
    v2: "setup cleanup return",
    test: "bridge: dispose runs on cleanup",
  },
  {
    hook: "experimental.chat.system.transform",
    level: "partial",
    v2: 'ctx.session.hook("context")',
    test: "bridge: string[] system transform round-trips",
  },
  {
    hook: "experimental.chat.messages.transform",
    level: "partial",
    v2: 'ctx.session.hook("context")',
    test: "bridge: messages transform registers a context hook",
  },
  {
    hook: "experimental.session.compacting",
    level: "partial",
    v2: 'ctx.session.hook("compaction")',
    test: "bridge: compacting appends context to the compaction system",
  },
  {
    hook: "config",
    level: "unsupported",
    v2: "per-domain transforms with different semantics",
    test: "bridge: config is refused out loud",
  },
  {
    hook: "auth",
    level: "unsupported",
    v2: "ctx.integration.transform + integration APIs",
    test: "bridge: auth is refused out loud",
  },
  {
    hook: "provider",
    level: "unsupported",
    v2: "ctx.provider.transform / ctx.model.transform",
    test: "bridge: provider is refused out loud",
  },
  {
    hook: "command.execute.before",
    level: "unsupported",
    v2: "no one-to-one global V2 hook",
    test: "bridge: command.execute.before is refused out loud",
  },
  {
    hook: "experimental.provider.small_model",
    level: "unsupported",
    v2: "no V2 equivalent",
    test: "bridge: small_model is refused out loud",
  },
  {
    hook: "experimental.compaction.autocontinue",
    level: "unsupported",
    v2: "no V2 equivalent",
    test: "bridge: autocontinue is refused out loud",
  },
  {
    hook: "experimental.text.complete",
    level: "unsupported",
    v2: "no V2 equivalent",
    test: "bridge: text.complete is refused out loud",
  },
] as const

export function matrixRow(hook: string): MatrixRow | undefined {
  return COMPAT_MATRIX.find((row) => row.hook === hook)
}
