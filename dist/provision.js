/**
 * provision: - materialize a fetched tree's declared dependencies into its
 * own `node_modules`, host-store-first, with an npm fallback.
 *
 * A `github:` snapshot is fetched as bare source: it declares what it needs in
 * its `package.json` but ships no `node_modules`. This module closes that gap
 * after the snapshot materializes and BEFORE the entry is imported:
 *
 *   1. HOST STORE FIRST (zero network). For each declared dependency, look it
 *      up in every `hostStores` root and link it into
 *      `<tree>/node_modules/<name>` as a directory junction (`fs.symlinkSync`
 *      type "junction" - unprivileged on Windows, a plain symlink elsewhere).
 *      Two store layouts are supported, per the controller ruling: (a) a flat
 *      store - either the store IS a `node_modules` directory
 *      (`<store>/<name>`) or it CONTAINS one (`<store>/node_modules/<name>`);
 *      and (b) the per-package-rooted OpenCode npm cache layout
 *      `<store>/<name>@<version>/<cacheId>/node_modules/<name>` (scoped
 *      packages nest under `<store>/@scope/...`), preferring the NEWEST
 *      version. Each versioned directory is a package's own install root, so
 *      the lookup scans the `node_modules` of EVERY such root - a hoisted
 *      dependency of another package is resolved too, not only one whose own
 *      root is named for it. A source candidate is only used when `lstat`
 *      reports a REAL directory - an existing reparse point is never followed
 *      while resolving a source.
 *   2. NPM FALLBACK. Dependencies with no host-store hit are installed with
 *      `npm install --no-save --legacy-peer-deps --prefix <tree>` when
 *      `opts.npm` is true. The installed project declares its OWN peers as
 *      required (not optional), so a strict install of a real plugin tree
 *      fails ERESOLVE on a peer range the tree does not itself pin (the live
 *      oc-flight-deck tree: `solid-js@1.9.15` vs `@opentui/solid@0.5.12`'s
 *      exact `peer solid-js@1.9.12`); `--legacy-peer-deps` is npm's own
 *      documented remedy and lets the tree's own pins win. npm is
 *      SPAWNED, never imported (`"dependencies": {}` holds). On Windows the
 *      spawn goes through `cmd.exe /d /c npm.cmd` (Node does not resolve
 *      `.cmd` via PATHEXT without a shell, and `shell: true` is never used);
 *      elsewhere it is a plain `npm` spawn.
 *   3. FAIL LOUDLY, AS A REPORT. A dependency that cannot be satisfied (no
 *      host-store hit and npm disabled or failing) is recorded in `refused` -
 *      never thrown here; the caller decides strictness (Task 2).
 *
 * Idempotence: a dependency already present at `<tree>/node_modules/<name>`
 * records `{ source: "skip" }` and makes no filesystem changes. A tree with no
 * `package.json` produces `{ actions: [], refused: [] }` silently - the
 * "provision skipped" wording belongs to the caller (Task 2).
 *
 * Zero runtime dependencies: node builtins only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
/** The tree-local `node_modules` destination for a dependency name. */
function depDestination(treeDir, name) {
    return path.join(treeDir, "node_modules", ...name.split("/"));
}
/** A valid npm package name: optionally `@scope/`, then a safe basename. */
const PACKAGE_NAME_PATTERN = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
function isValidPackageName(name) {
    return PACKAGE_NAME_PATTERN.test(name);
}
/** Neutralize control characters in an untrusted name before it reaches a report. */
function sanitizeName(name) {
    const escaped = name.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return escaped.length > 200 ? `${escaped.slice(0, 200)}...(truncated)` : escaped;
}
/** The `node_modules` root under the tree. */
function nodeModulesRoot(treeDir) {
    return path.join(treeDir, "node_modules");
}
/** A (validated) name's destination, or null when it escapes `<tree>/node_modules`. */
function safeDestination(treeDir, name) {
    const dest = depDestination(treeDir, name);
    const rel = path.relative(nodeModulesRoot(treeDir), dest);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
        return null;
    return dest;
}
/** True when `p` exists as ANY entry type (file, dir, or link) - `lstat`, never follows. */
function pathExists(p) {
    try {
        fs.lstatSync(p);
        return true;
    }
    catch {
        return false;
    }
}
/** True when `p` is a REAL directory (never a reparse point) - the source-resolution guard. */
function isRealDirectory(p) {
    let stats;
    try {
        stats = fs.lstatSync(p);
    }
    catch {
        return false;
    }
    if (stats.isSymbolicLink())
        return false;
    return stats.isDirectory();
}
/** True when `p` is a regular FILE (not a link, not a directory). */
function isRegularFile(p) {
    let stats;
    try {
        stats = fs.lstatSync(p);
    }
    catch {
        return false;
    }
    return stats.isFile();
}
function stripDotSlash(p) {
    return p.startsWith("./") ? p.slice(2) : p;
}
/** The entry path declared by a manifest's `exports`/`module`/`main`, if any. */
function entryField(record) {
    const exportsValue = record.exports;
    if (typeof exportsValue === "string")
        return stripDotSlash(exportsValue);
    if (exportsValue !== null && typeof exportsValue === "object") {
        const exp = exportsValue;
        const dot = exp["."];
        if (typeof dot === "string")
            return stripDotSlash(dot);
        if (dot !== null && typeof dot === "object") {
            const d = dot;
            for (const key of ["import", "default", "require"]) {
                const value = d[key];
                if (typeof value === "string")
                    return stripDotSlash(value);
            }
        }
    }
    if (typeof record.module === "string")
        return stripDotSlash(record.module);
    if (typeof record.main === "string")
        return stripDotSlash(record.main);
    return undefined;
}
/**
 * Read the tree manifest. Returns null when there is no readable
 * `package.json`. `declared` is the union of `dependencies` and
 * `peerDependencies` keys (a peer the host can satisfy is provisioned exactly
 * like a direct dependency - the spec's §3 contract), preserving declaration
 * order and de-duplicating.
 */
function readManifest(treeDir) {
    const manifestPath = path.join(treeDir, "package.json");
    let raw;
    try {
        raw = fs.readFileSync(manifestPath, "utf8");
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object")
        return null;
    const record = parsed;
    const declared = [];
    for (const field of ["dependencies", "peerDependencies"]) {
        const value = record[field];
        if (value !== null && typeof value === "object") {
            for (const key of Object.keys(value)) {
                if (!declared.includes(key))
                    declared.push(key);
            }
        }
    }
    return { declared, entry: entryField(record) };
}
/**
 * Locate the tree's entry file (for the static-import scan). It is the
 * manifest's declared entry (`exports`/`module`/`main`) when that names a real
 * file inside the tree, else the first conventional entry name. A declared
 * entry that escapes the tree is refused (never read).
 */
function findEntryFile(treeDir) {
    const candidates = [];
    try {
        const raw = fs.readFileSync(path.join(treeDir, "package.json"), "utf8");
        const parsed = JSON.parse(raw);
        const entry = entryField(parsed);
        if (entry !== undefined)
            candidates.push(entry);
    }
    catch {
        // no readable manifest: fall through to conventional entry names
    }
    candidates.push("index.ts", "index.tsx", "index.mjs", "index.js", "plugin.ts", "plugin.js");
    for (const candidate of candidates) {
        const resolved = path.resolve(treeDir, candidate);
        const rel = path.relative(treeDir, resolved);
        if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
            continue;
        if (isRegularFile(resolved))
            return resolved;
    }
    return null;
}
/**
 * Top-level STATIC `import "..."` / `export ... from "..."` specifiers. The
 * scan is deliberately conservative: it never crosses a newline (so a
 * multi-line import is missed rather than a neighbouring import being
 * misattributed), and dynamic `import(...)` is excluded (the contract is
 * static, top-level only).
 */
const STATIC_IMPORT_PATTERN = /(?:\bimport\b|\bexport\b)\s*(?:[^"'\n]*?\s+from\s+)?["']([^"']+)["']/g;
/** A bare specifier: not relative, not absolute, not a URL/builtin scheme. */
function isBareSpecifier(spec) {
    if (spec === "")
        return false;
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("\\"))
        return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec))
        return false;
    return true;
}
/** The package name of a bare specifier (first segment, or first two for a scope). */
function packageRoot(spec) {
    const parts = spec.split("/");
    if (spec.startsWith("@") && parts.length >= 2)
        return `${parts[0]}/${parts[1]}`;
    return parts[0] ?? spec;
}
function staticBareImports(filePath) {
    let content;
    try {
        content = fs.readFileSync(filePath, "utf8");
    }
    catch {
        return [];
    }
    const result = [];
    for (const match of content.matchAll(STATIC_IMPORT_PATTERN)) {
        const spec = match[1];
        if (spec !== undefined && isBareSpecifier(spec) && !result.includes(spec))
            result.push(spec);
    }
    return result;
}
/** True when a bare specifier resolves within the tree (builtin or node_modules present). */
function resolvableInTree(treeDir, spec) {
    const root = packageRoot(spec);
    if (isBuiltin(root) || isBuiltin(root.replace(/^node:/, "")))
        return true;
    return fs.existsSync(path.join(treeDir, "node_modules", root));
}
function resolveFromHostStores(stores, name) {
    for (const store of stores) {
        const found = resolveFromStore(store, name);
        if (found !== null)
            return found;
    }
    return null;
}
function resolveFromStore(store, name) {
    for (const candidate of [path.join(store, name), path.join(store, "node_modules", name)]) {
        if (isRealDirectory(candidate))
            return candidate;
    }
    return resolveFromNpmCache(store, name);
}
/**
 * Every per-package install root at a store's top level: `<store>/<name>@<version>`
 * and the scoped shape `<store>/@scope/<name>@<version>`. The OpenCode npm cache
 * installs a package AND its hoisted dependency graph under one such versioned
 * directory, so a dependency can live in the `node_modules` of ANY installed
 * package - not only one named after it (the live flight-deck peers sit under
 * `<store>/oc-flight-deck@0.9.0/<cacheId>/node_modules/...`). Newest version
 * first; alias versions (`@latest`) sort after numeric ones.
 */
function npmCacheOwners(store) {
    const owners = [];
    const consider = (root, dirName) => {
        const at = dirName.indexOf("@");
        if (at <= 0)
            return; // a scope directory itself, or a name carrying no version
        owners.push({ root, version: dirName.slice(at + 1) });
    };
    let entries;
    try {
        entries = fs.readdirSync(store, { withFileTypes: true });
    }
    catch {
        return owners;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const entryPath = path.join(store, entry.name);
        if (entry.name.startsWith("@")) {
            let children;
            try {
                children = fs.readdirSync(entryPath, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const child of children) {
                if (child.isDirectory())
                    consider(path.join(entryPath, child.name), child.name);
            }
        }
        else {
            consider(entryPath, entry.name);
        }
    }
    return owners.sort(compareOwnersDesc);
}
function compareOwnersDesc(a, b) {
    const aNumeric = isNumericVersion(a.version);
    const bNumeric = isNumericVersion(b.version);
    if (aNumeric && bNumeric)
        return compareVersionsDesc(a.version, b.version);
    if (aNumeric !== bNumeric)
        return aNumeric ? -1 : 1;
    if (a.version === b.version)
        return 0;
    return a.version < b.version ? -1 : 1;
}
function resolveFromNpmCache(store, name) {
    const segments = name.split("/");
    for (const owner of npmCacheOwners(store)) {
        let cacheIds;
        try {
            cacheIds = fs.readdirSync(owner.root, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const cacheId of cacheIds) {
            if (!cacheId.isDirectory())
                continue;
            // Scoped packages keep their scope segment under node_modules:
            // `node_modules/@scope/<name>`, never `node_modules/<name>`.
            const candidate = path.join(owner.root, cacheId.name, "node_modules", ...segments);
            if (isRealDirectory(candidate))
                return candidate;
        }
    }
    return null;
}
/** A version dir is a real version (not an `@latest`/`@next` alias) when it starts with a digit. */
function isNumericVersion(version) {
    return /^[0-9]/.test(version);
}
/** Descending version order: numeric dot-segments, then string, deterministic. */
function compareVersionsDesc(a, b) {
    const pa = a.split(".");
    const pb = b.split(".");
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const as = pa[i] ?? "";
        const bs = pb[i] ?? "";
        const an = Number(as);
        const bn = Number(bs);
        if (as !== "" && bs !== "" && Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
            return bn - an;
        }
        if (as !== bs)
            return bs < as ? -1 : 1;
    }
    return 0;
}
/** Junction `source` into `dest`; false (never a throw) when the link cannot be created. */
function linkIntoTree(source, dest) {
    try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // "junction" is a directory link that needs no elevation on Windows; the
        // type argument is ignored on other platforms (a plain symlink is made).
        fs.symlinkSync(source, dest, "junction");
        return true;
    }
    catch {
        // EPERM/EACCES/EEXIST/reparse-unsupported volumes are a loud refusal, not a
        // thrown error (R-4: junction-with-loud-refusal, no copy fallback). The
        // package name (already validated, control-char-free) is what reaches the
        // report; the raw fs error never does.
        return false;
    }
}
/** Run `npm install --no-save --legacy-peer-deps --prefix <treeDir>`; true when it exits 0. */
function runNpmInstall(treeDir) {
    const args = ["install", "--no-save", "--legacy-peer-deps", "--prefix", treeDir];
    const result = process.platform === "win32"
        ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "npm.cmd", ...args], {
            encoding: "utf8",
            windowsHide: true,
            cwd: os.tmpdir(),
        })
        : spawnSync("npm", args, { encoding: "utf8", windowsHide: true, cwd: os.tmpdir() });
    return result.status === 0;
}
export async function provisionTree(treeDir, opts) {
    const manifest = readManifest(treeDir);
    const declared = manifest?.declared ?? [];
    const report = { actions: [], refused: [] };
    const npmPending = [];
    for (const name of declared) {
        if (!isValidPackageName(name)) {
            report.refused.push(sanitizeName(name));
            continue;
        }
        const dest = safeDestination(treeDir, name);
        if (dest === null) {
            // Fail-closed path-escape guard: the only thing refusing a "."/".." or
            // absolute name here - `isValidPackageName` above does NOT exclude them.
            report.refused.push(sanitizeName(name));
            continue;
        }
        if (pathExists(dest)) {
            report.actions.push({ package: name, source: "skip", target: dest });
            continue;
        }
        const source = resolveFromHostStores(opts.hostStores ?? [], name);
        if (source !== null) {
            if (opts.dryRun === true) {
                report.actions.push({ package: name, source: "host", target: source });
                continue;
            }
            if (linkIntoTree(source, dest)) {
                report.actions.push({ package: name, source: "host", target: source });
            }
            else {
                report.refused.push(name);
            }
            continue;
        }
        npmPending.push(name);
    }
    if (npmPending.length > 0) {
        const npmEnabled = opts.npm === true;
        let installed;
        if (opts.dryRun === true) {
            installed = npmEnabled; // dry run: project the npm intent without running it
        }
        else if (npmEnabled) {
            installed = runNpmInstall(treeDir);
        }
        else {
            installed = false;
        }
        for (const name of npmPending) {
            if (installed) {
                report.actions.push({ package: name, source: "npm", target: depDestination(treeDir, name) });
            }
            else {
                report.refused.push(name);
            }
        }
    }
    return report;
}
/**
 * Bare specifiers the entry graph imports that the tree cannot resolve.
 *
 * Reads the tree's `package.json` `dependencies`/`peerDependencies` plus the
 * entry file's top-level static bare imports, and returns those (deduped, in
 * first-seen order) that are neither Node builtins nor present under the
 * tree's `node_modules`.
 */
export function missingDeps(treeDir) {
    const manifest = readManifest(treeDir);
    const candidates = [];
    for (const name of manifest?.declared ?? []) {
        if (isValidPackageName(name) && !candidates.includes(name))
            candidates.push(name);
    }
    const entryFile = findEntryFile(treeDir);
    if (entryFile !== null) {
        for (const spec of staticBareImports(entryFile)) {
            if (!candidates.includes(spec))
                candidates.push(spec);
        }
    }
    const missing = [];
    for (const spec of candidates) {
        if (resolvableInTree(treeDir, spec))
            continue;
        if (!missing.includes(spec))
            missing.push(spec);
    }
    return missing;
}
//# sourceMappingURL=provision.js.map