#!/usr/bin/env node
/**
 * vendor-update — refresh the vendored rtk plugin and its recorded provenance.
 *
 * Usage:
 *   node scripts/vendor-update.mjs [--ref <tag>] [--from-file <path>]
 *                                  [--expect-sha256 <hex>] [--expect-blob <sha1>]
 *                                  [--dry-run] [--skip-tests]
 *
 * This is the *manual* update path. It deliberately does not run at install or
 * plugin load time: fetching and executing remote code automatically would
 * break the recorded provenance (sha256 / git blob / license) that makes the
 * vendored copy auditable. A human runs it, it VERIFIES the bytes against an
 * independent third party, it updates every copy of the pin, and it runs the
 * test suite before declaring success.
 *
 * Verification, not a content sniff:
 *   - network path: our computed git blob must equal GitHub's own recorded blob
 *     id for the file at that ref (the contents API's `sha`).
 *   - offline path (`--from-file`): the caller must supply an independently
 *     obtained digest via `--expect-sha256` or `--expect-blob`. A real run
 *     refuses to write without one.
 */
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  gitBlobSha,
  isValidRef,
  renderProvenanceTable,
  rewritePin,
  sha256Hex,
  validateVendorFile,
} from "./vendor-lib.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const UPSTREAM = "rtk-ai/rtk"
const UPSTREAM_PATH = "hooks/opencode/rtk.ts"
const LICENSE = "Apache-2.0"
const USER_AGENT = "oc-bifrost-vendor-update"

const PATHS = {
  vendorFile: path.join(ROOT, "vendor", "rtk.ts"),
  metaFile: path.join(ROOT, "vendor", "rtk.meta.json"),
  readme: path.join(ROOT, "vendor", "README.md"),
  preset: path.join(ROOT, "src", "preset.ts"),
}

function fail(message) {
  console.error(`[vendor-update] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const opts = { ref: undefined, fromFile: undefined, expectSha256: undefined, expectBlob: undefined, dryRun: false, skipTests: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") opts.dryRun = true
    else if (arg === "--skip-tests") opts.skipTests = true
    else if (arg === "--ref") opts.ref = argv[++i]
    else if (arg === "--from-file") opts.fromFile = argv[++i]
    else if (arg === "--expect-sha256") opts.expectSha256 = argv[++i]
    else if (arg === "--expect-blob") opts.expectBlob = argv[++i]
    else fail(`unknown argument "${arg}"`)
  }
  for (const [flag, key] of [
    ["--ref", "ref"],
    ["--from-file", "fromFile"],
    ["--expect-sha256", "expectSha256"],
    ["--expect-blob", "expectBlob"],
  ]) {
    if (argv.includes(flag) && opts[key] === undefined) fail(`${flag} needs a value`)
  }
  return opts
}

/** The version currently pinned in src/preset.ts, read offline. */
function currentPin() {
  let source
  try {
    source = fs.readFileSync(PATHS.preset, "utf8")
  } catch (error) {
    fail(`could not read src/preset.ts: ${error.message}`)
  }
  const matches = [...source.matchAll(/version:\s*"([^"]+)"/g)]
  if (matches.length !== 1) {
    fail(`expected exactly one \`version: "..."\` line in src/preset.ts, found ${matches.length}`)
  }
  return matches[0][1]
}

/** Resolve the latest upstream release tag. Throws on any failure. */
async function latestReleaseTag() {
  const response = await fetch(`https://api.github.com/repos/${UPSTREAM}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub releases API returned HTTP ${response.status}`)
  const data = await response.json()
  const tag = data && typeof data.tag_name === "string" ? data.tag_name.trim() : ""
  if (!tag) throw new Error("GitHub releases API returned no tag_name")
  return tag
}

/** GitHub's own recorded git blob id for the file at `ref`. Throws on failure. */
async function upstreamBlobSha(ref) {
  const url = `https://api.github.com/repos/${UPSTREAM}/contents/${UPSTREAM_PATH}?ref=${encodeURIComponent(ref)}`
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`contents API returned HTTP ${response.status}`)
  const data = await response.json()
  const sha = data && typeof data.sha === "string" ? data.sha : ""
  if (!sha) throw new Error("contents API returned no sha")
  return sha
}

async function download(ref) {
  const url = `https://raw.githubusercontent.com/${UPSTREAM}/${ref}/${UPSTREAM_PATH}`
  const response = await fetch(url, {
    headers: { accept: "text/plain", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`download of ${url} failed with HTTP ${response.status}`)
  return response.text()
}

/** Replace the provenance table in vendor/README.md, found by its header row. */
function replaceTable(readme, table) {
  const lines = readme.split("\n")
  const start = lines.findIndex((line) => line.trim() === "| Field | Value |")
  if (start === -1) throw new Error("provenance table not found in vendor/README.md")
  let end = -1
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith("| **Changes**")) {
      end = i
      break
    }
    if (!lines[i].startsWith("|")) break
  }
  if (end === -1) throw new Error("could not find the end of the provenance table in vendor/README.md")
  return [...lines.slice(0, start), ...table.split("\n"), ...lines.slice(end + 1)].join("\n")
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const fromFile = opts.fromFile !== undefined

  // Ref resolution. Offline when reading a local file; otherwise ask upstream —
  // and if that fails, abort loudly rather than silently falling back to main.
  let ref = opts.ref
  if (!ref) {
    if (fromFile) {
      ref = currentPin()
      console.log(`[vendor-update] no --ref with --from-file; using the current pin ${ref} (offline)`)
    } else {
      try {
        ref = await latestReleaseTag()
      } catch (error) {
        fail(
          `could not resolve the latest release tag (${error.message || error}); ` +
            `pass --ref <tag> or --from-file <path> to work offline`,
        )
      }
    }
  }
  if (!isValidRef(ref)) fail(`refusing unsafe ref "${ref}": refs must match [A-Za-z0-9._/-], not start with "-", and contain no ".." segment`)

  let content
  if (fromFile) {
    const candidate = path.resolve(process.cwd(), opts.fromFile)
    try {
      content = fs.readFileSync(candidate, "utf8")
    } catch (error) {
      fail(`could not read --from-file "${candidate}": ${error.message}`)
    }
  } else {
    try {
      content = await download(ref)
    } catch (error) {
      fail(`could not download ${UPSTREAM_PATH} at ${ref}: ${error.message || error}`)
    }
  }

  // Secondary sanity check only — see validateVendorFile's own docs.
  const sanity = validateVendorFile(content)
  if (!sanity.ok) fail(`refusing to vendor the candidate: ${sanity.reason}`)

  const bytes = Buffer.byteLength(content, "utf8")
  const sha256 = sha256Hex(content)
  const gitBlob = gitBlobSha(content)

  // The real gate: match an independent record of the bytes.
  if (fromFile) {
    if (!opts.expectSha256 && !opts.expectBlob) {
      if (!opts.dryRun) {
        fail(
          "--from-file requires independent verification: pass --expect-sha256 <hex> or --expect-blob <sha1>. " +
            "There is no third party to ask offline, so the digest must come from elsewhere.",
        )
      }
      console.warn(
        "[vendor-update] ⚠ DRY RUN WITHOUT VERIFICATION: no --expect-sha256 / --expect-blob was given. " +
          "A real run would refuse to write without one.",
      )
    } else {
      if (opts.expectSha256 && opts.expectSha256.toLowerCase() !== sha256) {
        fail(`expected sha256 ${opts.expectSha256}, computed ${sha256}; refusing to write`)
      }
      if (opts.expectBlob && opts.expectBlob.toLowerCase() !== gitBlob) {
        fail(`expected git blob ${opts.expectBlob}, computed ${gitBlob}; refusing to write`)
      }
      console.log(`[vendor-update] verified against the supplied digest (sha256 ${sha256})`)
    }
  } else {
    let upstreamSha
    try {
      upstreamSha = await upstreamBlobSha(ref)
    } catch (error) {
      fail(`could not verify against GitHub's recorded blob: ${error.message || error}`)
    }
    if (upstreamSha !== gitBlob) {
      fail(`verification failed: GitHub records blob ${upstreamSha}, we computed ${gitBlob}; refusing to write`)
    }
    console.log(`[vendor-update] verified against GitHub's recorded blob ${upstreamSha}`)
  }

  const meta = {
    id: "rtk",
    upstream: UPSTREAM,
    ref,
    path: UPSTREAM_PATH,
    license: LICENSE,
    sha256,
    gitBlob,
    bytes,
    updatedAt: new Date().toISOString(),
  }

  // Prepare every write before touching disk, so a surprise layout (a missing
  // file, no rtk version line, multiple matches) fails with nothing written.
  let writes
  try {
    const metaJson = `${JSON.stringify(meta, null, 2)}\n`
    const readme = replaceTable(fs.readFileSync(PATHS.readme, "utf8"), renderProvenanceTable(meta))
    const pinned = rewritePin(fs.readFileSync(PATHS.preset, "utf8"), ref)
    writes = [
      { file: PATHS.vendorFile, content },
      { file: PATHS.metaFile, content: metaJson },
      { file: PATHS.readme, content: readme },
      { file: PATHS.preset, content: pinned },
    ]
  } catch (error) {
    fail(`could not prepare the update (nothing written): ${error.message}`)
  }

  if (opts.dryRun) {
    console.log(`[vendor-update] dry run (ref ${ref}) — no files written:`)
    for (const write of writes) {
      console.log(`  would write ${path.relative(ROOT, write.file)} (${Buffer.byteLength(write.content, "utf8")} bytes)`)
    }
    console.log(`[vendor-update] dry run: skipping checks`)
    return
  }

  for (const write of writes) fs.writeFileSync(write.file, write.content)

  console.log(`[vendor-update] ref      ${ref}`)
  console.log(`[vendor-update] sha256   ${sha256}`)
  console.log(`[vendor-update] git blob ${gitBlob}`)

  if (!opts.skipTests) {
    const result = spawnSync("npm", ["run", "check"], { cwd: ROOT, stdio: "inherit", shell: true })
    if (result.status !== 0) {
      console.error(
        `\n[vendor-update] ❌ npm run check FAILED after writing.\n` +
          `[vendor-update] revert with: git checkout -- vendor src/preset.ts`,
      )
      process.exit(1)
    }
  }

  console.log(`[vendor-update] ✅ vendored rtk ${ref} (${bytes} bytes)`)
}

main().catch((error) => {
  console.error(`[vendor-update] unexpected failure: ${error.stack || error}`)
  process.exit(1)
})
