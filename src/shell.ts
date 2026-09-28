/**
 * BunShell facade for V1 plugins.
 *
 * V1 handed plugins Bun's `$`. V2 does not (migration guide: "import and manage
 * the process API your plugin uses"). This shim reproduces the subset that real
 * V1 plugins use — tagged template, `.quiet()`, `.nothrow()`, `.text()`,
 * `.json()`, `.cwd()`, `.env()` — and delegates to Bun's `$` verbatim when the
 * host already provides it.
 */
import { spawn } from "node:child_process"

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface Shell {
  (strings: TemplateStringsArray, ...values: unknown[]): ShellPromise
}

export interface ShellPromise extends PromiseLike<ShellResult> {
  quiet(): ShellPromise
  nothrow(): ShellPromise
  cwd(dir: string): ShellPromise
  env(vars: Record<string, string | undefined>): ShellPromise
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}

const QUOTE = (value: unknown): string => {
  const text = typeof value === "string" ? value : String(value)
  // Windows cmd and POSIX sh both accept double quotes for a single argument.
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function compose(strings: readonly string[], values: readonly unknown[]): string {
  let command = ""
  for (let i = 0; i < strings.length; i += 1) {
    command += strings[i] ?? ""
    if (i < values.length) command += QUOTE(values[i])
  }
  return command
}

function makeShellPromise(
  command: string,
  state: { quiet: boolean; nothrow: boolean; cwd?: string; env?: Record<string, string | undefined> },
): ShellPromise {
  const execute = (): Promise<ShellResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        cwd: state.cwd,
        env: { ...process.env, ...(state.env ?? {}) },
        windowsHide: true,
      })

      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk)
        if (!state.quiet) process.stdout.write(String(chunk))
      })
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
        if (!state.quiet) process.stderr.write(String(chunk))
      })
      child.on("error", reject)
      child.on("close", (code) => {
        const exitCode = code ?? 0
        if (exitCode !== 0 && !state.nothrow) {
          reject(new Error(`Command failed (exit ${exitCode}): ${command}\n${stderr}`))
          return
        }
        resolve({ stdout, stderr, exitCode })
      })
    })

  const promise: ShellPromise = {
    then: (onFulfilled, onRejected) => execute().then(onFulfilled, onRejected),
    quiet: () => makeShellPromise(command, { ...state, quiet: true }),
    nothrow: () => makeShellPromise(command, { ...state, nothrow: true }),
    cwd: (dir: string) => makeShellPromise(command, { ...state, cwd: dir }),
    env: (vars) => makeShellPromise(command, { ...state, env: { ...state.env, ...vars } }),
    text: () => execute().then((result) => result.stdout.trim()),
    json: <T,>() => execute().then((result) => JSON.parse(result.stdout) as T),
  }
  return promise
}

/** True when the host is Bun and already exposes a real `$`. */
export function hostShell(): Shell | undefined {
  const bun = (globalThis as { Bun?: { $?: unknown } }).Bun
  return bun && typeof bun.$ === "function" ? (bun.$ as Shell) : undefined
}

export function createShell(): Shell {
  return ((strings: TemplateStringsArray, ...values: unknown[]) =>
    makeShellPromise(compose(Array.from(strings), values), {
      quiet: false,
      nothrow: false,
    })) as Shell
}
