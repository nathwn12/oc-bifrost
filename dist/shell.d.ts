export interface ShellResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
export interface Shell {
    (strings: TemplateStringsArray, ...values: unknown[]): ShellPromise;
}
export interface ShellPromise extends PromiseLike<ShellResult> {
    quiet(): ShellPromise;
    nothrow(): ShellPromise;
    cwd(dir: string): ShellPromise;
    env(vars: Record<string, string | undefined>): ShellPromise;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
}
/**
 * True when the host is Bun and already exposes a real `$` — that shell is
 * Bun's own implementation, with its own interpolation rules, and is used
 * verbatim rather than reimplemented here.
 */
export declare function hostShell(): Shell | undefined;
export declare function createShell(): Shell;
//# sourceMappingURL=shell.d.ts.map