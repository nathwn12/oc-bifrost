/**
 * BunShell facade for V1 plugins.
 *
 * V1 handed plugins Bun's `$`. V2 does not (migration guide: "import and manage
 * the process API your plugin uses"). This shim reproduces the subset that real
 * V1 plugins use — tagged template, `.quiet()`, `.nothrow()`, `.text()`,
 * `.json()`, `.cwd()`, `.env()` — and delegates to Bun's `$` verbatim when the
 * host already provides it.
 *
 * SECURITY — no command is ever a shell string. The tagged template is
 * composed into an ARGV array and spawned directly (`shell: false`): the
 * literal text is split into words with `'`/`"` grouping honoured, and every
 * interpolated value becomes exactly ONE argv element — data the OS hands to
 * the program, never syntax a shell re-parses. The earlier defect composed a
 * command string and spawned it with `shell: true`: an interpolated value such
 * as `x" & echo INJECTED` ended the quoting and `cmd.exe` ran the second
 * command as the user. Because no shell remains, syntax only a shell could
 * honour (pipe, redirect, sequencing, grouping, substitution, expansion,
 * globbing) is REFUSED by name at composition time instead of being silently
 * reinterpreted; a refusal is a feature (`test/shell.test.js`).
 */
import { spawn } from "node:child_process";
/** Every refusal in this file carries the package prefix, like the rest of src/. */
function fail(message) {
    throw new Error(`[oc-bifrost] ${message}`);
}
/**
 * Structure a shell would have acted on: pipe, sequencing, redirect, grouping,
 * globbing, command substitution or cmd's `^` escape. Refused when unquoted —
 * every one of these meant something else while a shell sat behind the facade.
 */
const SHELL_SYNTAX = /[|&;<>(){}[\]*?^`]/;
/** Word-start characters a shell would have acted on: tilde expansion, comment. */
const WORD_START_SYNTAX = /[~#]/;
/**
 * An expansion a shell would have performed: `$NAME`, `${NAME}`, `$1`, `$(cmd)`,
 * `%NAME%`. Matched at the character, so a lone `$` or `%` stays literal data.
 */
const EXPANSION = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}|^\$\(|^\$[A-Za-z_0-9][A-Za-z0-9_]*|^%[A-Za-z_][^%]*%/;
/**
 * Split one literal template segment into argv words.
 *
 * `'` and `"` group a word — the grouping a shell performs — so a caller that
 * already quoted a literal argument keeps working. Everything else is taken
 * literally, and any character that only a shell could have interpreted is
 * refused by name: with no shell behind it, such text can no longer mean what
 * it meant, and passing it through as data would be a silent lie.
 */
function splitWords(segment) {
    const words = [];
    let word = "";
    let started = false;
    let quote;
    for (let i = 0; i < segment.length; i += 1) {
        const char = segment[i];
        if (quote !== undefined) {
            if (char === quote)
                quote = undefined;
            else
                word += char;
            started = true;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            started = true;
            continue;
        }
        if (char === " " || char === "\t") {
            if (started) {
                words.push(word);
                word = "";
                started = false;
            }
            continue;
        }
        if (char === "$" || char === "%") {
            const expansion = segment.slice(i).match(EXPANSION);
            if (expansion !== null) {
                fail(`refusing to run ${JSON.stringify(segment)}: the command text carries the shell expansion ` +
                    `${JSON.stringify(expansion[0])}, which no shell performs here; pass the value as an interpolation instead`);
            }
        }
        if (char === "\n" || char === "\r" || SHELL_SYNTAX.test(char)) {
            fail(`refusing to run ${JSON.stringify(segment)}: the command text carries ${JSON.stringify(char)}, ` +
                `which only a shell could interpret and the shell facade runs no shell; ` +
                `pass the value as an interpolation instead`);
        }
        if (!started && WORD_START_SYNTAX.test(char)) {
            fail(`refusing to run ${JSON.stringify(segment)}: the command text starts a word with ${JSON.stringify(char)}, ` +
                `which only a shell could interpret and the shell facade runs no shell; ` +
                `pass the value as an interpolation instead`);
        }
        word += char;
        started = true;
    }
    if (quote !== undefined) {
        fail(`refusing to run ${JSON.stringify(segment)}: the command text ends inside an unterminated ${quote} quote`);
    }
    if (started)
        words.push(word);
    return words;
}
/**
 * Compose the argv the OS will exec: the literal text becomes words, and each
 * interpolated value becomes exactly one element — never re-split, never
 * re-quoted, never parsed.
 */
function compose(strings, values) {
    const argv = [];
    for (let i = 0; i < strings.length; i += 1) {
        argv.push(...splitWords(strings[i] ?? ""));
        if (i < values.length) {
            const value = values[i];
            argv.push(typeof value === "string" ? value : String(value));
        }
    }
    if (argv.length === 0)
        fail("refusing to run an empty command");
    return argv;
}
function makeShellPromise(argv, state) {
    // Human-readable form for failure messages only; execution never uses it.
    const command = argv.join(" ");
    const execute = () => new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), {
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
        child.on("error", (error) => {
            // Windows cannot exec a `.cmd`/`.bat` launcher without a shell, and
            // this facade never crosses a shell boundary: name the reason and the
            // way out instead of a bare EINVAL.
            if (error.code === "EINVAL" && process.platform === "win32") {
                reject(new Error(`[oc-bifrost] cannot run ${JSON.stringify(argv[0])}: on Windows a \`.cmd\`/\`.bat\` launcher ` +
                    `(npm, npx, yarn) needs a shell, and the shell facade runs none. Run the program's own JS entry instead.`));
                return;
            }
            reject(error);
        });
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
        quiet: () => makeShellPromise(argv, { ...state, quiet: true }),
        nothrow: () => makeShellPromise(argv, { ...state, nothrow: true }),
        cwd: (dir) => makeShellPromise(argv, { ...state, cwd: dir }),
        env: (vars) => makeShellPromise(argv, { ...state, env: { ...state.env, ...vars } }),
        text: () => execute().then((result) => result.stdout.trim()),
        json: () => execute().then((result) => JSON.parse(result.stdout)),
    };
    return promise;
}
/**
 * True when the host is Bun and already exposes a real `$` — that shell is
 * Bun's own implementation, with its own interpolation rules, and is used
 * verbatim rather than reimplemented here.
 */
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