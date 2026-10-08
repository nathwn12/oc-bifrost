/**
 * wire-tui: opt-in TUI wiring for a provisioned snapshot.
 *
 * A provisioned snapshot's TUI entry loads into the OpenCode client when
 * (a) a `tui.tsx` wrapper exists at the tree root re-exporting the real
 * entry, and (b) the harness `cli.json` carries a `plugins` entry that is the
 * tree as a `file://` URL. This module automates both steps:
 *
 *   - WRAPPER, IDEMPOTENT, DERIVED FIRST, AND SKIPPED WHEN THERE IS NOTHING
 *     TO WIRE. The tree's OWN target is derived BEFORE any existing file is
 *     consulted, and `tui.tsx` is created ONLY when the tree lacks a loadable
 *     USER-authored `tui.{ts,tsx}` - a file that exists but is a directory
 *     does NOT count as loadable. A loadable user entry means no write, ever.
 *     The wrapper re-exports the TREE'S OWN tui entry, derived in order from
 *     the tree manifest: `exports["./tui"]` (import/default/require), a
 *     top-level `tui` field, then a discovered `src/tui/index.tsx`.
 *     A wrapper THIS module wrote carries `WRAPPER_MARKER` (or, for a file
 *     the pre-derive 1.4.0 release wrote, the exact legacy bytes): it is ours
 *     to heal, never evidence that the tree ships a TUI. Against the DERIVED
 *     target it is removed when the target is `none`, and rewritten when the
 *     target moved; a user-authored file is never deleted. A user-authored
 *     root `tui.ts` beside a managed `tui.tsx` also takes the managed wrapper
 *     out (Bun probes `.tsx` before `.ts`, so it would shadow the user's
 *     entry) - and the tree stays wired through the user's own file.
 *     Three outcomes, deliberately distinct:
 *       - a derivable target -> the wrapper is written (or already there);
 *       - a tree that ships NO tui entry AT ALL (no declaration, no
 *         discovered `src/tui/index.tsx`, no loadable USER-authored
 *         `tui.{ts,tsx}`) -> a clean SKIP: any managed wrapper is removed,
 *         any managed cli.json entry for the tree is unwired, and one
 *         informational row names the tree. A tree without a TUI has nothing
 *         to wire, and a refusal would spam a warning on every reconciliation;
 *       - a DECLARED `./tui` target that is not a real file inside the tree,
 *         or a directory occupying the wrapper path -> a loud refusal. The
 *         manifest says a TUI entry exists, so either writing a hardcoded
 *         wrapper or passing silently would hide a broken tree.
 *   - CLI.JSON, TEXT MERGE. The merge is a read-as-text splice that touches
 *     ONLY the top-level `plugins` key: `$schema`, comments, every other
 *     key, and their exact formatting survive byte-for-byte. Entry form is
 *     exactly `url.pathToFileURL(treeDir).href` (forward slashes - the live,
 *     load-verified entry form); dedupe is by the PARSED entry value, so a
 *     differently-spelled (single-quoted) copy still counts. When the
 *     key is absent it is created in a safe position (after `$schema`, or at
 *     the top of the object) with a byte marker identifying it as ours; when
 *     it exists, our entry is appended with its own inline marker and the
 *     user's entries and layout are preserved as-is. A managed entry marker
 *     carries the plugin's stable key (`[<key>]`) when it is known.
 *   - PRUNE-PREVIOUS-ENTRY (`opts.pluginKey` / `opts.treeFamily`). A
 *     re-provision at a new resolved ref lands in a NEW cache dir, so the
 *     tree's `file://` URL changes and the old entry would otherwise linger
 *     beside the new one. Identity is claimed from the marker WE own, not the
 *     URL: a block keyed with `pluginKey` is pruned exactly (but never the
 *     entry being written, so repeat mounts are byte-stable), a block keyed
 *     differently is never claimed, and a legacy keyless block is claimed
 *     only on an exact canonical-shape match (same owner, repo, and
 *     digest-stripped path tail) - which is what keeps `oc-flight-deck` from
 *     claiming `oc-flight-deck--extra`. Any non-canonical name (`--` inside a
 *     raw part) is left alone. With neither a key nor a family, nothing is
 *     pruned. Only marker-owned blocks are ever pruned: a user entry is never
 *     claimed.
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
 *     is deduped at wire time and left unmarked). A TARGETED unwire (`entry`
 *     argument) claims only the marker that owns exactly that entry, so
 *     healing one tree never unwires another. Returns true if anything
 *     changed, false if there is nothing of ours to do.
 *
 * The cli.json path is CALLER-PROVIDED: this module never guesses a config
 * directory and never writes a path that was not handed to it. Builtins
 * only; zero runtime dependencies.
 *
 * SERVER ENTRY (the `plugin list` fidelity half). A directory entry in
 * cli.json is loaded by the host as a directory: without a loadable server
 * entry at the tree root the host reports the entry with no id (`-`) even
 * though the tree's manifest `exports["."]` names one (a registry install
 * resolves `exports`, a directory load does not). When the caller hands
 * `opts.serverEntry` (the ref's declared entry file, tree-relative), this
 * module ensures a managed root `index.ts` re-exporting exactly that file -
 * the same managed-marker ownership as the TUI wrapper under a distinct
 * marker, never clobbering a user-authored root server entry, removed when a
 * user entry appears beside it. Only on the wired path: a tree with no TUI
 * entry is never registered, so it needs no server entry either.
 */
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/**
 * First line of a wrapper WE wrote: the same ownership marker cli.json uses,
 * so a managed wrapper is identifiable without guessing from its shape.
 */
export const WRAPPER_MARKER = "// oc-bifrost: managed TUI entry"

/**
 * The exact bytes the pre-derive release (1.4.0, commit 890ce33) wrote for
 * EVERY tree, before 1.4.1 (commit 31ffd11) derived the target from the
 * manifest. Unmarked, but ours: nothing else writes a hardcoded
 * `src/tui/index.tsx` re-export. The match is byte-exact, so it is
 * line-ending sensitive: a CRLF-converted legacy wrapper is conservatively
 * treated as a user file - no heal, no harm.
 */
const LEGACY_WRAPPER_CONTENT = 'export { default } from "./src/tui/index.tsx";\n'

/** The `tui.tsx` re-export body for a tree-relative `target` (e.g. `src/tui/index.tsx`). */
export function wrapperContent(target: string): string {
  return `${WRAPPER_MARKER}\n` + `export { default } from "./${target.replace(/^\.\//, "")}";\n`
}

/** Whether `content` is a wrapper this module wrote (marked, or the exact pre-derive artifact). */
function isManagedWrapper(content: string): boolean {
  return content.startsWith(`${WRAPPER_MARKER}\n`) || content === LEGACY_WRAPPER_CONTENT
}

/**
 * First line of a server-entry wrapper WE wrote. Deliberately distinct from
 * `WRAPPER_MARKER` so the TUI heal path can never mistake one for the other
 * (they live at different paths, but markers are the ownership proof).
 */
export const SERVER_WRAPPER_MARKER = "// oc-bifrost: managed server entry"

/** The root `index.ts` re-export body for a tree-relative `target` (e.g. `src/index.ts`). */
export function serverWrapperContent(target: string): string {
  return `${SERVER_WRAPPER_MARKER}\n` + `export { default } from "./${target.replace(/^\.\//, "")}";\n`
}

/** Whether `content` is a server-entry wrapper this module wrote. */
function isManagedServerWrapper(content: string): boolean {
  return content.startsWith(`${SERVER_WRAPPER_MARKER}\n`)
}

/**
 * Root filenames that count as a USER-authored server entry. `index.ts` is
 * the file this module manages, so it is deliberately absent here: the
 * managed marker is checked first, and any other name in this list present
 * as a file means the tree already ships a loadable server entry of its own
 * (never shadowed, never deleted).
 */
const USER_SERVER_ENTRIES = [
  "index.tsx",
  "index.js",
  "index.mjs",
  "index.cjs",
  "plugin.ts",
  "plugin.tsx",
  "plugin.js",
  "plugin.mjs",
  "plugin.cjs",
] as const

/** True when `dir/<name>` exists as a regular file (a link counts as present - conservative). */
function treeHasFile(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isFile()
  } catch {
    return false
  }
}

/** Inside an array WE created: marks the whole key as ours to remove. */
export const CREATED_KEY_MARKER = "// oc-bifrost: managed TUI entry (key auto-created; safe to remove with it)"

/**
 * Immediately above one of OUR entries inside an otherwise user-owned array.
 * When the plugin's stable key is known the marker line carries it as
 * `// oc-bifrost: managed TUI entry [<key>]`; the bare form stays valid for
 * entries written before keys existed.
 */
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

function cleanComment(raw: string): string {
  return raw.replace(/^\/\//, "").trim()
}

/**
 * Marker ownership of a comment token. The exact auto-created-key marker is
 * checked FIRST (it shares the `managed TUI entry` prefix); an entry marker is
 * the bare form or the keyed form `managed TUI entry [<key>]`.
 */
function markerKind(commentText: string): "created" | "entry" | null {
  const c = cleanComment(commentText)
  if (c === cleanComment(CREATED_KEY_MARKER)) return "created"
  const entry = cleanComment(ENTRY_MARKER)
  if (c === entry || c.startsWith(`${entry} [`)) return "entry"
  return null
}

/** The key carried by a keyed entry marker (`... [<key>]`), or null for a bare/legacy marker. */
function markerKey(commentText: string): string | null {
  const c = cleanComment(commentText)
  const prefix = `${cleanComment(ENTRY_MARKER)} [`
  if (!c.startsWith(prefix) || !c.endsWith("]")) return null
  const key = c.slice(prefix.length, c.length - 1)
  return key === "" ? null : key
}

/**
 * The VALUE of a string token, whatever its spelling: the tokenizer accepts
 * JSONC's single-quoted strings, so ownership matching must compare parsed
 * values, not raw token text. Null for a malformed literal (never a match).
 */
function stringValue(text: string): string | null {
  const quote = text[0]
  if ((quote !== '"' && quote !== "'") || text.length < 2 || text[text.length - 1] !== quote) return null
  const simple: Record<string, string> = { '"': '"', "'": "'", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }
  let out = ""
  for (let i = 1; i < text.length - 1; i++) {
    const c = text[i]!
    if (c !== "\\") {
      out += c
      continue
    }
    i++
    const e = text[i]
    if (e === undefined) return null
    if (e === "u") {
      const hex = text.slice(i + 1, i + 5)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
      out += String.fromCharCode(parseInt(hex, 16))
      i += 4
      continue
    }
    const decoded = simple[e]
    if (decoded === undefined) return null
    out += decoded
  }
  return out
}

/**
 * Pure merge: splice ONLY the top-level `plugins` key. Returns null when
 * nothing changes (the exact entry already exists - dedupe), the new text
 * otherwise. When `key` is given the managed entry marker carries it.
 */
function mergePluginsEntry(text: string, entry: string, path: string, key?: string): string | null {
  const toks = tokenize(text, path)
  validateTopObject(text, toks, path)
  const seg = locatePlugins(toks, path)
  const quoted = JSON.stringify(entry)
  const marker = key === undefined ? ENTRY_MARKER : `${ENTRY_MARKER} [${key}]`
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
      if (t.kind === "string" && stringValue(t.text) === entry) return null // dedupe by parsed value
      if (t.kind !== "ws" && t.kind !== "comment") lastSig = t
    }
    let unit: string
    if (!lastSig) {
      unit = `${marker}\n${quoted}` // byte-exact restorable empty array: [// marker\n"entry"]
    } else if (lastSig.kind === "comma") {
      unit = `\n${ind2}${marker}\n${ind2}${quoted}`
    } else {
      unit = `,\n${ind2}${marker}\n${ind2}${quoted}`
    }
    return text.slice(0, seg.closeTok.start) + unit + text.slice(seg.closeTok.start)
  }

  // No plugins key: create one at a safe position, marked as ours. The keyed
  // entry marker rides along so a later re-provision can prune exactly.
  const ind = detectIndent(text, braceTok.end)
  const entryLine = key === undefined ? quoted : `${marker}\n${ind}${FALLBACK_INDENT}${quoted}`
  const unitBody = `\n${ind}"plugins": [\n${ind}${FALLBACK_INDENT}${CREATED_KEY_MARKER}\n${ind}${FALLBACK_INDENT}${entryLine}\n${ind}]`
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
 * With `claim`, a managed marker is claimed only when the entry it owns
 * satisfies the predicate (which receives the parsed entry value and the
 * marker's key, if any); without it, every managed entry is removed. Returns
 * null when there is nothing of ours to remove.
 */
function unmergePlugins(
  text: string,
  path: string,
  claim?: (value: string, key: string | null) => boolean,
): string | null {
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
    // Our marker's entry is the next string with only whitespace between.
    let j = i + 1
    while (j < endIdx && toks[j]!.kind === "ws") j++
    const candidate = toks[j]
    // A claimed unwire claims only the marker whose owned entry satisfies the
    // predicate (which sees the parsed value, so a single-quoted spelling
    // matches, and the marker's key); without a claim every managed marker is
    // ours.
    if (claim !== undefined) {
      const value = candidate && candidate.kind === "string" ? stringValue(candidate.text) : null
      if (value === null || !claim(value, markerKey(t.text))) continue
    }
    if (kind === "created") createdSeen = true
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
    // Resume AT a non-entry candidate (a consecutive marker, e.g. the
    // auto-created key marker directly above the keyed entry marker) so it is
    // processed on its own; when the candidate WAS the owned entry string, `j`
    // is already past it.
    i = candidate && candidate.kind === "string" ? j : j - 1
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

function stripDotSlash(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p
}

/** The runnable path a `./tui` export maps to: `import`, then `default`, then `require`. */
function runnableExportPath(value: unknown): string | null {
  if (typeof value === "string") return stripDotSlash(value)
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of ["import", "default", "require"]) {
    const candidate = record[key]
    if (typeof candidate === "string") return stripDotSlash(candidate)
  }
  return null
}

/** `candidate` as a posix tree-relative path when it names a real file inside `treeDir`; else null. */
function realFileInsideTree(treeDir: string, candidate: string): string | null {
  const resolved = resolve(treeDir, candidate)
  const rel = relative(treeDir, resolved)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null
  try {
    if (!statSync(resolved).isFile()) return null
  } catch {
    return null
  }
  return rel.split(sep).join("/")
}

/** The discovered fallback location of a tree's TUI entry. */
const DISCOVERED_TUI = "src/tui/index.tsx"

/**
 * What the wrapper step learned about the tree's TUI entry:
 *   - `found`            - a real file inside the tree to re-export;
 *   - `declared-missing` - the manifest declares a `./tui` target (export or
 *                          `tui` field) that is NOT a real file inside the
 *                          tree: a broken declaration, refused loudly;
 *   - `none`             - the tree ships no TUI entry at all: skip cleanly.
 */
type TuiTarget =
  | { kind: "found"; target: string }
  | { kind: "declared-missing"; declared: string }
  | { kind: "none" }

/**
 * The tree's own TUI entry, tree-relative. Declaration order:
 * `exports["./tui"]` (import/default/require), then a top-level `tui` field,
 * then the discovered `src/tui/index.tsx`. A declaration is authoritative: a
 * declared target that names no real file inside the tree is reported as
 * `declared-missing` (refused), never silently replaced by a fallback that the
 * manifest does not consider the entry.
 */
function tuiTarget(treeDir: string): TuiTarget {
  const declarations: string[] = []
  let manifest: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(treeDir, "package.json"), "utf8"))
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      manifest = parsed as Record<string, unknown>
    }
  } catch {
    // no readable manifest: fall through to the discovered target
  }
  if (manifest !== null) {
    const exportsValue = manifest.exports
    if (exportsValue !== null && typeof exportsValue === "object" && !Array.isArray(exportsValue)) {
      const fromExport = runnableExportPath((exportsValue as Record<string, unknown>)!["./tui"])
      if (fromExport !== null) declarations.push(fromExport)
    }
    if (typeof manifest.tui === "string") declarations.push(stripDotSlash(manifest.tui))
  }
  for (const declared of declarations) {
    const target = realFileInsideTree(treeDir, declared)
    if (target !== null) return { kind: "found", target }
  }
  const discovered = realFileInsideTree(treeDir, DISCOVERED_TUI)
  if (discovered !== null) return { kind: "found", target: discovered }
  if (declarations.length > 0) return { kind: "declared-missing", declared: declarations[0]! }
  return { kind: "none" }
}

/**
 * The wrapper step's outcome: `wrapped` (this call wrote it), `present` (a
 * loadable entry already exists - no write, ever), `absent` (the tree ships
 * no TUI entry at all - the caller skips the whole wire cleanly), or
 * `stale-removed` (the tree ships no TUI entry and a wrapper an earlier
 * version managed was removed - the caller skips AND unwires).
 */
type WrapperStep =
  | { kind: "wrapped"; wrapper: string }
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "stale-removed" }

/** Remove a wrapper this module owns. Loud on failure, never silent. */
async function removeManagedWrapper(wrapperPath: string): Promise<void> {
  try {
    await unlink(wrapperPath)
  } catch (e) {
    throw new Error(
      `[oc-bifrost] refusing to remove the stale managed TUI wrapper ${wrapperPath}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

async function ensureWrapper(treeDir: string): Promise<WrapperStep> {
  const wrapperPath = join(treeDir, "tui.tsx")

  // Derive the tree's OWN target FIRST. A wrapper is never evidence that the
  // tree ships a TUI entry - only the manifest/discovery may say that.
  const target = tuiTarget(treeDir)

  // Read the wrapper path ONCE: our own wrapper (marked, or the exact legacy
  // bytes) is ours to heal; any other file there is a user's entry.
  let wrapperIsFile = false
  let existingWrapper: string | null = null
  try {
    wrapperIsFile = statSync(wrapperPath).isFile()
    if (wrapperIsFile) existingWrapper = readFileSync(wrapperPath, "utf8")
  } catch {
    // absent, or unreadable: not ours to touch
  }
  const managedWrapper = existingWrapper !== null && isManagedWrapper(existingWrapper)

  // A genuine USER-authored entry file is loadable as-is: never written,
  // never deleted, and its tree stays registered. `tui.ts` cannot be ours -
  // this module only ever writes `tui.tsx`.
  let userTs = false
  try {
    userTs = statSync(join(treeDir, "tui.ts")).isFile()
  } catch {
    userTs = false // absent (or unreadable): not loadable
  }
  if (userTs) {
    // The host probes root `tui` by extension; Bun probes `.tsx` BEFORE `.ts`
    // (`Bun.resolveSync`, packages/util/src/runtime/import.bun.ts:8), so a
    // managed `tui.tsx` would SHADOW the user's entry, while the Node runtime
    // probes `.ts` first (import.node.ts:41). Removing only OUR wrapper makes
    // the resolved entry the user's file under both.
    if (managedWrapper) await removeManagedWrapper(wrapperPath)
    return { kind: "present" }
  }

  // A wrapper WE wrote is ours to heal: remove it when the tree ships no TUI
  // entry, rewrite it when the derived target moved.
  if (managedWrapper) {
    if (target.kind === "none") {
      await removeManagedWrapper(wrapperPath)
      return { kind: "stale-removed" }
    }
    if (target.kind === "declared-missing") {
      throw new Error(
        `[oc-bifrost] refusing to rewrite TUI wrapper ${wrapperPath}: the tree declares "./tui" at ` +
          `"${target.declared}", which is not a real file inside ${treeDir}`,
      )
    }
    const desired = wrapperContent(target.target)
    if (existingWrapper === desired) return { kind: "present" } // idempotent: nothing to write
    try {
      await writeFile(wrapperPath, desired, "utf8")
    } catch (e) {
      throw new Error(
        `[oc-bifrost] refusing to rewrite TUI wrapper ${wrapperPath}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    return { kind: "wrapped", wrapper: wrapperPath }
  }
  if (wrapperIsFile) return { kind: "present" } // a user-authored (or unreadable) tui.tsx

  let blockedByDirectory = false
  try {
    blockedByDirectory = statSync(wrapperPath).isDirectory()
  } catch {
    blockedByDirectory = false // absent: nothing blocks creation
  }
  if (blockedByDirectory) {
    throw new Error(`[oc-bifrost] refusing to create TUI wrapper ${wrapperPath}: a directory occupies that path`)
  }
  if (target.kind === "none") return { kind: "absent" }
  if (target.kind === "declared-missing") {
    throw new Error(
      `[oc-bifrost] refusing to create TUI wrapper ${wrapperPath}: the tree declares "./tui" at ` +
        `"${target.declared}", which is not a real file inside ${treeDir}`,
    )
  }
  try {
    await writeFile(wrapperPath, wrapperContent(target.target), "utf8")
  } catch (e) {
    throw new Error(
      `[oc-bifrost] refusing to create TUI wrapper ${wrapperPath}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return { kind: "wrapped", wrapper: wrapperPath }
}

/**
 * The server-entry step's outcome: `wrapped` (this call wrote the managed
 * root `index.ts`), `present` (a user-authored server entry already exists -
 * no write, ever), or `removed` (a wrapper this module wrote was taken back
 * out because a user entry appeared beside it).
 */
type ServerEntryStep = { kind: "wrapped"; wrapper: string } | { kind: "present" } | { kind: "removed" }

/**
 * Ensure the tree root carries a loadable server entry for the host's
 * directory load: a managed `index.ts` re-exporting the ref's declared
 * `serverEntry` (tree-relative, e.g. `src/index.ts` from the resolve
 * provenance). It is the server half of what the TUI wrapper is for the TUI
 * half: without it the host lists the registered tree with no id (`-`);
 * with it the host reads the entry's own id - the same module the bridge
 * imports directly. A declared target that is not a real file inside the
 * tree is a loud refusal (never a hardcoded guess); a user-authored entry is
 * never written over, and a managed wrapper never shadows one.
 */
async function ensureServerEntry(treeDir: string, serverEntry: string): Promise<ServerEntryStep> {
  const declared = serverEntry.replace(/^\.\//, "")
  const target = !declared.includes("\\") ? realFileInsideTree(treeDir, declared) : null
  if (target === null) {
    throw new Error(
      `[oc-bifrost] refusing to create server-entry wrapper ${join(treeDir, "index.ts")}: ` +
        `the declared server entry "${declared}" is not a real file inside ${treeDir}`,
    )
  }
  const wrapperPath = join(treeDir, "index.ts")
  let existing: string | null = null
  let wrapperIsFile = false
  try {
    wrapperIsFile = statSync(wrapperPath).isFile()
    if (wrapperIsFile) existing = readFileSync(wrapperPath, "utf8")
  } catch {
    // absent, or unreadable: not ours to touch
  }
  const managed = existing !== null && isManagedServerWrapper(existing)
  const userSibling = USER_SERVER_ENTRIES.some((name) => treeHasFile(treeDir, name))
  if (wrapperIsFile && !managed) return { kind: "present" } // a user-authored index.ts
  if (userSibling) {
    // A user entry beside ours wins the probe (or might): never shadow it.
    if (managed) {
      try {
        await unlink(wrapperPath)
      } catch (e) {
        throw new Error(
          `[oc-bifrost] refusing to remove the stale managed server entry ${wrapperPath}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      return { kind: "removed" }
    }
    return { kind: "present" }
  }
  if (managed) {
    const desired = serverWrapperContent(target)
    if (existing === desired) return { kind: "present" } // idempotent: nothing to write
    try {
      await writeFile(wrapperPath, desired, "utf8")
    } catch (e) {
      throw new Error(
        `[oc-bifrost] refusing to rewrite server-entry wrapper ${wrapperPath}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    return { kind: "wrapped", wrapper: wrapperPath }
  }
  if (wrapperIsFile) return { kind: "present" } // an unreadable index.ts: not ours, never touched
  let blockedByDirectory = false
  try {
    blockedByDirectory = statSync(wrapperPath).isDirectory()
  } catch {
    blockedByDirectory = false // absent: nothing blocks creation
  }
  if (blockedByDirectory) {
    throw new Error(`[oc-bifrost] refusing to create server-entry wrapper ${wrapperPath}: a directory occupies that path`)
  }
  try {
    await writeFile(wrapperPath, serverWrapperContent(target), "utf8")
  } catch (e) {
    throw new Error(
      `[oc-bifrost] refusing to create server-entry wrapper ${wrapperPath}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return { kind: "wrapped", wrapper: wrapperPath }
}

/**
 * The outcome of one `wireTui` call:
 *   - `wired`   - the tree's `file://` URL is in cli.json; `wrapper` is the
 *                 wrapper this call wrote, or null when a loadable entry
 *                 already existed;
 *   - `skipped` - the tree ships no TUI entry, so no wrapper and no cli.json
 *                 entry survive the call: a managed wrapper left by an
 *                 earlier version is removed and a managed cli.json entry for
 *                 the tree is unwired. `reason` is the informational row for
 *                 the caller: not a refusal, not a warning.
 */
export type WireTuiOutcome =
  | { kind: "wired"; wrapper: string | null; entry: string; serverEntry: string | null }
  | { kind: "skipped"; reason: string }

/**
 * Whether cli.json already carries this exact tree entry (managed or not).
 * A parsed probe: entries are matched by VALUE, so a single-quoted spelling
 * counts, and the skip/heal path never claims an unwire it did not do. It
 * never validates or edits: an unreadable or malformed file reports "not
 * registered", so a tree unrelated to it still skips instead of refusing.
 */
async function treeIsRegistered(cliJsonPath: string, entry: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(cliJsonPath, "utf8")
  } catch {
    return false
  }
  try {
    const toks = tokenize(text, cliJsonPath)
    validateTopObject(text, toks, cliJsonPath)
    const seg = locatePlugins(toks, cliJsonPath)
    if (!seg) return false
    const startIdx = indexOfTok(toks, seg.openTok)
    const endIdx = indexOfTok(toks, seg.closeTok)
    let depth = 1
    for (let i = startIdx + 1; i < endIdx; i++) {
      const t = toks[i]!
      if (t.kind === "bracket") {
        depth += t.text === "{" || t.text === "[" ? 1 : -1
        continue
      }
      if (depth === 1 && t.kind === "string" && stringValue(t.text) === entry) return true
    }
    return false
  } catch {
    return false // malformed or unreadable: nothing to claim, never a refusal (probe only)
  }
}

/**
 * The `--`-split segments of the cache-directory name a tree `file://` URL
 * points into (`<cacheDir>/tree`): the canonical name is
 * `<owner>--<repo>--<ref>--<path>-<digest>`. Null when the URL is not usable.
 */
function cacheDirSegments(fileUrl: string): string[] | null {
  try {
    return basename(dirname(fileURLToPath(fileUrl))).split("--")
  } catch {
    return null
  }
}

/** The trailing 16-hex-char content digest stripped from a cache name's last segment. */
function stripCacheDigest(segment: string): string {
  return segment.replace(/-[0-9a-f]{16}$/, "")
}

/**
 * Pure prune of the previous MANAGED entries for the SAME plugin. Identity is
 * claimed from the marker we own, never from the URL:
 *   - a KEYED block is claimed when its key equals `pluginKey` AND it is not
 *     the entry we are about to write, so a repeat mount is byte-stable;
 *   - a block keyed differently is never claimed;
 *   - a keyless block (legacy, pre-key) is claimed only on an EXACT shape
 *     match: both cache names canonical (4 `--`-segments), same owner
 *     (index 0), same repo (index 1), and the same digest-stripped last
 *     segment. With our own name canonical the only free token is then
 *     `--<ref>--`, so a name matching owner, repo and the digest-stripped
 *     tail IS this plugin at a different resolved ref - a different plugin
 *     cannot share owner, repo AND path. Anything not matching is left alone
 *     (a stale entry lingers - safe).
 * With neither a key nor a family there is nothing safe to claim: no prune.
 * A user (unmarked) entry is never visible here at all.
 */
function prunePreviousManaged(
  text: string,
  path: string,
  entry: string,
  treeFamily: string | undefined,
  pluginKey: string | undefined,
): string {
  const family = treeFamily ?? ""
  const keyId = pluginKey ?? ""
  if (family === "" && keyId === "") return text
  const ours = cacheDirSegments(entry)
  const claim = (value: string, key: string | null): boolean => {
    if (key !== null) return keyId !== "" && key === keyId && value !== entry
    if (value === entry || !value.startsWith("file://")) return false
    if (family === "" || !value.includes(`/${family}`)) return false
    // Canonical shape only: a `--` inside any raw part inflates the count and
    // makes us SKIP the fallback (conservative - never over-claim).
    if (!ours || ours.length !== 4) return false
    const cand = cacheDirSegments(value)
    if (!cand || cand.length !== 4) return false
    if (cand[0] !== ours[0] || cand[1] !== ours[1]) return false
    return stripCacheDigest(cand[3]!) === stripCacheDigest(ours[3]!)
  }
  return unmergePlugins(text, path, claim) ?? text
}

/**
 * Wire a provisioned tree's TUI entry: ensure the root wrapper, then add the
 * tree (as a `file://` URL) to the plugins array of the caller-provided
 * cli.json, byte-preserving everything else (see the module contract). A tree
 * that ships no TUI entry at all is a clean skip: a stale managed wrapper is
 * removed, a stale managed cli.json entry for the tree is unwired, and
 * nothing else is written. When `opts.pluginKey` / `opts.treeFamily` identify
 * the plugin, its previous MANAGED entries are pruned (by exact key, or by a
 * guarded URL fallback for legacy keyless entries) before the new entry is
 * merged.
 */
export async function wireTui(
  treeDir: string,
  cliJsonPath: string,
  opts?: { treeFamily?: string; pluginKey?: string; serverEntry?: string },
): Promise<WireTuiOutcome> {
  const step = await ensureWrapper(treeDir)
  if (step.kind === "absent" || step.kind === "stale-removed") {
    // Nothing to wire. A tree an earlier version registered before deriving
    // the target first is taken back out - TARGETED at this tree's own entry,
    // so another tree's managed entry is never touched.
    const entry = pathToFileURL(treeDir).href
    const unwired = (await treeIsRegistered(cliJsonPath, entry)) && (await unwireTui(cliJsonPath, entry))
    return {
      kind: "skipped",
      reason:
        step.kind === "stale-removed"
          ? `no TUI entry found in ${treeDir}; removed the stale managed tui.tsx` +
            (unwired ? " and unwired the tree" : "; no managed cli.json entry was unwired")
          : `no TUI entry found in ${treeDir}; nothing to wire`,
    }
  }
  // Server-entry half, wired path only: a tree that is about to be registered
  // needs a loadable root server entry or the host lists it with no id.
  // A refusal here is loud (via the caller) and never aborts the mount.
  let serverWrapper: string | null = null
  if (opts?.serverEntry !== undefined) {
    const server = await ensureServerEntry(treeDir, opts.serverEntry)
    if (server.kind === "wrapped") serverWrapper = server.wrapper
  }
  const entry = pathToFileURL(treeDir).href
  await readMergeWriteStable(cliJsonPath, "refuse", (text) => {
    // A re-provision at a new resolved ref lands in a NEW cache dir, so the
    // tree's `file://` URL changes and the previous entry would otherwise
    // linger beside the new one. Prune the previous MANAGED entry/entries for
    // the SAME plugin first (a pure transform), then merge the new entry.
    // A user entry is never claimed.
    const pruned = prunePreviousManaged(text, cliJsonPath, entry, opts?.treeFamily, opts?.pluginKey)
    const merged = mergePluginsEntry(pruned, entry, cliJsonPath, opts?.pluginKey)
    if (merged !== null) return merged
    return pruned === text ? null : pruned
  })
  return { kind: "wired", wrapper: step.kind === "wrapped" ? step.wrapper : null, entry, serverEntry: serverWrapper }
}

/**
 * Remove only what wireTui added from the caller-provided cli.json. With
 * `entry`, remove only that exact tree's managed entry (another tree's managed
 * entry is never touched); without it, remove every managed entry. Returns
 * true when anything changed, false when there is nothing of ours to do.
 */
export async function unwireTui(cliJsonPath: string, entry?: string): Promise<boolean> {
  return readMergeWriteStable(cliJsonPath, "noop", (text) =>
    unmergePlugins(text, cliJsonPath, entry === undefined ? undefined : (value) => value === entry),
  )
}