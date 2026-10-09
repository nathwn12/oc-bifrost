function isV2(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return (typeof candidate.id === "string" &&
        (typeof candidate.setup === "function" || typeof candidate.effect === "function"));
}
function isFactory(value) {
    return typeof value === "function";
}
const PLUGIN_EXPORT = /Plugin$|plugin$|^plugin$|^Plugin$/;
export function discover(module, spec) {
    const fallbackId = spec.split(/[\\/]/).pop()?.replace(/\.(ts|js|mjs|cjs)$/, "") ?? "plugin";
    if (isV2(module.default)) {
        return { kind: "v2", id: module.default.id, definition: module.default, note: "native V2 definition" };
    }
    // V1 module shape: { id?, server: Plugin }.
    if (typeof module.server === "function") {
        const id = typeof module.id === "string" ? module.id : fallbackId;
        return { kind: "v1", id, factory: module.server, note: "V1 module (server export)" };
    }
    if (isFactory(module.default)) {
        return { kind: "v1", id: fallbackId, factory: module.default, note: "V1 default export" };
    }
    // Named function exports. A V1 factory IS a function by contract
    // (`Plugin = (input) => Promise<Hooks>` - the return is the hook map), so
    // recognition is shape-based; the name heuristic survives only as a
    // PREFERENCE for modules whose first function export is a helper rather
    // than the factory itself (e.g. autotitle exports pure test helpers
    // alongside `AutoTitle`). A module whose exports are all non-functions is
    // still refused out loud.
    for (const [name, value] of Object.entries(module)) {
        if (isFactory(value) && PLUGIN_EXPORT.test(name)) {
            return { kind: "v1", id: name.replace(PLUGIN_EXPORT, "") || fallbackId, factory: value, note: `V1 named export (${name})` };
        }
    }
    for (const [name, value] of Object.entries(module)) {
        if (isFactory(value)) {
            return { kind: "v1", id: name, factory: value, note: `V1 named export by shape (${name})` };
        }
    }
    return {
        kind: "unknown",
        reason: "no V1 factory, V1 module, or V2 definition export found",
    };
}
//# sourceMappingURL=discover.js.map