/** One provisioning result for one dependency. */
export interface ProvisionAction {
    /** The dependency's bare specifier, exactly as declared. */
    package: string;
    /**
     * How the dependency was satisfied:
     *   - "host" - junctioned from a host store; `target` is the host-store
     *     source directory the link points at.
     *   - "npm"  - left to `npm install --no-save --prefix <tree>`; `target` is
     *     `<tree>/node_modules/<name>`.
     *   - "skip" - already present in the tree; `target` is
     *     `<tree>/node_modules/<name>`.
     */
    source: "host" | "npm" | "skip";
    /** See `source`. */
    target: string;
    /** Optional size in bytes (not currently reported). */
    bytes?: number;
}
/** The whole provisioning pass: one action per dependency, plus refusals. */
export interface ProvisionReport {
    actions: ProvisionAction[];
    /** Bare specifiers that could not be satisfied, in declaration order. */
    refused: string[];
}
export declare function provisionTree(treeDir: string, opts: {
    hostStores?: readonly string[];
    npm?: boolean;
    dryRun?: boolean;
}): Promise<ProvisionReport>;
/**
 * Bare specifiers the entry graph imports that the tree cannot resolve.
 *
 * Reads the tree's `package.json` `dependencies`/`peerDependencies` plus the
 * entry file's top-level static bare imports, and returns those (deduped, in
 * first-seen order) that are neither Node builtins nor present under the
 * tree's `node_modules`.
 */
export declare function missingDeps(treeDir: string): string[];
//# sourceMappingURL=provision.d.ts.map