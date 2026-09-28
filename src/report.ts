/**
 * Compatibility reporter — the honesty layer.
 *
 * Nothing is ever silently dropped. Every V1 hook is either bridged (full),
 * approximated (partial), or refused out loud (unsupported).
 */
import type { HookReport, SupportLevel } from "./types.js"

export interface Reporter {
  readonly id: string
  record(hook: string, level: SupportLevel, note?: string): void
  warn(message: string): void
  readonly reports: HookReport[]
}

export function createReporter(id: string, opts: { strict?: boolean; verbose?: boolean } = {}): Reporter {
  const reports: HookReport[] = []
  const tag = `[oc-bifrost:${id}]`

  const emit = (message: string) => {
    // OpenCode's plugin host surfaces console output; keep it loud and greppable.
    console.warn(`${tag} ${message}`)
  }

  return {
    id,
    reports,
    record(hook, level, note) {
      reports.push(note === undefined ? { hook, level } : { hook, level, note })
      if (level === "unsupported") {
        const line = `unsupported V1 hook "${hook}"${note ? ` — ${note}` : ""}`
        if (opts.strict) throw new Error(`${tag} ${line}`)
        emit(`${line}; skipped`)
      } else if (level === "partial" && opts.verbose !== false) {
        emit(`partial bridge for "${hook}"${note ? ` — ${note}` : ""}`)
      }
    },
    warn(message) {
      emit(message)
    },
  }
}

export function renderReport(reporter: Reporter): string {
  const order: Record<SupportLevel, number> = { full: 0, mounted: 1, partial: 2, unsupported: 3 }
  const rows = [...reporter.reports].sort((a, b) => order[a.level] - order[b.level])
  return rows.map((row) => `  ${row.level.padEnd(11)} ${row.hook}${row.note ? ` — ${row.note}` : ""}`).join("\n")
}
