export function createReporter(id, opts = {}) {
    const reports = [];
    const tag = `[oc-bifrost:${id}]`;
    const emit = (message) => {
        // OpenCode's plugin host surfaces console output; keep it loud and greppable.
        const line = `${tag} ${message}`;
        console.warn(line);
        try {
            opts.sink?.(line);
        }
        catch {
            // Reporting is additive; a broken sink is the sink's problem, not a mount's.
        }
    };
    return {
        id,
        reports,
        record(hook, level, note) {
            reports.push(note === undefined ? { hook, level } : { hook, level, note });
            if (level === "unsupported") {
                const line = `unsupported V1 hook "${hook}"${note ? ` — ${note}` : ""}`;
                if (opts.strict)
                    throw new Error(`${tag} ${line}`);
                emit(`${line}; skipped`);
            }
            else if (level === "partial" && opts.verbose !== false) {
                emit(`partial bridge for "${hook}"${note ? ` — ${note}` : ""}`);
            }
        },
        warn(message) {
            emit(message);
        },
    };
}
export function renderReport(reporter) {
    const order = { full: 0, mounted: 1, partial: 2, unsupported: 3 };
    const rows = [...reporter.reports].sort((a, b) => order[a.level] - order[b.level]);
    return rows.map((row) => `  ${row.level.padEnd(11)} ${row.hook}${row.note ? ` — ${row.note}` : ""}`).join("\n");
}
//# sourceMappingURL=report.js.map