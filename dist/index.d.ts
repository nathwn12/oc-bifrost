import { Plugin } from "@opencode/plugin";
import { type GithubSpec } from "./github.js";
import { type RegistrySpec } from "./registry.js";
export { COMPAT_MATRIX, matrixRow } from "./compat-matrix.js";
export type { MatrixRow } from "./compat-matrix.js";
export { PRESETS } from "./preset.js";
export type { Preset, PresetRequires } from "./preset.js";
export { compareTags, pinnedNote, freshnessEnabled, checkFreshness } from "./freshness.js";
export type { FreshnessResult } from "./freshness.js";
/** The shared OpenCode cache root for fetched GitHub plugins. */
export declare function githubCacheRoot(homeDirectory?: string, env?: NodeJS.ProcessEnv): string;
/** The shared OpenCode cache root for installed registry plugins. */
export declare function registryCacheRootFor(homeDirectory?: string, env?: NodeJS.ProcessEnv): string;
/**
 * Whether opt-in TUI wiring is enabled. An explicit option wins; otherwise
 * `OC_BIFROST_WIRE_TUI` opts in with exactly `"1"` or `"true"`
 * (case-insensitive); any other value is off. Pure, exported for tests.
 */
export declare function wireTuiEnabled(option: boolean | undefined, env?: NodeJS.ProcessEnv): boolean;
/**
 * A resolved specifier. Discriminated so the caller can branch between a
 * mountable module URL, a bundled preset, and a remote `github:` spec without
 * re-parsing the string.
 */
export type ResolvedSpec = {
    kind: "module";
    url: string;
} | {
    kind: "preset";
    id: string;
} | {
    kind: "github";
    spec: GithubSpec;
} | {
    kind: "registry";
    spec: RegistrySpec;
};
/** The honest refusal for a form this slice does not build. */
export declare function unsupportedSpecifierMessage(spec: string): string;
/**
 * Resolve a user-supplied specifier against the session directory.
 *
 * Supported forms, in order:
 *   - `github:<owner>/<repo>[@<ref>][#<path>]` -> a remote V1 plugin, mounted
 *                BY SOURCE: resolved cache-first into a verified user-level
 *                OpenCode cache shared across project locations. The FIRST
 *                fetch requires explicit consent (`options.trustRemote: true`
 *                or `OC_BIFROST_TRUST=github`) — a cold cache refuses to
 *                fetch+execute otherwise. The ref resolves to a commit sha
 *                that is recorded with the sha256 and verified on every later
 *                load. See `github.ts`.
 *   - `~/...`  -> expands against `os.homedir()`, then treated as absolute.
 *                A bare `~` is invalid and throws. This is the reliable way to
 *                name a global install location on every platform.
 *   - `preset:<id>` -> a bundled preset from `PRESETS`; unknown ids throw with
 *                the valid list.
 *   - `./`, `../`, absolute -> a `file://` URL resolved against `directory`
 *                (unchanged from 0.1.0 — the regression surface).
 *   - `file://` -> passed through as a bare module specifier.
 *   - a bare registry name (`oc-todo`, `oc-todo@0.4.0`, `@scope/pkg@^1.0.0`,
 *                `pkg@latest`) or the same behind an `npm:`/`pnpm:`/`bun:`
 *                prefix -> installed from the npm registry into a
 *                bifrost-owned cache directory and mounted from there. The
 *                prefix is stripped and the remainder is treated as the bare
 *                spec; `pnpm:`/`bun:` are aliases that install through the
 *                same spawned manager (never a real pnpm/bun install), and
 *                the mount note says so plainly. See `registry.ts`.
 *   - anything else is refused with the accepted-forms message (see
 *                `unsupportedSpecifierMessage`); refusing honestly beats guessing.
 */
export declare function resolveSpec(spec: string, directory: string): ResolvedSpec;
/**
 * The loud, actionable message for a failed import.
 *
 * Pure and exported so it can be asserted without a host. The fix hint names
 * the single worst failure mode: a relative specifier resolves against the
 * SESSION directory, so a "successful" global install that used one silently
 * imports nothing useful.
 */
export declare function importFailureMessage(spec: string, directory: string, target: string, error: Error): string;
declare const _default: Plugin.Plugin;
export default _default;
//# sourceMappingURL=index.d.ts.map