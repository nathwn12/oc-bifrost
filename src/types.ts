/**
 * oc-bifrost — shared types.
 *
 * The V1 side is the real published contract from `@opencode-ai/plugin`.
 * The V2 side is described structurally so this package compiles against any
 * `@opencode/plugin` >= 2.0 without pinning internal subpaths.
 */
import type { Hooks as V1Hooks, PluginInput as V1PluginInput, Plugin as V1Plugin } from "@opencode-ai/plugin"

export type { V1Hooks, V1PluginInput, V1Plugin }

/** A plugin entry as declared in oc-bifrost's own options. */
export type PluginEntry = string | { spec: string; options?: Record<string, unknown> }

export interface BifrostOptions {
  /** Plugins to bridge. V1-era factories and V2-era definitions are both accepted. */
  plugins?: PluginEntry[]
  /**
   * When true, setup aborts instead of warning-and-skipping: an unsupported V1
   * hook, or any entry that cannot be resolved, imported, or mounted. Without it,
   * a bad entry is skipped so the remaining plugins still mount.
   */
  strict?: boolean
  /** Emit a compatibility report to the console on load. Defaults to true. */
  verbose?: boolean
}

export type SupportLevel = "full" | "partial" | "unsupported" | "mounted"

export interface HookReport {
  hook: string
  level: SupportLevel
  note?: string
}

/* ------------------------------------------------------------------ */
/* Structural V2 surface (what oc-bifrost itself uses)                 */
/* ------------------------------------------------------------------ */

export interface ToolExecuteBefore {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: unknown
  input: unknown
}

export interface ToolExecuteAfter {
  readonly tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: unknown
  readonly input: unknown
  readonly status: "completed" | "error"
  result?: { output?: unknown; content?: unknown; metadata?: unknown }
  error?: { message?: string }
}

export interface ShellCreateBefore {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

export interface ToolEditor {
  list(): readonly { id: string; name: string; description?: string; input?: unknown }[]
  get(id: string): { id: string; name: string; description?: string; input?: unknown } | undefined
  add(tool: Record<string, unknown>): void
  update(id: string, update: (tool: Record<string, unknown>) => void): void
  remove(id: string): void
}

export interface OCContext {
  readonly location: { readonly directory: string; readonly project: { readonly id: string } & Record<string, unknown> }
  readonly options: Record<string, unknown>
  readonly app: { readonly name: string; readonly version: string; readonly channel: string }
  readonly tool: {
    hook(name: "execute.before", cb: (event: ToolExecuteBefore) => unknown): Promise<unknown>
    hook(name: "execute.after", cb: (event: ToolExecuteAfter) => unknown): Promise<unknown>
    transform(cb: (editor: ToolEditor) => void): Promise<unknown>
    list(): Promise<readonly { id: string; name: string; description?: string; input?: unknown }[]>
    reload(): Promise<void>
  }
  readonly shell: {
    hook(name: "create.before", cb: (event: ShellCreateBefore) => unknown): Promise<unknown>
  }
  readonly session: {
    hook(name: string, cb: (event: Record<string, unknown>) => unknown): Promise<unknown>
  }
  readonly permission: {
    hook(name: "evaluate", cb: (event: Record<string, unknown>) => unknown): Promise<unknown>
  }
  readonly event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<Record<string, unknown>>
  }
  readonly storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
}
