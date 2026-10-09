export declare const DISCOVERY_DIR_NAMES: readonly ["plugin", "plugins"];
export interface StrandedFile {
    path: string;
    root: "project" | "global";
}
export interface ScanOptions {
    /** Project/session root (`ctx.location.directory`). */
    directory: string;
    /** Home directory override; defaults to `os.homedir()`. */
    home?: string;
    /** Environment override; defaults to `process.env`. */
    env?: Record<string, string | undefined>;
}
/** True when the source looks like a V1-era plugin. */
export declare function looksLikeV1Plugin(source: string): boolean;
/** Scan the project and global discovery directories. Never throws. */
export declare function scanStrandedV1(options: ScanOptions): StrandedFile[];
/** One actionable warning line for a stranded file. */
export declare function strandedWarning(file: StrandedFile): string;
//# sourceMappingURL=scan.d.ts.map