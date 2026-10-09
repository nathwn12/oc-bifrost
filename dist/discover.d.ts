/**
 * Plugin discovery — accept any era.
 *
 * V2 rejects a module whose default export is not `{ id, setup | effect }`.
 * oc-bifrost exists to widen that gate: it recognises V1 factory exports,
 * V1 module exports, and V2 definitions, and routes each to the right path.
 */
import type { V1Plugin } from "./types.js";
export interface V2Definition {
    id: string;
    setup?: (ctx: unknown) => unknown;
    effect?: (ctx: unknown) => unknown;
}
export type Discovery = {
    kind: "v1";
    id: string;
    factory: V1Plugin;
    note?: string;
} | {
    kind: "v2";
    id: string;
    definition: V2Definition;
    note?: string;
} | {
    kind: "unknown";
    reason: string;
};
export declare function discover(module: Record<string, unknown>, spec: string): Discovery;
//# sourceMappingURL=discover.d.ts.map