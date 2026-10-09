/** Parse a numeric segment, tolerating junk and missing values as 0. */
function segment(value) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}
/**
 * Split a tag into `[major, minor, patch]` plus an optional prerelease suffix.
 * A leading `v`/`V` and a `-suffix` are stripped; everything else is tolerated
 * as-is so odd input can never throw.
 */
function parseTag(tag) {
    const raw = String(tag ?? "").trim().replace(/^[vV]/, "");
    const dash = raw.indexOf("-");
    const core = dash === -1 ? raw : raw.slice(0, dash);
    const prerelease = dash === -1 ? null : raw.slice(dash + 1);
    const parts = core.split(".");
    return {
        numbers: [segment(parts[0]), segment(parts[1]), segment(parts[2])],
        prerelease,
    };
}
/**
 * Semver-ish prerelease ordering. Numeric identifiers compare numerically,
 * everything else lexicographically, so `rc2 < rc10`.
 */
function comparePrerelease(a, b) {
    const left = a.split(".");
    const right = b.split(".");
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++) {
        const l = left[i];
        const r = right[i];
        if (l === undefined)
            return -1;
        if (r === undefined)
            return 1;
        const ln = Number(l);
        const rn = Number(r);
        const numeric = Number.isFinite(ln) && Number.isFinite(rn) && l !== "" && r !== "";
        const order = numeric ? Math.sign(ln - rn) : l < r ? -1 : l > r ? 1 : 0;
        if (order !== 0)
            return order;
    }
    return 0;
}
/** Compare two semver-ish tags ("v1.2.3", "1.2.3", optional -suffix). Returns -1 | 0 | 1. Pure, no network. */
export function compareTags(a, b) {
    const left = parseTag(a);
    const right = parseTag(b);
    for (let i = 0; i < 3; i++) {
        const order = Math.sign((left.numbers[i] ?? 0) - (right.numbers[i] ?? 0));
        if (order !== 0)
            return order;
    }
    // A prerelease ranks below its release: v1.0.0-rc1 < v1.0.0.
    if (left.prerelease === null && right.prerelease !== null)
        return 1;
    if (left.prerelease !== null && right.prerelease === null)
        return -1;
    if (left.prerelease !== null && right.prerelease !== null)
        return comparePrerelease(left.prerelease, right.prerelease);
    return 0;
}
/** Offline, always-available note naming the pinned version. Pure. */
export function pinnedNote(spec) {
    return `vendored ${spec.id} ${spec.version} (${spec.source})`;
}
/**
 * Whether the online check is enabled. An explicit option WINS over the env
 * var: `off` disables the check even when the environment asks for it. When the
 * option is omitted, `OC_BIFROST_FRESHNESS === "online"` enables it. Pure.
 */
export function freshnessEnabled(option, env = process.env) {
    const value = option === undefined ? env?.OC_BIFROST_FRESHNESS : option;
    return String(value ?? "").toLowerCase() === "online";
}
function behindMessage(spec, latest) {
    return (`preset "${spec.id}" is behind: pinned ${spec.version}, upstream latest ${latest}. ` +
        `Update a source checkout with "npm run vendor:update" ` +
        `or an installed copy with "npm i @nathwn12/oc-bifrost@latest".`);
}
function unknownMessage(spec, why) {
    return `preset "${spec.id}" freshness could not be checked (${why}); still pinned at ${spec.version}.`;
}
/**
 * The request timeout, clamped. A caller cannot configure an unbounded stall:
 * the default is 1500ms and the ceiling is 10s.
 */
function clampTimeout(value) {
    const requested = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1500;
    return Math.min(requested, 10_000);
}
/**
 * Online check. Never throws. Timeboxed. Returns "unknown" on any failure.
 *
 * `unknown` is informational — an offline machine, a rate limit, or a GitHub
 * hiccup is not a warning and must not read like one.
 */
export async function checkFreshness(spec, opts = {}) {
    const pinned = spec.version;
    try {
        const doFetch = opts.fetchImpl ?? globalThis.fetch;
        const signal = AbortSignal.timeout(clampTimeout(opts.timeoutMs));
        const url = `https://api.github.com/repos/${spec.source}/releases/latest`;
        const response = await doFetch(url, {
            headers: {
                accept: "application/vnd.github+json",
                // GitHub rejects requests with no user-agent.
                "user-agent": "oc-bifrost-freshness",
            },
            signal,
        });
        if (!response.ok)
            return { status: "unknown", pinned, message: unknownMessage(spec, `HTTP ${response.status}`) };
        const data = (await response.json());
        const tag = data && typeof data === "object" && typeof data["tag_name"] === "string" ? data["tag_name"].trim() : "";
        if (!tag)
            return { status: "unknown", pinned, message: unknownMessage(spec, "no release tag in the response") };
        if (compareTags(tag, pinned) > 0) {
            return { status: "behind", pinned, latest: tag, message: behindMessage(spec, tag) };
        }
        return {
            status: "current",
            pinned,
            latest: tag,
            message: `preset "${spec.id}" is current: pinned ${pinned}, upstream latest ${tag}.`,
        };
    }
    catch (error) {
        const why = error instanceof Error ? error.message : "unexpected failure";
        return { status: "unknown", pinned, message: unknownMessage(spec, why) };
    }
}
//# sourceMappingURL=freshness.js.map