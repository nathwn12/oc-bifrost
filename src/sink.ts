/**
 * Durable report sink — the proof surface that survives a discarded stdout.
 *
 * The mount/compatibility report is oc-bifrost's product proof, but console
 * output is structurally unreachable in the modes that need it most:
 *
 *   - the V2 host spawns the background service with stdin/stdout discarded
 *     (`packages/client/src/service-contender.ts` — `stdio: ["ignore","ignore","pipe"]`);
 *   - in stdio mode stdout IS the JSON-RPC channel, so raw console writes are
 *     dropped;
 *   - the host's plugin loader waves console through unmodified
 *     (`packages/core/src/plugin/module.ts`).
 *
 * So every line the reporter sends to the console is mirrored, best-effort,
 * into a file the user can read afterwards:
 *
 *   - default: `<XDG_CACHE_HOME>/opencode/oc-bifrost/report.log`
 *     (falling back to `~/.cache/opencode/oc-bifrost/report.log`) — the same
 *     shared user cache the `github:` artifacts live under;
 *   - override: `OC_BIFROST_REPORT=<path>`; `OC_BIFROST_REPORT=off` disables it.
 *
 * Policy (deliberate, so it is not a surprise):
 *
 *   - APPEND. Each load adds its report; history across host restarts is kept,
 *     which is the point — the run you need is usually the one that already
 *     exited.
 *   - HARD SIZE CAP. The file never exceeds `MAX_REPORT_BYTES` (256 KiB).
 *     A write that would cross the cap ROLLS THE FILE OVER (truncates first),
 *     so the newest report survives whole when it fits; a single block larger
 *     than the cap keeps its newest `MAX_REPORT_BYTES` bytes.
 *   - CONTROL CHARACTERS ARE ESCAPED. Report lines can carry plugin specs and
 *     error text; a raw CR or NUL in a durable log is an injection hazard, so
 *     they are escaped (`\u0000`-style) before they land on disk. Newlines are
 *     preserved — they are the line structure of the report.
 *   - THE SINK NEVER BREAKS A MOUNT. Any filesystem failure is swallowed and
 *     warned about once; reporting is additive, mounting is untouched.
 *
 * No secrets: the sink writes only the lines it is handed. It never reads the
 * environment beyond the path/disable switches above and never serializes env
 * values.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** The hard ceiling for the durable report file. */
export const MAX_REPORT_BYTES = 256 * 1024
const REPORT_FILENAME = "report.log"

/** Values of `OC_BIFROST_REPORT` that turn the sink off. */
const DISABLED = new Set(["off", "0", "false", "none"])

export interface ReportSink {
  /** Absolute path of the report file. */
  readonly path: string
  /** False when `OC_BIFROST_REPORT` disables the sink (or it could not be resolved). */
  readonly enabled: boolean
  /** Mirror one report string (best-effort; never throws). */
  write(text: string): void
}

export interface ReportSinkOptions {
  /** Environment override; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Home directory override; defaults to `os.homedir()`. */
  homeDirectory?: string
  /** Explicit file path, overriding env + default (used by tests). */
  path?: string
  /** Hard byte ceiling; defaults to `MAX_REPORT_BYTES`. */
  maxBytes?: number
}

/** True unless `OC_BIFROST_REPORT` names an explicit off switch. */
export function reportSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !DISABLED.has(String(env?.OC_BIFROST_REPORT ?? "").trim().toLowerCase())
}

/**
 * Resolve the report file path. `OC_BIFROST_REPORT` wins when it names a path;
 * otherwise the shared OpenCode cache is used, mirroring `githubCacheRoot`.
 */
export function reportPath(homeDirectory = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env?.OC_BIFROST_REPORT ?? "").trim()
  if (configured !== "" && reportSinkEnabled(env)) return path.resolve(configured)
  const cacheHome = env.XDG_CACHE_HOME || path.join(homeDirectory, ".cache")
  return path.join(cacheHome, "opencode", "oc-bifrost", REPORT_FILENAME)
}

/**
 * Escape C0/C1 control characters except newline. A durable log is read by a
 * human or a tool later; raw controls are an injection hazard, newlines are the
 * report's own structure.
 */
export function sanitizeReportText(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f\u0080-\u009f]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/**
 * Create the sink. Disk work is lazy: constructing a sink never creates the
 * file, so a load with nothing to report leaves no artifact behind.
 */
export function createReportSink(options: ReportSinkOptions = {}): ReportSink {
  const env = options.env ?? process.env
  const enabled = options.path !== undefined ? true : reportSinkEnabled(env)
  const file = options.path ?? reportPath(options.homeDirectory, env)
  const maxBytes =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : MAX_REPORT_BYTES
  let warned = false

  return {
    path: file,
    enabled,
    write(text: string) {
      if (!enabled) return
      const body = sanitizeReportText(String(text))
      if (body.trim() === "") return
      const payload = Buffer.from(body.endsWith("\n") ? body : `${body}\n`, "utf8")
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        if (payload.length >= maxBytes) {
          // A single block larger than the cap: keep the newest tail.
          fs.writeFileSync(file, payload.subarray(payload.length - maxBytes), { mode: 0o600 })
          return
        }
        let current = 0
        try {
          current = fs.statSync(file).size
        } catch {
          current = 0 // absent file: nothing to append to yet
        }
        if (current + payload.length > maxBytes) {
          // Roll over: truncate first so the newest report survives whole.
          fs.writeFileSync(file, "", { mode: 0o600 })
        }
        fs.appendFileSync(file, payload, { mode: 0o600 })
      } catch (error) {
        if (!warned) {
          warned = true
          console.warn(
            `[oc-bifrost] report sink unavailable at ${file}: ${(error as Error).message} ` +
              `(mounting is unaffected; set OC_BIFROST_REPORT=off to silence this)`,
          )
        }
      }
    },
  }
}
