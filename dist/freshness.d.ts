/**
 * Freshness — the release that stops the bundled RTK preset from going stale.
 *
 * The vendored `preset:rtk` bytes are pinned to a specific upstream tag. Over
 * time upstream moves on and the pin ages, silently: nobody notices that the
 * bundled copy is months behind until something RTK rewrites breaks.
 *
 * The honest fix is NOT to fetch at load time. Auto-fetching would execute
 * unverified remote code and destroy the recorded provenance (the sha256, git
 * blob, and license that make the vendored copy auditable). So this module is
 * deliberately two-sided:
 *
 *   - `pinnedNote` is offline and always available — the mount report always
 *     names the pinned version, with zero network access.
 *   - `checkFreshness` is an opt-in comparison against the upstream releases
 *     API. It never throws, it is timeboxed, and any failure is `unknown`, an
 *     informational state — an offline machine is not an error.
 */
import type { Preset } from "./preset.js";
export interface FreshnessResult {
    status: "current" | "behind" | "unknown";
    pinned: string;
    latest?: string;
    message: string;
}
/** Compare two semver-ish tags ("v1.2.3", "1.2.3", optional -suffix). Returns -1 | 0 | 1. Pure, no network. */
export declare function compareTags(a: string, b: string): number;
/** Offline, always-available note naming the pinned version. Pure. */
export declare function pinnedNote(spec: Preset): string;
/**
 * Whether the online check is enabled. An explicit option WINS over the env
 * var: `off` disables the check even when the environment asks for it. When the
 * option is omitted, `OC_BIFROST_FRESHNESS === "online"` enables it. Pure.
 */
export declare function freshnessEnabled(option: string | undefined, env?: NodeJS.ProcessEnv): boolean;
/**
 * Online check. Never throws. Timeboxed. Returns "unknown" on any failure.
 *
 * `unknown` is informational — an offline machine, a rate limit, or a GitHub
 * hiccup is not a warning and must not read like one.
 */
export declare function checkFreshness(spec: Preset, opts?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}): Promise<FreshnessResult>;
//# sourceMappingURL=freshness.d.ts.map