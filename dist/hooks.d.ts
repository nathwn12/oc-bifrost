/**
 * The bridge: V1 hook keys -> V2 registration calls.
 *
 * Every entry in the map is either bridged, approximated, or refused out loud.
 * The mapping follows OpenCode's own published V1 -> V2 migration table, plus
 * the refinements verified in the V2 source (mutating the single event object
 * is honoured; `execute.before` is the only hook whose throw rejects a call).
 */
import type { OCContext, V1Hooks } from "./types.js";
import type { Reporter } from "./report.js";
export interface RegisterResult {
    cleanups: Array<() => void | Promise<void>>;
}
/**
 * Every V1 hook key oc-bifrost recognises - bridged, approximated, or refused
 * out loud. Discovery mounts ANY function export as a V1 factory by shape, so
 * a helper-only module mounts as V1; when its returned hooks expose none of
 * these keys the mount warns loudly (the mounting itself is unchanged).
 */
export declare const KNOWN_V1_HOOK_KEYS: readonly ["tool.execute.before", "tool.execute.after", "shell.env", "chat.params", "chat.headers", "chat.message", "permission.ask", "experimental.chat.messages.transform", "experimental.chat.system.transform", "experimental.session.compacting", "tool.definition", "tool", "event", "dispose", "config", "auth", "provider", "command.execute.before", "experimental.provider.small_model", "experimental.compaction.autocontinue", "experimental.text.complete"];
export declare function hasKnownV1Hook(hooks: unknown): boolean;
export declare function registerV1Hooks(ctx: OCContext, hooks: V1Hooks, reporter: Reporter): Promise<RegisterResult>;
//# sourceMappingURL=hooks.d.ts.map