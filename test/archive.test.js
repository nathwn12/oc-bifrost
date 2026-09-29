import { test } from "node:test"
import assert from "node:assert/strict"
import { gzipSync } from "node:zlib"
import { ArchiveError, readTarGz } from "../dist/archive.js"
import { BLOCK, base256, entry, gnuNameEntry, paxEntry, paxRecord, rawHeader, tar } from "./helpers/tar.js"

/**
 * The github: snapshot reader — real gzip fixtures, built in memory, never a
 * network call. The reader is the untrusted-input boundary: this suite proves
 * prefix stripping, ustar prefix + pax (x/g) + GNU long-name (L) handling,
 * traversal/absolute/link refusal, and that caps refuse rather than truncate.
 */

const SHA = "abcdef1234567890abcdef1234567890abcdef12"
const PREFIX = `repo-${SHA}`

/** Run the reader and return the ArchiveError kind, failing if it does not refuse. */
function refusalKind(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof ArchiveError, `expected an ArchiveError, got ${error}`)
    return error.kind
  }
  assert.fail("expected the reader to refuse")
}

const LIMITS = { maxBytes: 1024 * 1024, maxFiles: 100 }

function read(buffer, limits = LIMITS, prefix = PREFIX) {
  return readTarGz(buffer, prefix, limits)
}

/* ---- happy paths ---- */

test("readTarGz: strips the top-level directory and returns regular files with their bytes", () => {
  const contents = read(gzipSync(tar(
    entry(`${PREFIX}/`),                                   // the top-level directory itself
    entry(`${PREFIX}/a.txt`, "hello"),
    entry(`${PREFIX}/dir/`),                               // a subdirectory
    entry(`${PREFIX}/dir/b.bin`, Buffer.from([0, 1, 2, 255])),
    entry(`${PREFIX}/empty.txt`, ""),
  )))
  assert.deepEqual(contents.files.map((f) => f.path), ["a.txt", "dir/b.bin", "empty.txt"])
  assert.equal(Buffer.from(contents.files[0].bytes).toString("utf8"), "hello")
  assert.deepEqual([...contents.files[1].bytes], [0, 1, 2, 255])
  assert.equal(contents.files[2].bytes.byteLength, 0)
  assert.equal(contents.totalBytes, 5 + 4)
})

test("readTarGz: joins the ustar prefix field (GitHub archives use it for long paths)", () => {
  const contents = read(gzipSync(tar(
    entry("deep/leaf.txt", "prefixed", { prefix: PREFIX }),
  )))
  assert.deepEqual(contents.files.map((f) => f.path), ["deep/leaf.txt"])
})

test("readTarGz: a pax extended header (x) names the entry that follows it", () => {
  const long = `deep/${"x".repeat(160)}.txt`
  const contents = read(gzipSync(tar(
    paxEntry([["path", `${PREFIX}/${long}`]]),
    entry("deep/truncated-that-does-not-matter.txt", "pax bytes"),
  )))
  assert.deepEqual(contents.files.map((f) => f.path), [long])
})

test("readTarGz: a GNU long-name entry (L) names the entry that follows it", () => {
  const long = `lib/${"y".repeat(140)}.js`
  const contents = read(gzipSync(tar(
    gnuNameEntry(`${PREFIX}/${long}`),
    entry("lib/short.js", "gnu bytes"),
  )))
  assert.deepEqual(contents.files.map((f) => f.path), [long])
})

test("readTarGz: a global pax header (g) is tolerated and does not disturb paths", () => {
  const contents = read(gzipSync(tar(
    entry("GlobalHead.0", paxRecord("comment", SHA), { type: "g" }),
    entry(`${PREFIX}/ok.txt`, "still here"),
  )))
  assert.deepEqual(contents.files.map((f) => f.path), ["ok.txt"])
})

test("readTarGz: a GNU base-256 size field is read (sizes past octal range)", () => {
  const data = "1234567890"
  const contents = read(gzipSync(tar(
    { header: rawHeader({ name: `${PREFIX}/big.txt`, sizeField: base256(data.length) }), body: Buffer.from(data) },
  )))
  assert.deepEqual(contents.files.map((f) => f.path), ["big.txt"])
  assert.equal(Buffer.from(contents.files[0].bytes).toString("utf8"), data)
})

test("readTarGz: an empty archive is empty, not an error", () => {
  const contents = read(gzipSync(Buffer.alloc(BLOCK * 2)))
  assert.deepEqual(contents, { files: [], totalBytes: 0 })
})

/* ---- untrusted input: refusals ---- */

test("readTarGz: absolute paths, traversal, empty/dot segments, backslashes, NUL and `:` are refused as unsafe", () => {
  for (const bad of [
    "/etc/passwd",
    `${PREFIX}/../evil`,
    `${PREFIX}/a/../../evil`,
    `${PREFIX}//double`,
    `${PREFIX}/./dot`,
    `${PREFIX}/bad\\backslash.txt`,
    `${PREFIX}/nul\0name.txt`,
    `${PREFIX}/ads:stream.txt`,
  ]) {
    assert.equal(refusalKind(() => read(gzipSync(tar(entry(bad, "x"))))), "unsafe", `expected unsafe for ${JSON.stringify(bad)}`)
  }
})

test("readTarGz: an entry outside the expected top-level directory is refused as unsafe", () => {
  assert.equal(refusalKind(() => read(gzipSync(tar(entry("other-repo/plugin.ts", "x"))))), "unsafe")
  assert.equal(refusalKind(() => read(gzipSync(tar(entry(`${PREFIX}/x.txt`, "x"))), LIMITS, "different-repo")), "unsafe")
})

test("readTarGz: duplicates are refused as unsafe (a snapshot is never ambiguous)", () => {
  assert.equal(refusalKind(() => read(gzipSync(tar(
    entry(`${PREFIX}/same.txt`, "first"),
    entry(`${PREFIX}/same.txt`, "second"),
  )))), "unsafe")
})

test("readTarGz: symlinks, hardlinks, devices and FIFOs are refused, never materialized", () => {
  for (const type of ["1", "2", "3", "4", "6"]) {
    assert.equal(
      refusalKind(() => read(gzipSync(tar(entry(`${PREFIX}/link`, "", { type, linkname: "../../outside" }))))),
      "unsupported-entry",
      `expected unsupported-entry for tar type ${type}`,
    )
  }
})

test("readTarGz: a malformed archive is refused (checksum, truncation, magic)", () => {
  assert.equal(refusalKind(() => read(gzipSync(tar({
    header: rawHeader({ name: `${PREFIX}/bad.txt`, size: 4, badChecksum: true }),
    body: Buffer.from("data"),
  })))), "malformed")

  // Declares 4096 bytes but carries none.
  assert.equal(refusalKind(() => read(gzipSync(Buffer.concat([
    rawHeader({ name: `${PREFIX}/missing.txt`, size: 4096 }),
    Buffer.alloc(BLOCK * 2),
  ])))), "malformed")

  // Not a whole number of tar blocks.
  assert.equal(refusalKind(() => read(gzipSync(Buffer.concat([rawHeader({ name: `${PREFIX}/x.txt` }), Buffer.alloc(10)])))), "malformed")

  // Not gzip at all.
  assert.equal(refusalKind(() => read(Buffer.from("not gzip"))), "malformed")
})

/* ---- caps: refuse, never truncate ---- */

test("readTarGz: the uncompressed cap is enforced by the gunzip itself", () => {
  const big = tar(entry(`${PREFIX}/big.txt`, "z".repeat(4096)))
  assert.equal(refusalKind(() => read(gzipSync(big), { maxBytes: 1024, maxFiles: 100 })), "limit")
})

test("readTarGz: the file-count cap is enforced before the offending file is returned", () => {
  const archive = gzipSync(tar(
    entry(`${PREFIX}/a.txt`, "a"),
    entry(`${PREFIX}/b.txt`, "b"),
    entry(`${PREFIX}/c.txt`, "c"),
  ))
  assert.equal(refusalKind(() => read(archive, { maxBytes: 1024 * 1024, maxFiles: 2 })), "limit")
  assert.equal(read(archive, { maxBytes: 1024 * 1024, maxFiles: 3 }).files.length, 3)
})

test("readTarGz: the path-length cap is enforced", () => {
  assert.equal(refusalKind(() => read(
    gzipSync(tar(entry(`${PREFIX}/longer/than/eight.txt`, "x"))),
    { maxBytes: 1024 * 1024, maxFiles: 100, maxPathLength: 8 },
  )), "limit")
})

test("readTarGz: an invalid top-level name is refused before any parsing", () => {
  const archive = gzipSync(tar(entry(`${PREFIX}/x.txt`, "x")))
  assert.equal(refusalKind(() => readTarGz(archive, "", LIMITS)), "unsafe")
  assert.equal(refusalKind(() => readTarGz(archive, "a/b", LIMITS)), "unsafe")
})
