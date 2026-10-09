/**
 * Config-file fallback for a git install.
 *
 * A git spec (`@nathwn12/oc-bifrost@git+https://...`) cannot carry `options`,
 * so a git-installed bridge would warn and mount nothing. When present,
 * `$CONFIG/oc-bifrost.jsonc` supplies the same keys `context.options` would;
 * an explicit option wins key-by-key over the file. Precedence:
 * defaults < config file < `context.options`.
 *
 * The config-dir resolution mirrors oc-collections (`src/core/config.ts`):
 * `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
 * The file is read when present and never created; a missing or unparseable file is `{}`.
 * The reader never throws - reporting is additive, mounting is untouched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const BIFROST_CONFIG_FILENAME = "oc-bifrost.jsonc";
/** Keys the file may supply - the same surface as `BifrostOptions`. */
const FILE_KEYS = [
    "plugins",
    "strict",
    "verbose",
    "freshness",
    "trustRemote",
    "provision",
    "wireTui",
    "cliJsonPath",
];
/**
 * Resolve the OpenCode config directory. `$OPENCODE_CONFIG_DIR` wins (it is
 * the config root the host itself reports via `opencode debug paths`); then
 * `$XDG_CONFIG_HOME/opencode`; then `~/.config/opencode`.
 */
export function resolveBifrostConfigDir(env = process.env, homeDirectory = os.homedir()) {
    const override = env.OPENCODE_CONFIG_DIR;
    if (override)
        return override;
    const xdg = env.XDG_CONFIG_HOME;
    const base = xdg ?? path.join(homeDirectory, ".config");
    return path.join(base, "opencode");
}
/** The config file path: `<config dir>/oc-bifrost.jsonc`. */
export function resolveBifrostConfigPath(dir, env, homeDirectory) {
    return path.join(dir ?? resolveBifrostConfigDir(env, homeDirectory ?? os.homedir()), BIFROST_CONFIG_FILENAME);
}
/**
 * Parse JSONC the way oc-collections does: strip `//` line comments and
 * trailing commas, string-aware (never inside strings). Never called with
 * untrusted network input - only the operator's own config file.
 */
export function parseBifrostJsonc(text) {
    let stripped = "";
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i + 1];
        if (inLineComment) {
            if (char === "\n") {
                inLineComment = false;
                stripped += char;
            }
            continue;
        }
        if (inString) {
            stripped += char;
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            stripped += char;
            continue;
        }
        if (char === "/" && next === "/") {
            inLineComment = true;
            i += 1;
            continue;
        }
        stripped += char;
    }
    // Trailing commas, string-aware: drop a `,` whose next non-space char closes a bracket.
    let out = "";
    inString = false;
    escaped = false;
    for (let i = 0; i < stripped.length; i++) {
        const char = stripped[i];
        if (inString) {
            out += char;
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            out += char;
            continue;
        }
        if (char === ",") {
            let j = i + 1;
            while (j < stripped.length && /\s/.test(stripped[j]))
                j++;
            const closer = stripped[j];
            if (closer === "}" || closer === "]")
                continue;
        }
        out += char;
    }
    return JSON.parse(out);
}
/**
 * Read the file config. Never throws: a missing, unreadable, unparseable, or
 * non-object file yields `{}`. A non-array `plugins` value is dropped (the
 * mount loop needs an array; garbage must degrade to "not supplied").
 */
export function readBifrostFileConfig(configPath) {
    const target = configPath ?? resolveBifrostConfigPath();
    let raw;
    try {
        raw = fs.readFileSync(target, "utf8");
    }
    catch {
        return {};
    }
    try {
        const parsed = parseBifrostJsonc(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const out = {};
        for (const key of FILE_KEYS) {
            const value = parsed[key];
            if (value === undefined)
                continue;
            if (key === "plugins") {
                if (Array.isArray(value))
                    out.plugins = value;
                continue;
            }
            ;
            out[key] = value;
        }
        return out;
    }
    catch {
        return {};
    }
}
/**
 * Merge the file config with host-supplied options. Precedence, key by key:
 * defaults < config file < `context.options`. `plugins` falls back to the
 * file only when `options` carries none (absent or empty) - an empty list is
 * "not supplied", never an override. Every other key: `options` wins when it
 * is not `undefined`. Pure, exported for tests.
 */
export function resolveBifrostOptions(options, file) {
    const fromOptions = options ?? {};
    const fromFile = file ?? {};
    const merged = {};
    for (const key of FILE_KEYS) {
        if (key === "plugins")
            continue;
        const own = fromOptions[key];
        const fallback = fromFile[key];
        const value = own !== undefined ? own : fallback;
        if (value !== undefined)
            merged[key] = value;
    }
    const ownPlugins = fromOptions.plugins ?? [];
    merged.plugins = ownPlugins.length > 0 ? fromOptions.plugins : fromFile.plugins;
    if (merged.plugins === undefined)
        delete merged.plugins;
    return merged;
}
//# sourceMappingURL=config-file.js.map