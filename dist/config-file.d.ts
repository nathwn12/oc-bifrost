import type { BifrostOptions } from "./types.js";
export declare const BIFROST_CONFIG_FILENAME = "oc-bifrost.jsonc";
/**
 * Resolve the OpenCode config directory. `$OPENCODE_CONFIG_DIR` wins (it is
 * the config root the host itself reports via `opencode debug paths`); then
 * `$XDG_CONFIG_HOME/opencode`; then `~/.config/opencode`.
 */
export declare function resolveBifrostConfigDir(env?: NodeJS.ProcessEnv, homeDirectory?: string): string;
/** The config file path: `<config dir>/oc-bifrost.jsonc`. */
export declare function resolveBifrostConfigPath(dir?: string, env?: NodeJS.ProcessEnv, homeDirectory?: string): string;
/**
 * Parse JSONC the way oc-collections does: strip `//` line comments and
 * trailing commas, string-aware (never inside strings). Never called with
 * untrusted network input - only the operator's own config file.
 */
export declare function parseBifrostJsonc(text: string): unknown;
/**
 * Read the file config. Never throws: a missing, unreadable, unparseable, or
 * non-object file yields `{}`. A non-array `plugins` value is dropped (the
 * mount loop needs an array; garbage must degrade to "not supplied").
 */
export declare function readBifrostFileConfig(configPath?: string): BifrostOptions;
/**
 * Merge the file config with host-supplied options. Precedence, key by key:
 * defaults < config file < `context.options`. `plugins` falls back to the
 * file only when `options` carries none (absent or empty) - an empty list is
 * "not supplied", never an override. Every other key: `options` wins when it
 * is not `undefined`. Pure, exported for tests.
 */
export declare function resolveBifrostOptions(options: BifrostOptions | undefined, file: BifrostOptions | undefined): BifrostOptions;
//# sourceMappingURL=config-file.d.ts.map