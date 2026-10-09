/**
 * BunShell facade for V1 plugins.
 *
 * V1 handed plugins Bun's `$`. V2 does not (migration guide: "import and manage
 * the process API your plugin uses"). This shim reproduces the subset that real
 * V1 plugins use — tagged template, `.quiet()`, `.nothrow()`, `.text()`,
 * `.json()`, `.cwd()`, `.env()` — and delegates to Bun's `$` verbatim when the
 * host already provides it.
 */
import { spawn } from "node:child_process";
const QUOTE = (value) => {
    const text = typeof value === "string" ? value : String(value);
    // Windows cmd and POSIX sh both accept double quotes for a single argument.
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};
function compose(strings, values) {
    let command = "";
    for (let i = 0; i < strings.length; i += 1) {
        command += strings[i] ?? "";
        if (i < values.length)
            command += QUOTE(values[i]);
    }
    return command;
}
function makeShellPromise(command, state) {
    const execute = () => new Promise((resolve, reject) => {
        const child = spawn(command, {
            shell: true,
            cwd: state.cwd,
            env: { ...process.env, ...(state.env ?? {}) },
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
            if (!state.quiet)
                process.stdout.write(String(chunk));
        });
        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
            if (!state.quiet)
                process.stderr.write(String(chunk));
        });
        child.on("error", reject);
        child.on("close", (code) => {
            const exitCode = code ?? 0;
            if (exitCode !== 0 && !state.nothrow) {
                reject(new Error(`Command failed (exit ${exitCode}): ${command}\n${stderr}`));
                return;
            }
            resolve({ stdout, stderr, exitCode });
        });
    });
    const promise = {
        then: (onFulfilled, onRejected) => execute().then(onFulfilled, onRejected),
        quiet: () => makeShellPromise(command, { ...state, quiet: true }),
        nothrow: () => makeShellPromise(command, { ...state, nothrow: true }),
        cwd: (dir) => makeShellPromise(command, { ...state, cwd: dir }),
        env: (vars) => makeShellPromise(command, { ...state, env: { ...state.env, ...vars } }),
        text: () => execute().then((result) => result.stdout.trim()),
        json: () => execute().then((result) => JSON.parse(result.stdout)),
    };
    return promise;
}
/** True when the host is Bun and already exposes a real `$`. */
export function hostShell() {
    const bun = globalThis.Bun;
    return bun && typeof bun.$ === "function" ? bun.$ : undefined;
}
export function createShell() {
    return ((strings, ...values) => makeShellPromise(compose(Array.from(strings), values), {
        quiet: false,
        nothrow: false,
    }));
}
//# sourceMappingURL=shell.js.map