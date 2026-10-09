/**
 * Stranded-V1-file detection.
 *
 * The single biggest trap in the wild: a V1 plugin file left in a plugin
 * *discovery* directory is hard-rejected by the V2 host BEFORE this bridge can
 * run, with a cryptic message. We cannot intercept the host's loader, so we
 * detect the shape and warn while there is still time to fix it.
 *
 * Discovery directory names are exactly `["plugin", "plugins"]` and the host
 * auto-loads bare `.ts`/`.js` FILES found there plus directories
 * (`packages/core/src/plugin/source-directory.ts:7,23-25`).
 *
 * The global config root is a MIRROR of the host's own XDG logic
 * (`packages/util/src/global-roots.ts:7`), not an advertised API. That is
 * acceptable for a WARNING and unacceptable for anything load-bearing: if the
 * host moves the root, the worst case is a missed warning, never a wrong mount.
 *
 * Detection is a cheap, conservative TEXT heuristic. We never import or execute
 * a scanned file, and we never throw or write: a false negative is fine, a
 * false positive is noise.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const DISCOVERY_DIR_NAMES = ["plugin", "plugins"];
/** Conservative V1-shaped source signatures. Deliberately narrow. */
const V1_SIGNATURES = [
    // `export const RtkOpenCodePlugin: Plugin = async ({ $ }) => {`
    // The `= async|function|(` tail is load-bearing: it separates a V1 *factory*
    // from a legitimate V2 object export, `export const FooPlugin = { id, setup }`,
    // which must NOT be flagged.
    /export\s+(?:const|let|var)\s+[\w$]*[Pp]lugin\w*\s*(?::[^=]+)?=\s*(?:async\b|function\b|\()/,
    // `export function FooPlugin(...)`
    /export\s+(?:async\s+)?function\s+[\w$]*[Pp]lugin\b/,
    // `export default async (input)` / `export default async ({ ... })`
    /export\s+default\s+async\s*(?:function\b|[(<])/,
    // CommonJS V1
    /module\.exports/,
];
/** True when the source looks like a V1-era plugin. */
export function looksLikeV1Plugin(source) {
    return V1_SIGNATURES.some((pattern) => pattern.test(source));
}
function readIfPluginSource(file) {
    if (!file.endsWith(".ts") && !file.endsWith(".js"))
        return undefined;
    try {
        return fs.readFileSync(file, "utf8");
    }
    catch {
        return undefined; // unreadable — report nothing, never throw
    }
}
function scanDiscoveryDir(directory, rootName) {
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    }
    catch {
        return []; // missing or unreadable directory — nothing to report
    }
    const found = [];
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        const file = path.join(directory, entry.name);
        const source = readIfPluginSource(file);
        if (source !== undefined && looksLikeV1Plugin(source))
            found.push({ path: file, root: rootName });
    }
    return found;
}
/** Scan the project and global discovery directories. Never throws. */
export function scanStrandedV1(options) {
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const globalRoot = env.XDG_CONFIG_HOME
        ? path.join(env.XDG_CONFIG_HOME, "opencode")
        : path.join(home, ".config", "opencode");
    const bases = [
        { base: path.join(options.directory, ".opencode"), root: "project" },
        { base: globalRoot, root: "global" },
    ];
    const found = bases.flatMap(({ base, root }) => DISCOVERY_DIR_NAMES.flatMap((name) => scanDiscoveryDir(path.join(base, name), root)));
    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/** One actionable warning line for a stranded file. */
export function strandedWarning(file) {
    const base = file.root === "project" ? "<project>/.opencode" : "<config>/opencode";
    return (`stranded V1 plugin file "${file.path}" will be hard-rejected by the V2 host before this bridge runs. ` +
        `Move it out of the discovery directory (e.g. ${base}/legacy/) and reference it from options.plugins instead.`);
}
//# sourceMappingURL=scan.js.map