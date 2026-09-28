import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Packaging-contract tests.
 *
 * These guard a class of defect that cost real debugging time and is invisible
 * in every functional test: the package can work perfectly as a bare npm entry
 * and fail completely as a directory entry — silently.
 *
 * OpenCode resolves a configured local plugin entry through that directory's
 * package.json using path-based (legacy) resolution: `main`, then an `index`
 * fallback. The `exports` map only applies to BARE specifiers, so it is invisible
 * here. When nothing resolves, the host drops the plugin with no log at all
 * (`packages/core/src/config/plugin/source.ts:167` returns an empty list).
 */

const require = createRequire(import.meta.url)
const rawRoot = fileURLToPath(new URL("..", import.meta.url))
const root = rawRoot.replace(/[\\/]+$/, "")
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("packaging: the package declares `main` so PATH-BASED resolution finds an entrypoint", () => {
  // `exports` is only consulted for BARE specifiers. A directory/as-path lookup uses
  // legacy `main` (then an `index` fallback) — with neither, resolution finds nothing.
  // Verified in Bun (the host runtime) as well as Node.
  assert.equal(typeof pkg.main, "string", "package.json must declare `main` for path-based resolution")
  const resolved = require.resolve(root)
  assert.ok(
    /index\.js$/.test(resolved),
    `a directory lookup must resolve to an entrypoint; got ${resolved}`,
  )
})

test("packaging: exports keeps a condition-agnostic default", () => {
  assert.ok(pkg.exports["."].default, "exports['.'] needs a `default` condition")
  assert.ok(pkg.exports["."].import, "exports['.'] needs an `import` condition")
})

test("packaging: files ships everything the README links to", () => {
  for (const entry of [
    "dist",
    "vendor",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "CHANGELOG.md",
    "INSTALL.md",
    "PROOF.md",
    "VERIFIED-PLUGINS.md",
    "CONTRIBUTING.md",
    "skills",
  ]) {
    assert.ok(pkg.files.includes(entry), `files must include "${entry}"`)
  }
})

test("packaging: the vendored preset entry exists where the preset points", () => {
  // preset.ts builds `new URL("../vendor/rtk.ts", import.meta.url)`; from dist/
  // that is the package-root vendor/rtk.ts. Prove the target really exists.
  const vendored = new URL("../vendor/rtk.ts", import.meta.url)
  assert.ok(fs.existsSync(vendored), `missing vendored entry: ${fileURLToPath(vendored)}`)
  assert.ok(pkg.files.includes("vendor"), "vendor/ must be published or the preset 404s")
})
