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
import { hostShell, createShell } from "./shell.js";
const RTK_HINT = [
    "install the rtk binary (>= 0.23.0):",
    "  winget install rtk-ai.rtk",
    "  brew install rtk",
    "  or download the GitHub release zip for your platform",
    'NOTE: the crates.io crate named "rtk" is a DIFFERENT project — do not `cargo install rtk`.',
].join("\n");
export const PRESETS = {
    rtk: {
        id: "rtk",
        source: "rtk-ai/rtk",
        version: "v0.50.0",
        license: "Apache-2.0",
        entry: new URL("../vendor/rtk.ts", import.meta.url),
        requires: {
            binary: "rtk",
            minimumVersion: "0.23.0",
            hint: RTK_HINT,
        },
    },
};
/**
 * The loud message used when a preset's binary is missing.
 *
 * Pure and exported so it can be asserted without an installed binary.
 */
export function missingBinaryMessage(spec) {
    return (`preset "${spec.id}" requires the "${spec.requires.binary}" binary ` +
        `(>= ${spec.requires.minimumVersion}), which was not found in PATH — ` +
        `the plugin will self-disable and rewrite nothing.` +
        `\n${spec.requires.hint}`);
}
/**
 * Probe a preset's prerequisite through the shell facade the plugin itself
 * will receive. Never throws: a failure is data, and the caller decides
 * whether it is fatal (`strict`) or a warning.
 */
export async function checkPrerequisite(spec, shell = hostShell() ?? createShell()) {
    const binary = spec.requires.binary;
    // The binary's own preflight is `which <bin>` — that is what the vendored
    // plugin runs, so it is the check that actually decides whether the plugin
    // works. Probing with something else would let us report success while the
    // plugin still disabled itself.
    let preflightOk = true;
    try {
        await shell `which ${binary}`.quiet();
    }
    catch {
        preflightOk = false;
    }
    if (!preflightOk) {
        // Two very different failures look identical here, so separate them: the
        // binary may be absent, or present but invisible to a POSIX `which` (real on
        // Windows without Git-for-Windows on PATH). `where` is the native lookup.
        if (process.platform === "win32") {
            try {
                await shell `where ${binary}`.quiet();
                return {
                    ok: false,
                    message: `preset "${spec.id}" found "${binary}" on PATH, but the plugin's own preflight ` +
                        `(\`which ${binary}\`) does not resolve here — the plugin will still self-disable. ` +
                        `Put a POSIX \`which\` on PATH (Git for Windows ships one) or the plugin cannot run.`,
                };
            }
            catch {
                // fall through to the plain "missing" message
            }
        }
        return { ok: false, message: missingBinaryMessage(spec) };
    }
    let version;
    try {
        const result = await shell `${binary} --version`.quiet().nothrow();
        const text = result.stdout.trim();
        if (text)
            version = text;
    }
    catch {
        // The version is informational only; never fail a mount over it.
    }
    return {
        ok: true,
        version,
        message: `"${spec.requires.binary}" found in PATH${version ? ` (${version})` : ""}`,
    };
}
//# sourceMappingURL=preset.js.map