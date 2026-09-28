/**
 * vendor-lib — pure, testable helpers for the vendored-copy updater.
 *
 * The updater writes bytes it downloaded, so every step that could corrupt the
 * repo is extracted here as a pure function that can be tested offline:
 * hashing, the content gate, the pin rewrite, and the provenance table. The CLI
 * is then only orchestration.
 */
import { createHash } from "node:crypto"

const MAX_BYTES = 64 * 1024

/** sha1 over `"blob <byteLength>\0" + bytes` — the exact git blob hash. Buffer or string in. */
export function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8")
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8")
  return createHash("sha1").update(Buffer.concat([header, bytes])).digest("hex")
}

/** sha256 hex of the raw bytes. Buffer or string in. */
export function sha256Hex(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8")
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * A cheap "obviously-not-source" sanity check — NOT the verification gate.
 *
 * It catches the crudest failures (an empty response, a huge file, an HTML
 * error page, something with no source shape at all), but a word sniff proves
 * nothing about provenance. The real gate is external: the updater matches our
 * computed git blob against GitHub's own recorded blob id (network path), or
 * requires an independently supplied digest (`--expect-sha256` / `--expect-blob`,
 * offline path). Returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function validateVendorFile(text) {
  if (typeof text !== "string") return { ok: false, reason: "content is not a string" }

  if (text.trim() === "") return { ok: false, reason: "file is empty or whitespace-only" }

  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > MAX_BYTES) {
    return { ok: false, reason: `file is ${bytes} bytes, larger than the ${MAX_BYTES}-byte limit` }
  }

  if (/<html/i.test(text) || /<!DOCTYPE/i.test(text)) {
    return { ok: false, reason: "content looks like an HTML error page, not source" }
  }

  if (!/\bexport\b/.test(text) || !/\bPlugin\b/.test(text)) {
    return { ok: false, reason: "content does not look like an OpenCode plugin (needs both `export` and `Plugin`)" }
  }

  return { ok: true }
}

/**
 * Replace the rtk preset's `version: "..."` line. Throws unless the source
 * contains exactly one match — never guess which preset to rewrite.
 *
 * Uses a replacement callback so the new version is inserted LITERALLY: a
 * version string containing `$&`, `$1`, or `$'` can never be interpreted as a
 * replacement token and corrupt the pin.
 */
export function rewritePin(source, version) {
  const pattern = /^(\s*version:\s*")([^"]*)(")/gm
  const matches = [...source.matchAll(pattern)]
  if (matches.length === 0) {
    throw new Error('no `version: "..."` line found; refusing to rewrite the pin')
  }
  if (matches.length > 1) {
    throw new Error(`expected exactly one \`version: "..."\` line, found ${matches.length}; refusing to guess`)
  }
  return source.replace(pattern, (_match, prefix, _current, suffix) => `${prefix}${version}${suffix}`)
}

/** Whether a ref is safe to interpolate into a URL and to record in the pin. */
export function isValidRef(ref) {
  if (typeof ref !== "string" || ref === "") return false
  if (ref.startsWith("-")) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false
  if (ref.includes("..")) return false
  return true
}

/**
 * Render the provenance table exactly as it appears in `vendor/README.md`.
 * Returned without a trailing newline so callers control the surrounding text.
 */
export function renderProvenanceTable(meta) {
  return [
    "| Field | Value |",
    "|---|---|",
    `| Upstream | [\`${meta.upstream}\`](https://github.com/${meta.upstream}) |`,
    `| Upstream path | \`${meta.path}\` |`,
    `| Version | \`${meta.ref}\` |`,
    `| Git blob | \`${meta.gitBlob}\` |`,
    `| sha256 | \`${meta.sha256}\` |`,
    `| Bytes | ${meta.bytes} |`,
    `| License | ${meta.license} — full text in \`rtk-LICENSE\` |`,
    "| Upstream disclaimer | `rtk-DISCLAIMER.md` |",
    "| **Changes** | **none — byte-identical** |",
  ].join("\n")
}
