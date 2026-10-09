/**
 * Bundled presets — zero-fetch plugin entry points.
 *
 * A user writes `"plugins": ["preset:rtk"]` and the bridge mounts a vendored
 * plugin with no network access and no path guessing. The entry URL is derived
 * from `import.meta.url` so it survives the move from `src/` to `dist/`
 * (`dist/preset.js` -> `../vendor/rtk.ts` = the package-root `vendor/rtk.ts`).
 *
 * The prerequisite probe exists because RTK's own plugin self-disables when
 * `which rtk` fails — silently. A preset that silently does nothing is the
 * worst outcome, so we probe first and say so out loud. The probe is
 * defensive: any thrown error becomes a warning, never a crash.
 */
import { type Shell } from "./shell.js";
export interface PresetRequires {
    /** Executable that must be on PATH. */
    binary: string;
    /** Minimum version the vendored plugin is written against. */
    minimumVersion: string;
    /** Human install instructions, including the crate-name trap. */
    hint: string;
}
export interface Preset {
    id: string;
    /** Human upstream identity. */
    source: string;
    /** Pinned upstream version. */
    version: string;
    /** Upstream license. */
    license: string;
    /** Absolute file URL of the bundled entry module. */
    entry: URL;
    requires: PresetRequires;
}
export interface PrerequisiteCheck {
    ok: boolean;
    /** Raw version string when the probe succeeded and reported one. */
    version?: string;
    /** Human-readable outcome, suitable for a reporter note or warning. */
    message: string;
}
export declare const PRESETS: Record<string, Preset>;
/**
 * The loud message used when a preset's binary is missing.
 *
 * Pure and exported so it can be asserted without an installed binary.
 */
export declare function missingBinaryMessage(spec: Preset): string;
/**
 * Probe a preset's prerequisite through the shell facade the plugin itself
 * will receive. Never throws: a failure is data, and the caller decides
 * whether it is fatal (`strict`) or a warning.
 */
export declare function checkPrerequisite(spec: Preset, shell?: Shell): Promise<PrerequisiteCheck>;
//# sourceMappingURL=preset.d.ts.map