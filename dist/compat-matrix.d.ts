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
import type { SupportLevel } from "./types.js";
export interface MatrixRow {
    /** V1 hook key. */
    hook: string;
    level: SupportLevel;
    /** V2 destination, or the reason it is refused. */
    v2: string;
    /** Test name that proves this row's behaviour. */
    test: string;
}
export declare const COMPAT_MATRIX: readonly MatrixRow[];
export declare function matrixRow(hook: string): MatrixRow | undefined;
//# sourceMappingURL=compat-matrix.d.ts.map