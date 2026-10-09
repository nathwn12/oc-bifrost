export type ArchiveErrorKind = "unsafe" | "unsupported-entry" | "limit" | "malformed";
export declare class ArchiveError extends Error {
    readonly kind: ArchiveErrorKind;
    constructor(kind: ArchiveErrorKind, message: string);
}
export interface ArchiveLimits {
    /** Hard cap on the UNCOMPRESSED archive size (headers and padding included). */
    maxBytes: number;
    /** Hard cap on the number of regular files extracted. */
    maxFiles: number;
    /** Refuse a resolved repo-relative path longer than this. Default 512. */
    maxPathLength?: number;
}
export interface ArchiveFile {
    /** Repo-relative path with forward slashes (the top-level directory stripped). */
    path: string;
    /** The file's bytes, a view onto the in-memory gunzip output. */
    bytes: Uint8Array;
}
export interface ArchiveContents {
    files: ArchiveFile[];
    /** Sum of the extracted regular files' byte lengths. */
    totalBytes: number;
}
/**
 * Read a gzipped tar into memory, strip `topLevel/` from every path, and
 * return only its regular files — with every cap enforced and every escape
 * refused. Never writes to disk.
 */
export declare function readTarGz(compressed: Uint8Array, topLevel: string, limits: ArchiveLimits): ArchiveContents;
//# sourceMappingURL=archive.d.ts.map