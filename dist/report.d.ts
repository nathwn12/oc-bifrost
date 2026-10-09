/**
 * Compatibility reporter — the honesty layer.
 *
 * Nothing is ever silently dropped. Every V1 hook is either bridged (full),
 * approximated (partial), or refused out loud (unsupported).
 */
import type { HookReport, SupportLevel } from "./types.js";
export interface Reporter {
    readonly id: string;
    record(hook: string, level: SupportLevel, note?: string): void;
    warn(message: string): void;
    readonly reports: HookReport[];
}
export interface ReporterOptions {
    strict?: boolean;
    verbose?: boolean;
    /**
     * Durable mirror of every emitted line. The host discards stdout when it runs
     * as a background service or a stdio server, so console-only reporting is
     * unreachable there; the sink is the proof surface that survives. Best-effort:
     * a throwing sink must never break a mount.
     */
    sink?: (line: string) => void;
}
export declare function createReporter(id: string, opts?: ReporterOptions): Reporter;
export declare function renderReport(reporter: Reporter): string;
//# sourceMappingURL=report.d.ts.map