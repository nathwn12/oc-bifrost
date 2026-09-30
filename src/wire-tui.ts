/**
 * wire-tui: opt-in TUI wiring for a provisioned snapshot.
 *
 * A provisioned snapshot's TUI entry loads into the OpenCode client when
 * (a) a `tui.tsx` wrapper exists at the tree root re-exporting the real
 * entry, and (b) the harness `cli.json` carries a `plugins` entry that is the
 * tree as a `file://` URL. This module automates both steps:
 *
 *   - WRAPPER, IDEMPOTENT. `tui.tsx` is created ONLY when the tree lacks a
 *     loadable `tui.{ts,tsx}` - a file that exists but is a directory does
 *     NOT count as loadable. A loadable entry means no write, ever. When the
 *     wrapper cannot be created (the `tui.tsx` path is blocked by a
 *     directory) the module refuses loudly.
 *   - CLI.JSON, TEXT MERGE. The merge is a read-as-text splice that touches
 *     ONLY the top-level `plugins` key: `$schema`, comments, every other
 *     key, and their exact formatting survive byte-for-byte. Entry form is
 *     exactly `url.pathToFileURL(treeDir).href` (forward slashes - the live,
 *     load-verified entry form); dedupe is by that exact string. When the
 *     key is absent it is created in a safe position (after `$schema`, or at
 *     the top of the object) with a byte marker identifying it as ours; when
 *     it exists, our entry is appended with its own inline marker and the
 *     user's entries and layout are preserved as-is.
 *   - CONCURRENT WRITER. The live client rewrites cli.json itself, so every
 *     write is guarded: the file's mtime is recorded before reading; if it
 *     changed before the write the file is re-read and re-merged - up to 3
 *     attempts, then the module refuses loudly and writes nothing. The write
 *     itself is atomic (a same-directory temp file renamed over the target),
 *     so an interrupt cannot truncate the user's global config.
 *   - AMBIGUITY REFUSES LOUDLY. When the formatting cannot be located
 *     confidently (not a balanced JSONC object, a non-array `plugins` value,
 *     an unbalanced array), the module refuses with an `[oc-bifrost]`-
 *     prefixed message naming the failing path. It never guess-writes. The
 *     spliced result is re-tokenized and validated before the write, so a bad
 *     splice refuses instead of corrupting the file.
 *   - UNWIRE. `unwireTui` removes only what `wireTui` added - entries found
 *     under our own markers, and the whole key it auto-created once the
 *     array is empty again - byte-preserving everything else. Entries that
 *     were present before wiring are never removed (an identical user entry
 *     is deduped at wire time and left unmarked). Returns true if anything
 *     changed, false if there is nothing of ours to do.
 *
 * The cli.json path is CALLER-PROVIDED: this module never guesses a config
 * directory and never writes a path that was not handed to it. Builtins
 * only; zero runtime dependencies.
 */
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

export const WRAPPER_CONTENT = 'export { default } from "./src/tui/index.tsx";\n'

/** Inside an array WE created: marks the whole key as ours to remove. */
export const CREATED_KEY_MARKER = "// oc-bifrost: managed TUI entry (key auto-created; safe to remove with it)"

/** Immediately above one of OUR entries inside an otherwise user-owned array. */
export const ENTRY_MARKER = "// oc-bifrost: managed TUI entry"

const MAX_ATTEMPTS = 3
const FALLBACK_INDENT = "  "

/** Test-only seam: fires after each read+merge, before the pre-write mtime check. */
export interface WireTuiSeam {
  beforeWrite?: () => void | Promise<void>
}

let testSeam: WireTuiSeam | null = null

export function __setWireTuiSeamForTests(seam: WireTuiSeam | null): void {
  testSeam = seam
}

/** Loud, `[oc-bifrost]`-prefixed refusal naming the failing path. */
function refuse(path: string, why: string): never {
  throw new Error(`[oc-bifrost] refusing to touch ${path}: ${why}`)
}

function isMissing(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT"
}

/* ---- JSONC-lite tokenizer (strings, comments, brackets, commas, ws) ---- */

interface Tok {
  kind: "ws" | "comment" | "string" | "comma" | "bracket" | "other"
  start: number
  end: number
  text: string
}

function tokenize(text: string, path: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      let j = i + 1
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\r" || text[j] === "\n")) j++
      toks.push({ kind: "ws", start: i, end: j, text: text.slice(i, j) })
      i = j
    } else if (c === "/" && text[i + 1] === "/") {
      let j = i + 2
      while (j < text.length && text[j] !== "\n") j++
      if (j < text.length) j++ // carry the end-of-line for line-oriented edits
      toks.push({ kind: "comment", start: i, end: j, text: text.slice(i, j) })
      i = j
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      if (end === -1) refuse(path, "unterminated /* block comment")
      const j = end + 2
      toks.push({ kind: "comment", start: i, end: j, text: text.slice(i, j) })
      i = j
    } else if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      let closed = false
      while (j < text.length) {
        const ch = text[j]!
        if (ch === "\\") {
          j += 2
          continue
        }
        if (ch === quote) {
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) refuse(path, "unterminated string")
      toks.push({ kind: "string", start: i, end: j, text: text.slice(i, j) })
      i = j
    } else if (c === ",") {
      toks.push({ kind: "comma", start: i, end: i + 1, text: "," })
      i++
    } else if (c === "{" || c === "}" || c === "[" || c === "]") {
      toks.push({ kind: "bracket", start: i, end: i + 1, text: c })
      i++
    } else {
      toks.push({ kind: "other", start: i, end: i + 1, text: c })
      i++
    }
  }
  return toks
}

function skipWs(toks: Tok[], i: number): number {
  while (i < toks.length && toks[i]!.kind === "ws") i++
  return i
}

function skipWsAndComments(toks: Tok[], i: number): number {
  while (i < toks.length && (toks[i]!.kind === "ws" || toks[i]!.kind === "comment")) i++
  return i
}

/** Char-level skip of whitespace and comments (used for splice positions). */
function skipWsCommentsText(text: string, i: number, path: string): number {
  while (i < text.length) {
    const c = text[i]!
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      if (end === -1) refuse(path, "unterminated /* block comment")
      i = end + 2
    } else {
      break
    }
  }
  return i
}

/** The file must be one balanced JSONC object with nothing after its close. */
function validateTopObject(text: string, toks: Tok[], path: string): void {
  const first = skipWsAndComments(toks, 0)
  const f = toks[first]
  if (!f || f.kind !== "bracket" || f.text !== "{") refuse(path, "the file is not a JSONC object")
  let depth = 0
  let sealed = false
  for (const t of toks) {
    if (sealed) {
      if (t.kind !== "ws" && t.kind !== "comment") refuse(path, "unexpected content after the top-level object")
      continue
    }
    if (t.kind !== "bracket") continue
    if (t.text === "{" || t.text === "[") depth++
    else {
      depth--
      if (depth < 0) refuse(path, "unbalanced brackets")
      if (depth === 0) sealed = true
    }
  }
  if (!sealed) refuse(path, "unbalanced brackets (no top-level close)")
}

interface PluginsSegment {
  keyTok: Tok
  openTok: Tok
  closeTok: Tok
}

/** FIRST top-level `plugins` key; its value must be an array or we refuse. */
function locatePlugins(toks: Tok[], path: string): PluginsSegment | null {
  let depth = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.kind === "bracket") {
      depth += t.text === "{" || t.text === "[" ? 1 : -1
      continue
    }
    if (t.kind !== "string" || depth !== 1) continue
    const name = t.text
    if (name !== '"plugins"' && name !== "'plugins'") continue
    const nxt = skipWsAndComments(toks, i + 1)
    const colon = toks[nxt]
    if (!colon || colon.kind !== "other" || colon.text !== ":") continue
    const openIdx = skipWsAndComments(toks, nxt + 1)
    const open = toks[openIdx]
    if (!open || open.kind !== "bracket" || open.text !== "[") refuse(path, `"plugins" must be an array`)
    let d = 1
    let closeIdx = -1
    for (let j = openIdx + 1; j < toks.length; j++) {
      const b = toks[j]!
      if (b.kind !== "bracket") continue
      if (b.text === "{" || b.text === "[") d++
      else if (--d === 0) {
        closeIdx = j
        break
      }
    }
    if (closeIdx === -1) refuse(path, `the "plugins" array is unbalanced`)
    return { keyTok: t, openTok: open, closeTok: toks[closeIdx]! }
  }
  return null
}

/** Top-level `$schema` key whose value is a string; value end position. */
function locateSchema(toks: Tok[], path: string): { valueEnd: number } | null {
  let depth = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.kind === "bracket") {
      depth += t.text === "{" || t.text === "[" ? 1 : -1
      continue
    }
    if (t.kind !== "string" || depth !== 1) continue
    if (t.text !== '"$schema"' && t.text !== "'$schema'") continue
    const nxt = skipWsAndComments(toks, i + 1)
    const colon = toks[nxt]
    if (!colon || colon.kind !== "other" || colon.text !== ":") continue
    const valIdx = skipWsAndComments(toks, nxt + 1)
    const val = toks[valIdx]
    if (!val || val.kind !== "string") return null
    return { valueEnd: val.end }
  }
  return null
}

/** Indentation of the first key line after `{` (fallback: two spaces). */
function detectIndent(text: string, afterBrace: number): string {
  const nl = text.indexOf("\n", afterBrace)
  if (nl === -1) return FALLBACK_INDENT
  let j = nl + 1
  let indent = ""
  while (j < text.length && (text[j] === " " || text[j] === "\t")) {
    indent += text[j]!
    j++
  }
  if (indent.length === 0 || indent.length > 8) return FALLBACK_INDENT
  return indent
}

function indexOfTok(toks: Tok[], target: Tok): number {
  for (let i = 0; i < toks.length; i++) if (toks[i] === target) return i
  return -1
}

function markerKind(commentText: string): "created" | "entry" | null {
  const clean = (raw: string): string => raw.replace(/^\/\//, "").trim()
  const c = clean(commentText)
  if (c === clean(CREATED_KEY_MARKER)) return "created"
  if (c === clean(ENTRY_MARKER)) return "entry"
  return null
}

/**
 * Pure merge: splice ONLY the top-level `plugins` key. Returns null when
 * nothing changes (the exact entry already exists - dedupe), the new text
 * otherwise.
 */
function mergePluginsEntry(text: string, entry: string, path: string): string | null {
  const toks = tokenize(text, path)
  validateTopObject(text, toks, path)
  const seg = locatePlugins(toks, path)
  const quoted = JSON.stringify(entry)
  const braceTok = toks[skipWsAndComments(toks, 0)]!
  const ind2 = detectIndent(text, braceTok.end) + FALLBACK_INDENT

  if (seg) {
    const startIdx = indexOfTok(toks, seg.openTok)
    const endIdx = indexOfTok(toks, seg.closeTok)
    let lastSig: Tok | null = null
    let depth = 1
    for (let i = startIdx + 1; i < endIdx; i++) {
      const t = toks[i]!
      if (t.kind === "bracket") {
        depth += t.text === "{" || t.text === "[" ? 1 : -1
        continue
      }
      if (depth !== 1) continue
      if (t.kind === "string" && t.text === quoted) return null // dedupe by exact string
      if (t.kind !== "ws" && t.kind !== "comment") lastSig = t
    }
    let unit: string
    if (!lastSig) {
      unit = `${ENTRY_MARKER}\n${quoted}` // byte-exact restorable empty array: [// marker\n"entry"]
    } else if (lastSig.kind === "comma") {
      unit = `\n${ind2}${ENTRY_MARKER}\n${ind2}${quoted}`
    } else {
      unit = `,\n${ind2}${ENTRY_MARKER}\n${ind2}${quoted}`
    }
    return text.slice(0, seg.closeTok.start) + unit + text.slice(seg.closeTok.start)
  }

  // No plugins key: create one at a safe position, marked as ours.
  const ind = detectIndent(text, braceTok.end)
  const unitBody = `\n${ind}"plugins": [\n${ind}${FALLBACK_INDENT}${CREATED_KEY_MARKER}\n${ind}${FALLBACK_INDENT}${quoted}\n${ind}]`
  const schema = locateSchema(toks, path)
  let at: number
  let sep = ""
  if (schema) {
    const nxt = skipWsCommentsText(text, schema.valueEnd, path)
    if (nxt < text.length && text[nxt] === ",") {
      at = nxt + 1
      const after = skipWsCommentsText(text, at, path)
      if (after < text.length && text[after] !== "}") sep = ","
    } else if (nxt >= text.length || text[nxt] === "}") {
      at = schema.valueEnd
    } else {
      refuse(path, `cannot find a safe place to insert the "plugins" key after "$schema"`)
    }
  } else {
    at = braceTok.end
    const nxt = skipWsCommentsText(text, at, path)
    if (nxt >= text.length || text[nxt] === "}") sep = ""
    else sep = ","
  }
  return text.slice(0, at) + unitBody + sep + text.slice(at)
}

/**
 * Pure unwire: remove only what we added, byte-preserving everything else.
 * Returns null when there is nothing of ours to remove.
 */
function unmergePlugins(text: string, path: string): string | null {
  const toks = tokenize(text, path)
  validateTopObject(text, toks, path)
  const seg = locatePlugins(toks, path)
  if (!seg) return null

  const startIdx = indexOfTok(toks, seg.openTok)
  const endIdx = indexOfTok(toks, seg.closeTok)

  const spans: Array<[number, number]> = []
  let createdSeen = false
  let removedAny = false
  let depth = 1
  for (let i = startIdx + 1; i < endIdx; i++) {
    const t = toks[i]!
    if (t.kind === "bracket") {
      depth += t.text === "{" || t.text === "[" ? 1 : -1
      continue
    }
    if (depth !== 1 || t.kind !== "comment") continue
    const kind = markerKind(t.text)
    if (!kind) continue
    if (kind === "created") createdSeen = true
    // Our marker's entry is the next string with only whitespace between.
    let j = i + 1
    while (j < endIdx && toks[j]!.kind === "ws") j++
    // The marker's own line whitespace is ours too; a comma straight before
    // it is the separator we wrote (or one we take so the restored array
    // keeps no dangling separator); anything else ends our ownership.
    let p = i - 1
    while (p >= 0 && toks[p]!.kind === "ws") p--
    const prev = toks[p]
    let spanStart = t.start
    // ONE separator per span. A comma straight before the marker is the
    // separator we wrote (or the user's dangling comma the restore must
    // shed); the marker's own line whitespace is ours too. Claiming the
    // separator on the other side as well would splice out the separator a
    // surviving user neighbour still needs (M27: `"a" "b"`, unparseable).
    const ownsLeading = prev !== undefined && prev.kind === "comma"
    if (ownsLeading) spanStart = prev.start
    else if (prev) spanStart = prev.end
    let spanEnd = t.end
    const candidate = toks[j]
    if (candidate && candidate.kind === "string") {
      spanEnd = candidate.end
      let k = j + 1
      while (k < endIdx && toks[k]!.kind === "ws") k++
      const after = toks[k]
      // Entry at the array head has no leading comma, so it owns the trailing
      // one instead; otherwise the trailing comma stays for the next neighbour.
      if (after && after.kind === "comma" && !ownsLeading) spanEnd = after.end
      j = k
    }
    // An orphan marker line is removed alone (we own it either way).
    spans.push([spanStart, spanEnd])
    removedAny = true
    i = j
  }
  if (!removedAny) return null

  const covered = (pos: number): boolean => spans.some(([a, b]) => pos >= a && pos < b)
  let residualSignificant = false
  for (let i = startIdx + 1; i < endIdx && !residualSignificant; i++) {
    const t = toks[i]!
    if (covered(t.start)) continue
    if (t.kind !== "ws" && t.kind !== "comment") residualSignificant = true
  }

  if (!residualSignificant && createdSeen) {
    // The array we created is empty again: take the whole key back out.
    const keyStart = seg.keyTok.start
    const nl = text.lastIndexOf("\n", keyStart - 1)
    if (nl === -1) refuse(path, `cannot confidently locate the start of the auto-created "plugins" key`)
    const between = text.slice(nl + 1, keyStart)
    if (between.trim() !== "") refuse(path, `cannot confidently unwire: other content shares the line with the auto-created "plugins" key`)
    const closeEnd = seg.closeTok.end
    let end = closeEnd
    if (text[closeEnd] === ",") end = closeEnd + 1 // the separator we wrote
    else {
      const nxt = skipWsCommentsText(text, closeEnd, path)
      if (nxt < text.length && text[nxt] !== "}") refuse(path, `cannot confidently unwire: unexpected content after the auto-created "plugins" key`)
    }
    return text.slice(0, nl) + text.slice(end)
  }

  // Adjacent owned entries produce overlapping spans (the separator comma is
  // claimed by both neighbours). Coalesce before slicing: each span's offsets
  // are relative to the ORIGINAL text, so applying an overlapping span after
  // an earlier cut would silently shift and corrupt the file - merging first
  // keeps every cut offset-safe.
  spans.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([span[0], span[1]])
  }
  let out = ""
  let cursor = 0
  for (const [a, b] of merged) {
    out += text.slice(cursor, a)
    cursor = b
  }
  return out + text.slice(cursor)
}

/**
 * Strict post-splice validation, run BEFORE the write. The result must still
 * be one balanced JSONC object, and any `plugins` array it carries must be
 * comma-separated with no missing or stray separators - so a bad splice can
 * only ever refuse, never corrupt the user's cli.json (M27's `"a" "b"`).
 */
function validateSpliced(text: string, path: string): void {
  const toks = tokenize(text, path)
  validateTopObject(text, toks, path)
  const seg = locatePlugins(toks, path)
  if (!seg) return
  const startIdx = indexOfTok(toks, seg.openTok)
  const endIdx = indexOfTok(toks, seg.closeTok)
  let expectValue = true
  for (let i = startIdx + 1; i < endIdx; i++) {
    const t = toks[i]!
    if (t.kind === "ws" || t.kind === "comment") continue
    if (t.kind === "comma") {
      if (expectValue) refuse(path, `the spliced "plugins" array has a stray or doubled comma`)
      expectValue = true
      continue
    }
    if (!expectValue) refuse(path, `the spliced "plugins" array is missing a comma between entries`)
    if (t.kind === "bracket") {
      // Consume one nested object/array value wholesale.
      const open = t.text === "{" || t.text === "["
      if (!open) refuse(path, `the spliced "plugins" array is unbalanced`)
      let d = 1
      while (i + 1 < endIdx) {
        i++
        const b = toks[i]!
        if (b.kind === "bracket") d += b.text === "{" || b.text === "[" ? 1 : -1
        if (d === 0) break
      }
      if (d !== 0) refuse(path, `the spliced "plugins" array is unbalanced`)
    }
    expectValue = false
  }
}

/**
 * Read -> merge/unmerge -> mtime check -> write, re-reading up to 3 attempts
 * when a concurrent writer moves the file between our read and write.
 * Returns true when a write happened.
 */
async function readMergeWriteStable(
  cliJsonPath: string,
  missing: "refuse" | "noop",
  transform: (text: string) => string | null,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let before
    try {
      before = await stat(cliJsonPath)
    } catch (e) {
      if (isMissing(e) && missing === "noop") return false
      refuse(cliJsonPath, `cannot stat the file: ${e instanceof Error ? e.message : String(e)}`)
    }
    let text: string
    try {
      text = await readFile(cliJsonPath, "utf8")
    } catch (e) {
      refuse(cliJsonPath, `cannot read the file: ${e instanceof Error ? e.message : String(e)}`)
    }
    const next = transform(text)
    if (next === null) return false // nothing to change
    validateSpliced(next, cliJsonPath)
    if (testSeam?.beforeWrite) await testSeam.beforeWrite()
    const after = await stat(cliJsonPath).catch(() => null)
    if (after === null) refuse(cliJsonPath, "the file disappeared between read and write")
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      if (attempt === MAX_ATTEMPTS) {
        refuse(
          cliJsonPath,
          `the file changed concurrently on all ${MAX_ATTEMPTS} attempts (mtime moved between read and write); nothing was written - re-run to retry`,
        )
      }
      continue
    }
    // Atomic replace: a temp file in the SAME directory then a rename over the
    // target, so an interrupt can never leave the user's global config
    // truncated. The mtime/size race check above still gates the rename.
    const tmp = join(dirname(cliJsonPath), `.${basename(cliJsonPath)}.oc-bifrost-${process.pid}-${attempt}-${Date.now()}.tmp`)
    try {
      await writeFile(tmp, next, "utf8")
      await rename(tmp, cliJsonPath)
    } catch (e) {
      await unlink(tmp).catch(() => {})
      refuse(cliJsonPath, `cannot write the file: ${e instanceof Error ? e.message : String(e)}`)
    }
    return true
  }
  return false // unreachable (refuse throws)
}

async function ensureWrapper(treeDir: string): Promise<string | null> {
  const wrapperPath = join(treeDir, "tui.tsx")
  let blockedByDirectory = false
  for (const name of ["tui.ts", "tui.tsx"]) {
    let st
    try {
      st = statSync(join(treeDir, name))
    } catch {
      continue // absent: not loadable
    }
    if (st.isFile()) return null // a loadable entry already exists
    if (name === "tui.tsx" && st.isDirectory()) blockedByDirectory = true
  }
  if (blockedByDirectory) {
    throw new Error(`[oc-bifrost] refusing to create TUI wrapper ${wrapperPath}: a directory occupies that path`)
  }
  try {
    await writeFile(wrapperPath, WRAPPER_CONTENT, "utf8")
  } catch (e) {
    throw new Error(
      `[oc-bifrost] refusing to create TUI wrapper ${wrapperPath}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return wrapperPath
}

/**
 * Wire a provisioned tree's TUI entry: ensure the root wrapper, then add the
 * tree (as a `file://` URL) to the plugins array of the caller-provided
 * cli.json, byte-preserving everything else (see the module contract).
 */
export async function wireTui(treeDir: string, cliJsonPath: string): Promise<{ wrapper: string | null; entry: string }> {
  const entry = pathToFileURL(treeDir).href
  const wrapper = await ensureWrapper(treeDir)
  await readMergeWriteStable(cliJsonPath, "refuse", (text) => mergePluginsEntry(text, entry, cliJsonPath))
  return { wrapper, entry }
}

/**
 * Remove only what wireTui added from the caller-provided cli.json. Returns
 * true when anything changed, false when there is nothing of ours to do.
 */
export async function unwireTui(cliJsonPath: string): Promise<boolean> {
  return readMergeWriteStable(cliJsonPath, "noop", (text) => unmergePlugins(text, cliJsonPath))
}