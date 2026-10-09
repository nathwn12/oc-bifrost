/**
 * First line of a wrapper WE wrote: the same ownership marker cli.json uses,
 * so a managed wrapper is identifiable without guessing from its shape.
 */
export declare const WRAPPER_MARKER = "// oc-bifrost: managed TUI entry";
/** The `tui.tsx` re-export body for a tree-relative `target` (e.g. `src/tui/index.tsx`). */
export declare function wrapperContent(target: string): string;
/**
 * First line of a server-entry wrapper WE wrote. Deliberately distinct from
 * `WRAPPER_MARKER` so the TUI heal path can never mistake one for the other
 * (they live at different paths, but markers are the ownership proof).
 */
export declare const SERVER_WRAPPER_MARKER = "// oc-bifrost: managed server entry";
/** The root `index.ts` re-export body for a tree-relative `target` (e.g. `src/index.ts`). */
export declare function serverWrapperContent(target: string): string;
/** Inside an array WE created: marks the whole key as ours to remove. */
export declare const CREATED_KEY_MARKER = "// oc-bifrost: managed TUI entry (key auto-created; safe to remove with it)";
/**
 * Immediately above one of OUR entries inside an otherwise user-owned array.
 * When the plugin's stable key is known the marker line carries it as
 * `// oc-bifrost: managed TUI entry [<key>]`; the bare form stays valid for
 * entries written before keys existed.
 */
export declare const ENTRY_MARKER = "// oc-bifrost: managed TUI entry";
/** Test-only seam: fires after each read+merge, before the pre-write mtime check. */
export interface WireTuiSeam {
    beforeWrite?: () => void | Promise<void>;
}
export declare function __setWireTuiSeamForTests(seam: WireTuiSeam | null): void;
/**
 * The outcome of one `wireTui` call:
 *   - `wired`   - the tree's `file://` URL is in cli.json; `wrapper` is the
 *                 wrapper this call wrote, or null when a loadable entry
 *                 already existed;
 *   - `skipped` - the tree ships no TUI entry, so no wrapper and no cli.json
 *                 entry survive the call: a managed wrapper left by an
 *                 earlier version is removed and a managed cli.json entry for
 *                 the tree is unwired. `reason` is the informational row for
 *                 the caller: not a refusal, not a warning.
 */
export type WireTuiOutcome = {
    kind: "wired";
    wrapper: string | null;
    entry: string;
    serverEntry: string | null;
} | {
    kind: "skipped";
    reason: string;
};
/**
 * Wire a provisioned tree's TUI entry: ensure the root wrapper, then add the
 * tree (as a `file://` URL) to the plugins array of the caller-provided
 * cli.json, byte-preserving everything else (see the module contract). A tree
 * that ships no TUI entry at all is a clean skip: a stale managed wrapper is
 * removed, a stale managed cli.json entry for the tree is unwired, and
 * nothing else is written. When `opts.pluginKey` / `opts.treeFamily` identify
 * the plugin, its previous MANAGED entries are pruned (by exact key, or by a
 * guarded URL fallback for legacy keyless entries) before the new entry is
 * merged.
 */
export declare function wireTui(treeDir: string, cliJsonPath: string, opts?: {
    treeFamily?: string;
    pluginKey?: string;
    serverEntry?: string;
}): Promise<WireTuiOutcome>;
/**
 * Remove only what wireTui added from the caller-provided cli.json. With
 * `entry`, remove only that exact tree's managed entry (another tree's managed
 * entry is never touched); without it, remove every managed entry. Returns
 * true when anything changed, false when there is nothing of ours to do.
 */
export declare function unwireTui(cliJsonPath: string, entry?: string): Promise<boolean>;
//# sourceMappingURL=wire-tui.d.ts.map