/**
 * oc-bifrost — shared types.
 *
 * The V1 side is the real published contract from `@opencode-ai/plugin`.
 * The V2 side is described structurally so this package compiles against any
 * `@opencode/plugin` >= 2.0 without pinning internal subpaths.
 */
import type { Hooks as V1Hooks, PluginInput as V1PluginInput, Plugin as V1Plugin } from "@opencode-ai/plugin";
export type { V1Hooks, V1PluginInput, V1Plugin };
/** A plugin entry as declared in oc-bifrost's own options. */
export type PluginEntry = string | {
    spec: string;
    options?: Record<string, unknown>;
};
export interface BifrostOptions {
    /** Plugins to bridge. V1-era factories and V2-era definitions are both accepted. */
    plugins?: PluginEntry[];
    /**
     * When true, setup aborts instead of warning-and-skipping: an unsupported V1
     * hook, or any entry that cannot be resolved, imported, or mounted. Without it,
     * a bad entry is skipped so the remaining plugins still mount.
     */
    strict?: boolean;
    /** Emit a compatibility report to the console on load. Defaults to true. */
    verbose?: boolean;
    /**
     * Whether to check the bundled preset against upstream's latest release after
     * it mounts. `"online"` opts in; `"off"` (the default) is fully offline. The
     * check is fired off the plugin-load path — not awaited during `setup` — and
     * runs only after the mount has succeeded and been recorded, so it cannot
     * delay or break the mount; the notice may appear shortly after the mount
     * report. An explicit value here wins over the `OC_BIFROST_FRESHNESS`
     * environment variable.
     */
    freshness?: "off" | "online";
    /**
     * Explicit informed consent for `github:` specs to fetch and execute remote
     * code on FIRST use. A cold cache refuses to fetch unless this is true or
     * the environment sets `OC_BIFROST_TRUST=github`; an explicit `false` wins
     * over the env var. A warm (hash-verified) cache loads without consent —
     * the opt-in is about the first fetch, not every mount. The refusal names
     * what would be fetched and that it executes with the host process's full
     * user rights.
     */
    trustRemote?: boolean;
    /**
     * How a fetched `github:` snapshot's declared dependencies are provided
     * before its entry is imported: `"host"` (the default) junctions each
     * dependency from the shared OpenCode npm cache
     * (`<XDG_CACHE_HOME or ~/.cache>/opencode/npm`) - zero network; `"npm"`
     * adds an `npm install --no-save` fallback for packages the host store
     * lacks; `"off"` is 1.3.x behavior (no provisioning, no provision rows).
     * An explicit value here wins over the `OC_BIFROST_PROVISION` environment
     * variable; an invalid value is a loud refusal.
     */
    provision?: "host" | "npm" | "off";
    /**
     * Opt-in TUI wiring for a mounted `github:` SNAPSHOT: after its entry
     * mounts, oc-bifrost ensures a `tui.tsx` wrapper at the tree root and adds
     * the tree as a `file://` plugin entry in the caller-computed cli.json
     * (`~/.config/opencode/cli.json` by default) - a byte-preserving JSONC
     * merge. Snapshot layouts only (the single-file fallback is never wired);
     * whether a wrapper is needed is wire-tui.ts's own decision, never
     * duplicated here. A wire failure or refusal is a loud mount row and never
     * aborts the already-completed mount. An explicit value here wins over the
     * `OC_BIFROST_WIRE_TUI` environment variable (`"1"`/`"true"` opt in;
     * anything else is off).
     */
    wireTui?: boolean;
    /**
     * The cli.json path `wireTui` merges into - normally
     * `~/.config/opencode/cli.json`, computed by the CALLER (wire-tui.ts never
     * guesses). Overridable for tests; production configs do not set this.
     */
    cliJsonPath?: string;
}
export type SupportLevel = "full" | "partial" | "unsupported" | "mounted";
export interface HookReport {
    hook: string;
    level: SupportLevel;
    note?: string;
}
export interface ToolExecuteBefore {
    tool: string;
    sessionID: string;
    agent: string;
    messageID: string;
    id: unknown;
    input: unknown;
}
export interface ToolExecuteAfter {
    readonly tool: string;
    readonly sessionID: string;
    readonly agent: string;
    readonly messageID: string;
    readonly id: unknown;
    readonly input: unknown;
    readonly status: "completed" | "error";
    result?: {
        output?: unknown;
        content?: unknown;
        metadata?: unknown;
    };
    error?: {
        message?: string;
        metadata?: unknown;
    };
}
export interface ShellCreateBefore {
    command: string;
    cwd: string;
    timeout: number;
    shell: string;
    env: Record<string, string | undefined>;
}
export interface ToolEditor {
    list(): readonly {
        id: string;
        name: string;
        description?: string;
        input?: unknown;
    }[];
    get(id: string): {
        id: string;
        name: string;
        description?: string;
        input?: unknown;
    } | undefined;
    add(tool: Record<string, unknown>): void;
    update(id: string, update: (tool: Record<string, unknown>) => void): void;
    remove(id: string): void;
}
export interface OCContext {
    readonly location: {
        readonly directory: string;
        readonly project: {
            readonly id: string;
        } & Record<string, unknown>;
    };
    readonly options: Record<string, unknown>;
    readonly app: {
        readonly name: string;
        readonly version: string;
        readonly channel: string;
    };
    readonly tool: {
        hook(name: "execute.before", cb: (event: ToolExecuteBefore) => unknown): Promise<unknown>;
        hook(name: "execute.after", cb: (event: ToolExecuteAfter) => unknown): Promise<unknown>;
        transform(cb: (editor: ToolEditor) => void): Promise<unknown>;
        list(): Promise<readonly {
            id: string;
            name: string;
            description?: string;
            input?: unknown;
        }[]>;
        reload(): Promise<void>;
    };
    readonly shell: {
        hook(name: "create.before", cb: (event: ShellCreateBefore) => unknown): Promise<unknown>;
    };
    readonly session: {
        hook(name: string, cb: (event: Record<string, unknown>) => unknown): Promise<unknown>;
        /**
         * V2 `session.context`: projected messages since the last completed
         * compaction. This is the only message read V2 exposes to a server-side
         * plugin (packages/plugin/src/promise/session.ts:153-170); the HTTP
         * `session.messages` route is not reachable from the plugin context.
         */
        context?(input: {
            sessionID: string;
        }): Promise<unknown>;
    };
    readonly permission: {
        hook(name: "evaluate", cb: (event: Record<string, unknown>) => unknown): Promise<unknown>;
    };
    readonly event: {
        subscribe(options?: {
            signal?: AbortSignal;
        }): AsyncIterable<Record<string, unknown>>;
    };
    readonly storage: {
        get(key: string): Promise<unknown>;
        set(key: string, value: unknown): Promise<void>;
    };
}
//# sourceMappingURL=types.d.ts.map