/**
 * Plugin discovery — accept any era.
 *
 * V2 rejects a module whose default export is not `{ id, setup | effect }`.
 * oc-bifrost exists to widen that gate: it recognises V1 factory exports,
 * V1 module exports, and mountable V2 definitions (`{ id, setup }`), and
 * routes each to the right path. An effect-only default export (`{ id,
 * effect }`, no `setup`) is Effect-native and must be mounted directly by
 * the host, not through the bridge — discovery refuses it out loud.
 */
import type { V1Plugin } from "./types.js"

export interface V2Definition {
  id: string
  setup?: (ctx: unknown) => unknown
  effect?: (ctx: unknown) => unknown
}

export type Discovery =
  | { kind: "v1"; id: string; factory: V1Plugin; note?: string }
  | { kind: "v2"; id: string; definition: V2Definition; note?: string }
  | { kind: "unknown"; reason: string }

export function effectOnlyRefusal(id: string, spec: string): string {
  return (
    `effect-only V2 definition "${id}" ("${spec}") uses the Effect-native "effect" entry (no "setup") — ` +
    `mount it directly by the host, not through the bridge; see https://opencode.ai/v2/docs/build/plugins/effect/#effect`
  )
}

function isEffectOnly(value: unknown): value is V2Definition {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    typeof candidate.effect === "function" &&
    typeof candidate.setup !== "function"
  )
}

function isV2(value: unknown): value is V2Definition {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === "string" && typeof candidate.setup === "function"
}

function isFactory(value: unknown): value is V1Plugin {
  return typeof value === "function"
}

const PLUGIN_EXPORT = /Plugin$|plugin$|^plugin$|^Plugin$/

export function discover(module: Record<string, unknown>, spec: string): Discovery {
  const fallbackId = spec.split(/[\\/]/).pop()?.replace(/\.(ts|js|mjs|cjs)$/, "") ?? "plugin"

  if (isV2(module.default)) {
    return { kind: "v2", id: module.default.id, definition: module.default, note: "native V2 definition" }
  }

  if (isEffectOnly(module.default)) {
    return { kind: "unknown", reason: effectOnlyRefusal(module.default.id, spec) }
  }

  // V1 module shape: { id?, server: Plugin }.
  if (typeof module.server === "function") {
    const id = typeof module.id === "string" ? module.id : fallbackId
    return { kind: "v1", id, factory: module.server as V1Plugin, note: "V1 module (server export)" }
  }

  if (isFactory(module.default)) {
    return { kind: "v1", id: fallbackId, factory: module.default as V1Plugin, note: "V1 default export" }
  }

  // Named function exports. A V1 factory IS a function by contract
  // (`Plugin = (input) => Promise<Hooks>` - the return is the hook map), so
  // recognition is shape-based; the name heuristic survives only as a
  // PREFERENCE for modules whose first function export is a helper rather
  // than the factory itself (e.g. autotitle exports pure test helpers
  // alongside `AutoTitle`). A module whose exports are all non-functions is
  // still refused out loud.
  for (const [name, value] of Object.entries(module)) {
    if (isFactory(value) && PLUGIN_EXPORT.test(name)) {
      return { kind: "v1", id: name.replace(PLUGIN_EXPORT, "") || fallbackId, factory: value as V1Plugin, note: `V1 named export (${name})` }
    }
  }

  for (const [name, value] of Object.entries(module)) {
    if (isFactory(value)) {
      return { kind: "v1", id: name, factory: value as V1Plugin, note: `V1 named export by shape (${name})` }
    }
  }

  return {
    kind: "unknown",
    reason: "no V1 factory, V1 module, or V2 definition export found",
  }
}
