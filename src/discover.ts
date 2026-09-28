/**
 * Plugin discovery — accept any era.
 *
 * V2 rejects a module whose default export is not `{ id, setup | effect }`.
 * oc-bifrost exists to widen that gate: it recognises V1 factory exports,
 * V1 module exports, and V2 definitions, and routes each to the right path.
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

function isV2(value: unknown): value is V2Definition {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    (typeof candidate.setup === "function" || typeof candidate.effect === "function")
  )
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

  // V1 module shape: { id?, server: Plugin }.
  if (typeof module.server === "function") {
    const id = typeof module.id === "string" ? module.id : fallbackId
    return { kind: "v1", id, factory: module.server as V1Plugin, note: "V1 module (server export)" }
  }

  if (isFactory(module.default)) {
    return { kind: "v1", id: fallbackId, factory: module.default as V1Plugin, note: "V1 default export" }
  }

  for (const [name, value] of Object.entries(module)) {
    if (isFactory(value) && PLUGIN_EXPORT.test(name)) {
      return { kind: "v1", id: name.replace(PLUGIN_EXPORT, "") || fallbackId, factory: value as V1Plugin, note: `V1 named export (${name})` }
    }
  }

  return {
    kind: "unknown",
    reason: "no V1 factory, V1 module, or V2 definition export found",
  }
}
