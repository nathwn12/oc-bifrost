/**
 * V1 PluginInput facade.
 *
 * A V1 factory is called with `{ client, project, directory, worktree, $, ... }`.
 * We reproduce that shape. Where V2 has no faithful equivalent we return a
 * guarded proxy that fails loudly rather than a plausible-looking lie.
 */
import type { OCContext, V1PluginInput } from "./types.js";
import type { Reporter } from "./report.js";
export interface ContextFacadeOptions {
    reporter: Reporter;
    /** Fallback used when V2 cannot describe a worktree. */
    directory?: string;
}
export declare function buildV1Context(ctx: OCContext, reporter: Reporter): V1PluginInput;
//# sourceMappingURL=context.d.ts.map