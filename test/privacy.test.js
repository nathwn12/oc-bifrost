import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Privacy guard.
 *
 * This repository is public, and its docs are shipped inside the npm tarball.
 * A machine-specific path or a real username baked into an example is a leak the
 * moment it is published — and it is easy to add by accident while writing up a
 * proof, because that is exactly where real paths come from.
 *
 * So the rule is enforced rather than remembered. Examples must use a
 * placeholder (`C:\Users\you\...`), never a real profile.
 */

const root = fileURLToPath(new URL("..", import.meta.url))
const SELF = fileURLToPath(import.meta.url)

/** A real user profile / home directory, or a personal working root. */
const FORBIDDEN = [
  /C:[\\/]Users[\\/](?!you\b)/i, // C:\Users\<someone real>
  /\/home\/(?!you\b)[A-Za-z]/, // /home/<someone real>
  /\/Users\/(?!you\b)[A-Za-z]/, // /Users/<someone real> (macOS)
  /Q:[\\/]PROJECTS/i, // a personal project root
]

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".vscode"])
const SKIP_FILES = new Set(["package-lock.json"])
const TEXT = new Set([".md", ".json", ".jsonc", ".ts", ".js", ".mjs", ".cjs", ".yml", ".yaml", ".txt"])

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(path.join(dir, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_FILES.has(entry.name)) continue
    if (!TEXT.has(path.extname(entry.name))) continue
    const full = path.join(dir, entry.name)
    if (full === SELF) continue // this file names the patterns on purpose
    yield full
  }
}

test("privacy: no real machine path or username in published files", () => {
  const offenders = []
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, "utf8")
    source.split("\n").forEach((line, index) => {
      for (const pattern of FORBIDDEN) {
        if (pattern.test(line)) {
          offenders.push(`${path.relative(root, file)}:${index + 1}: ${line.trim().slice(0, 120)}`)
          return
        }
      }
    })
  }
  assert.deepEqual(
    offenders,
    [],
    `machine-specific paths must use a placeholder (C:\\Users\\you\\...):\n${offenders.join("\n")}`,
  )
})
