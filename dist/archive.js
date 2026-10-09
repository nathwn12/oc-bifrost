/**
 * Minimal, dependency-free tar.gz reader for the `github:` snapshot route.
 *
 * Deliberately narrow — this is NOT a general-purpose tar extractor:
 *
 *   - gzip in, regular files out, in memory. Directory entries are skipped;
 *     symlinks, hardlinks, device nodes, and FIFOs are REFUSED and never
 *     materialized.
 *   - ustar is supported including the split `prefix` field (real GitHub
 *     repository archives use it — 97 of the 298 entries in
 *     `obra/superpowers@v6.4.2` carry a prefix), plus pax extended headers
 *     (`x` / `g`) and GNU long names (`L`).
 *   - The archive must be rooted at exactly one top-level directory
 *     (`<repo>-<sha>`); that segment is stripped from every extracted path,
 *     and an entry outside it is refused as hostile.
 *   - Safety, on untrusted input: absolute paths, `..`/`.`/empty segments,
 *     backslashes, NUL, Windows alternate-data-stream `:`, duplicate paths,
 *     and paths that resolve outside the cache root are all refused. Nothing
 *     here ever writes; the caller materializes under its own guarded root.
 *   - Caps are hard and never truncate: uncompressed bytes, file count, and
 *     per-path length. A breach raises `limit`; the caller degrades loudly.
 *
 * Error kinds, so the caller can choose its response:
 *   - `unsafe`             — a path escape or ambiguous duplicate. The caller
 *                            refuses the whole snapshot (never executes it).
 *   - `unsupported-entry`  — a link/device entry. Refused; caller may fall
 *                            back to the single-file route loudly.
 *   - `limit`              — a named cap was breached. Caller may fall back.
 *   - `malformed`          — the bytes are not a tar this reader can trust.
 */
import { gunzipSync } from "node:zlib";
const BLOCK = 512;
const DEFAULT_MAX_PATH = 512;
export class ArchiveError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = "ArchiveError";
        this.kind = kind;
    }
}
const UTF8 = new TextDecoder("utf-8");
/** Escape control characters and cap length before a name reaches a message. */
function display(value, max = 160) {
    const escaped = value.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return escaped.length > max ? `${escaped.slice(0, max)}…(truncated)` : escaped;
}
/** Decode a field, trimming only TRAILING NUL padding. An embedded NUL
 * survives the decode and is refused by resolveEntryName — a truncated field
 * (e.g. "nul\0name.txt" -> "nul") would silently rename hostile input, and
 * "nul" is a Windows device name. */
function readField(field) {
    return UTF8.decode(field).replace(/\0+$/, "");
}
/** Decode a NUL-terminated blob (GNU long name/linkname payload): only the
 * trailing terminator is padding; embedded NULs must reach the validators. */
function readCString(data) {
    return UTF8.decode(data).replace(/\0+$/, "");
}
function isZeroBlock(block) {
    for (const byte of block) {
        if (byte !== 0)
            return false;
    }
    return true;
}
/** Octal (space/NUL padded) or GNU base-256; `undefined` when the field is invalid. */
function parseNumeric(field) {
    if (field.length === 0)
        return undefined;
    const first = field[0] ?? 0;
    if ((first & 0x80) !== 0) {
        let value = first & 0x7f;
        for (let index = 1; index < field.length; index++) {
            value = value * 256 + (field[index] ?? 0);
            if (!Number.isSafeInteger(value))
                return undefined;
        }
        return value;
    }
    // Numeric fields are NUL/space terminated by spec; the checksum field in
    // particular is `<octal>\0 ` (NUL then a space). Truncating at the first
    // NUL is CORRECT here — unlike name fields, nothing after the terminator
    // carries meaning, and embedded junk then fails the octal regex below.
    const end = field.indexOf(0);
    const text = UTF8.decode(end === -1 ? field : field.subarray(0, end)).trim();
    if (text === "")
        return 0;
    if (!/^[0-7]+$/.test(text))
        return undefined;
    const value = parseInt(text, 8);
    return Number.isSafeInteger(value) ? value : undefined;
}
/** Unsigned checksum, the classic tar check (chksum bytes counted as spaces). */
function verifyChecksum(header, offset) {
    const expected = parseNumeric(header.subarray(148, 156));
    if (expected === undefined) {
        throw new ArchiveError("malformed", `tar header at offset ${offset} has an unreadable checksum field`);
    }
    let sum = 0;
    for (let index = 0; index < BLOCK; index++) {
        sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    if (sum !== expected) {
        throw new ArchiveError("malformed", `tar header at offset ${offset} failed its checksum (expected ${expected}, computed ${sum})`);
    }
}
/** pax extended header records: `<decimal length> <key>=<value>\n`, length-prefixed. */
function parsePax(data) {
    const records = {};
    let position = 0;
    while (position < data.length) {
        if (data[position] === 0)
            break; // trailing NUL padding
        const space = data.indexOf(0x20, position);
        if (space === -1)
            throw new ArchiveError("malformed", "pax record has no length separator");
        const lengthText = UTF8.decode(data.subarray(position, space));
        if (!/^[1-9][0-9]*$/.test(lengthText)) {
            throw new ArchiveError("malformed", `pax record has an invalid length field (${display(lengthText, 24)})`);
        }
        const length = Number(lengthText);
        if (position + length > data.length)
            throw new ArchiveError("malformed", "pax record runs past the end of its header block");
        const record = data.subarray(position, position + length);
        if (record[record.length - 1] !== 0x0a)
            throw new ArchiveError("malformed", "pax record does not end with a newline");
        const equals = record.indexOf(0x3d, space - position);
        if (equals === -1 || equals === space - position + 1) {
            throw new ArchiveError("malformed", "pax record has no key/value separator");
        }
        const key = UTF8.decode(record.subarray(space - position + 1, equals));
        const value = UTF8.decode(record.subarray(equals + 1, record.length - 1));
        records[key] = value;
        position += length;
    }
    return records;
}
/**
 * Validate one entry's name and strip the single top-level directory.
 * Returns the repo-relative path, or `""` for the top-level directory itself.
 * Any escape attempt is `unsafe`: the caller must refuse the whole snapshot.
 */
function resolveEntryName(raw, topLevelLower, isDirectory, maxPathLength) {
    const name = isDirectory ? raw.replace(/\/+$/, "") : raw;
    const label = display(name);
    if (name === "")
        throw new ArchiveError("unsafe", "an archive entry has an empty name");
    if (name.includes("\0"))
        throw new ArchiveError("unsafe", `an archive entry name contains a NUL byte ("${label}")`);
    if (name.startsWith("/"))
        throw new ArchiveError("unsafe", `archive entry "${label}" is an absolute path`);
    if (name.includes("\\"))
        throw new ArchiveError("unsafe", `archive entry "${label}" uses backslashes`);
    const segments = name.split("/");
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") {
            throw new ArchiveError("unsafe", `archive entry "${label}" contains an empty, "." or ".." path segment`);
        }
    }
    const top = segments[0];
    if (top.toLowerCase() !== topLevelLower) {
        throw new ArchiveError("unsafe", `archive entry "${label}" is not under the expected top-level directory "${display(topLevelLower)}"`);
    }
    const relative = segments.slice(1);
    for (const segment of relative) {
        // Windows alternate data streams: "file:stream" would write outside the
        // materialized file. Refused rather than sanitized.
        if (segment.includes(":")) {
            throw new ArchiveError("unsafe", `archive entry "${label}" contains ":" (a Windows alternate-data-stream separator)`);
        }
    }
    if (relative.length === 0)
        return "";
    const resolved = relative.join("/");
    if (resolved.length > maxPathLength) {
        throw new ArchiveError("limit", `archive entry path exceeds ${maxPathLength} characters ("${label}")`);
    }
    return resolved;
}
/** True when a gunzip failure is the output cap rather than a corrupt stream. */
function isSizeError(error) {
    const code = error?.code;
    if (code === "ERR_BUFFER_TOO_LARGE")
        return true;
    const message = error instanceof Error ? error.message : String(error);
    return /larger than|maxoutputlength|maximum/i.test(message);
}
/**
 * Read a gzipped tar into memory, strip `topLevel/` from every path, and
 * return only its regular files — with every cap enforced and every escape
 * refused. Never writes to disk.
 */
export function readTarGz(compressed, topLevel, limits) {
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
        throw new ArchiveError("limit", "the archive reader needs a positive maxBytes cap");
    }
    if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles <= 0) {
        throw new ArchiveError("limit", "the archive reader needs a positive maxFiles cap");
    }
    if (topLevel === "" || topLevel.includes("/") || /[\u0000-\u001f]/.test(topLevel)) {
        throw new ArchiveError("unsafe", `invalid archive top-level directory "${display(topLevel)}"`);
    }
    const maxPathLength = limits.maxPathLength ?? DEFAULT_MAX_PATH;
    const topLevelLower = topLevel.toLowerCase();
    let tar;
    try {
        tar = gunzipSync(compressed, { maxOutputLength: limits.maxBytes });
    }
    catch (error) {
        if (isSizeError(error)) {
            throw new ArchiveError("limit", `the repository snapshot exceeds the ${limits.maxBytes}-byte uncompressed cap`);
        }
        throw new ArchiveError("malformed", `the repository snapshot is not readable gzip data (${display(error instanceof Error ? error.message : String(error), 120)})`);
    }
    if (tar.length > limits.maxBytes) {
        throw new ArchiveError("limit", `the repository snapshot exceeds the ${limits.maxBytes}-byte uncompressed cap`);
    }
    if (tar.length % BLOCK !== 0 || tar.length === 0) {
        throw new ArchiveError("malformed", `the repository snapshot is not a whole number of ${BLOCK}-byte tar blocks`);
    }
    const files = [];
    const seen = new Set();
    let totalBytes = 0;
    let offset = 0;
    let pendingName;
    let pendingPax;
    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        if (isZeroBlock(header))
            break;
        const typeByte = header[156] ?? 0;
        const type = typeByte === 0 ? "\\0" : String.fromCharCode(typeByte);
        const magic = readField(header.subarray(257, 263));
        if (!magic.startsWith("ustar")) {
            throw new ArchiveError("malformed", `tar header at offset ${offset} has unrecognised magic "${display(magic, 16)}"`);
        }
        verifyChecksum(header, offset);
        const size = parseNumeric(header.subarray(124, 136));
        if (size === undefined)
            throw new ArchiveError("malformed", `tar header at offset ${offset} has an unreadable size field`);
        const dataStart = offset + BLOCK;
        if (dataStart + size > tar.length) {
            throw new ArchiveError("malformed", `tar entry at offset ${offset} declares ${size} bytes but the archive ends early`);
        }
        const data = tar.subarray(dataStart, dataStart + size);
        offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
        // Metadata entries apply to the entry that follows them.
        if (typeByte === 0x78) {
            // 'x' — pax extended header for the next entry
            pendingPax = parsePax(data);
            continue;
        }
        if (typeByte === 0x67)
            continue; // 'g' — global pax; nothing it carries affects extraction here
        if (typeByte === 0x4c) {
            // 'L' — GNU long name for the next entry
            pendingName = readCString(data);
            continue;
        }
        if (typeByte === 0x4b)
            continue; // 'K' — GNU long linkname; no link is ever materialized
        const fieldName = joinUstarName(header);
        const rawName = pendingName ?? pendingPax?.["path"] ?? fieldName;
        pendingName = undefined;
        pendingPax = undefined;
        // A name ending in "/" is a directory marker by tar convention, even when
        // the type byte says "regular file" — GitHub's own archives mix both forms.
        const isDirectory = typeByte === 0x35 || rawName.endsWith("/");
        const resolved = resolveEntryName(rawName, topLevelLower, isDirectory, maxPathLength);
        if (isDirectory)
            continue;
        if (typeByte !== 0 && typeByte !== 0x30 && typeByte !== 0x37) {
            throw new ArchiveError("unsupported-entry", `archive entry "${display(rawName)}" is not a regular file (tar type "${type}"); links and device nodes are never materialized`);
        }
        if (resolved === "") {
            throw new ArchiveError("unsafe", `archive entry "${display(rawName)}" is the top-level directory, not a file`);
        }
        if (seen.has(resolved)) {
            throw new ArchiveError("unsafe", `archive path "${display(resolved)}" appears more than once; refusing an ambiguous snapshot`);
        }
        if (files.length >= limits.maxFiles) {
            throw new ArchiveError("limit", `the repository snapshot holds more than ${limits.maxFiles} files`);
        }
        if (totalBytes + data.byteLength > limits.maxBytes) {
            throw new ArchiveError("limit", `the repository snapshot exceeds the ${limits.maxBytes}-byte uncompressed cap`);
        }
        seen.add(resolved);
        files.push({ path: resolved, bytes: data });
        totalBytes += data.byteLength;
    }
    return { files, totalBytes };
}
/** ustar splits long names across `prefix` (155) + `name` (100). */
function joinUstarName(header) {
    const prefix = readField(header.subarray(345, 500));
    const name = readField(header.subarray(0, 100));
    return prefix === "" ? name : `${prefix}/${name}`;
}
//# sourceMappingURL=archive.js.map