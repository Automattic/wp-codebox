import { createHash } from "node:crypto";
export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function objectValue(value) {
    return isPlainObject(value) ? value : {};
}
export function optionalObjectValue(value) {
    return isPlainObject(value) ? value : undefined;
}
export function stringValue(value) {
    return typeof value === "string" ? value.trim() : "";
}
export function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function parseJsonObject(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
export function now() {
    return new Date().toISOString();
}
export function sha256(contents) {
    return createHash("sha256").update(contents).digest("hex");
}
export function stableJson(value) {
    return stableJsonValue(value, new WeakSet(), 0);
}
function stableJsonValue(value, seen, depth) {
    if (depth > 30) {
        return JSON.stringify("[max-depth]");
    }
    if (value instanceof Error) {
        return stableJsonValue(errorJsonRecord(value), seen, depth + 1);
    }
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (seen.has(value)) {
        return JSON.stringify("[circular]");
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const json = `[${value.slice(0, 2000).map((item) => stableJsonValue(item, seen, depth + 1)).join(",")}]`;
        seen.delete(value);
        return json;
    }
    const json = `{${Object.keys(value)
        .sort()
        .slice(0, 300)
        .map((key) => {
        const item = value[key];
        return typeof item === "function" || typeof item === "symbol" ? undefined : `${JSON.stringify(key)}:${stableJsonValue(item, seen, depth + 1)}`;
    })
        .filter((item) => Boolean(item))
        .join(",")}}`;
    seen.delete(value);
    return json;
}
export function normalizeJsonValue(value, seen = new WeakSet(), depth = 0) {
    if (depth > 30) {
        return "[max-depth]";
    }
    if (value instanceof Error) {
        return normalizeJsonValue(errorJsonRecord(value), seen, depth + 1);
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) {
        return "[circular]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const normalized = value.slice(0, 2000).map((item) => normalizeJsonValue(item, seen, depth + 1));
        seen.delete(value);
        return normalized;
    }
    const output = {};
    for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).slice(0, 300)) {
        if (typeof item !== "function" && typeof item !== "symbol") {
            output[key] = normalizeJsonValue(item, seen, depth + 1);
        }
    }
    seen.delete(value);
    return output;
}
function errorJsonRecord(error) {
    const record = error;
    const output = {
        name: error.name,
        message: error.message,
    };
    for (const [key, item] of Object.entries(record)) {
        if (key !== "name" && key !== "message" && key !== "stack" && typeof item !== "function" && typeof item !== "symbol") {
            output[key] = item;
        }
    }
    if (record.cause && !("cause" in output)) {
        output.cause = record.cause;
    }
    return output;
}
export function sha256StableJson(value, trailingNewline = false) {
    return createHash("sha256").update(`${stableJson(value)}${trailingNewline ? "\n" : ""}`).digest("hex");
}
export function stripUndefined(record) {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
export function stringList(value) {
    if (!Array.isArray(value))
        return [];
    const items = [];
    for (const item of value) {
        const normalized = String(item).trim();
        if (normalized !== "" && !items.includes(normalized))
            items.push(normalized);
    }
    return items;
}
//# sourceMappingURL=object-utils.js.map