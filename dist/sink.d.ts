/** The hard ceiling for the durable report file. */
export declare const MAX_REPORT_BYTES: number;
export interface ReportSink {
    /** Absolute path of the report file. */
    readonly path: string;
    /** False when `OC_BIFROST_REPORT` disables the sink (or it could not be resolved). */
    readonly enabled: boolean;
    /** Mirror one report string (best-effort; never throws). */
    write(text: string): void;
}
export interface ReportSinkOptions {
    /** Environment override; defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Home directory override; defaults to `os.homedir()`. */
    homeDirectory?: string;
    /** Explicit file path, overriding env + default (used by tests). */
    path?: string;
    /** Hard byte ceiling; defaults to `MAX_REPORT_BYTES`. */
    maxBytes?: number;
}
/** True unless `OC_BIFROST_REPORT` names an explicit off switch. */
export declare function reportSinkEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Resolve the report file path. `OC_BIFROST_REPORT` wins when it names a path;
 * otherwise the shared OpenCode cache is used, mirroring `githubCacheRoot`.
 */
export declare function reportPath(homeDirectory?: string, env?: NodeJS.ProcessEnv): string;
/**
 * Escape C0/C1 control characters except newline. A durable log is read by a
 * human or a tool later; raw controls are an injection hazard, newlines are the
 * report's own structure.
 */
export declare function sanitizeReportText(text: string): string;
/**
 * Create the sink. Disk work is lazy: constructing a sink never creates the
 * file, so a load with nothing to report leaves no artifact behind.
 */
export declare function createReportSink(options?: ReportSinkOptions): ReportSink;
//# sourceMappingURL=sink.d.ts.map