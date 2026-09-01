export const REDACTED_VALUE = "[redacted]";
const SENSITIVE_KEY_PATTERN = /(?:secret|token|credential|password|pass|api[_-]?key|private[_-]?key|authorization|auth|cookie|bearer|nonce|session|state|code|login)/i;
const SECRET_LIKE_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/;
const SECRET_LIKE_VALUE_GLOBAL_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const REDACTION_POLICY_PROFILES = {
    audit_metadata: {
        name: "audit_metadata",
        exactKeys: ["authorization", "key", "value"],
        sensitiveKeyTokens: ["secret", "token", "password", "credential", "private_key", "api_key"],
    },
    provider_proxy: {
        name: "provider_proxy",
        exactKeys: ["authorization", "key", "value"],
        sensitiveKeyTokens: ["secret", "token", "password", "credential", "private_key", "api_key"],
    },
    browser_event: {
        name: "browser_event",
        exactKeys: ["authorization"],
        sensitiveKeyTokens: ["secret", "token", "password", "credential", "private_key", "api_key", "cookie"],
    },
    public_session_dto: {
        name: "public_session_dto",
        exactKeys: [],
        sensitiveKeyTokens: ["secret", "token", "password", "private_key", "api_key", "credential"],
        allowedKeys: ["secret_env", "secretenv", "secret_env_names"],
    },
};
export function getRedactionPolicyProfile(profile) {
    return REDACTION_POLICY_PROFILES[profile];
}
export function isSensitiveKey(key, options = {}) {
    if (options.profile) {
        const normalizedKey = key.toLowerCase();
        const profile = getRedactionPolicyProfile(options.profile);
        if (profile.allowedKeys?.includes(normalizedKey)) {
            return false;
        }
        return profile.exactKeys.includes(normalizedKey) || profile.sensitiveKeyTokens.some((token) => normalizedKey.includes(token)) || Boolean(options.extraPattern?.test(key));
    }
    return (options.pattern ?? SENSITIVE_KEY_PATTERN).test(key) || Boolean(options.extraPattern?.test(key));
}
export function isRedactedValue(value) {
    return /^\[?redacted\]?$/i.test(value) || value === "" || value === "***";
}
export function containsSecretLikeValue(value) {
    return !isRedactedValue(value) && SECRET_LIKE_VALUE_PATTERN.test(value);
}
export function redactJsonValue(value, options = {}, key = "") {
    if (isSensitiveKey(key, options)) {
        return REDACTED_VALUE;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactJsonValue(entry, options));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactJsonValue(entryValue, options, entryKey)]));
    }
    if (typeof value === "string" && options.redactStrings !== false) {
        return redactString(value, options);
    }
    return value;
}
export function redactJsonText(value, options = {}) {
    const redacted = redactJsonValue(JSON.parse(value), options);
    return `${JSON.stringify(redacted, null, 2)}\n`;
}
export function redactString(value, options = {}) {
    return value
        .replace(/(^|\r?\n)([ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*)[^\r\n]*/g, (line, prefix, assignment, key) => (isSensitiveKey(key, options) ? `${prefix}${assignment}${REDACTED_VALUE}` : line))
        .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactUrl(match, options))
        .replace(SECRET_LIKE_VALUE_GLOBAL_PATTERN, REDACTED_VALUE)
        .replace(/([?&][^=&#\s"'<>]+)=([^&#\s"'<>]+)/g, options.redactQueryAssignments ? `$1=${REDACTED_VALUE}` : "$&")
        .replace(/\b(Bearer[ \t]+)[^&#\s"'<>]+/gi, `$1${REDACTED_VALUE}`)
        .replace(/((?:[A-Za-z0-9_-]*)(?:access[_-]?token|auth|bearer|code|cookie|credential|key|login|nonce|pass|password|secret|session|state|token)(?:[A-Za-z0-9_-]*)(?:["'\s]*[:=]["'\s]*))[^&#\s"'<>]+/gi, `$1${REDACTED_VALUE}`);
}
export function redactError(error, options = {}) {
    const source = error instanceof Error ? error : new Error(String(error));
    const redacted = new Error(redactString(source.message, options));
    redacted.name = redactString(source.name, options);
    if (source.stack) {
        redacted.stack = redactString(source.stack, options);
    }
    return redacted;
}
export function redactUrl(value, options = {}) {
    try {
        const url = new URL(value);
        const queryKeys = [...new Set([...url.searchParams.keys()])].sort();
        const query = queryKeys.length > 0
            ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=${shouldRedactUrlQueryKey(key, options) ? REDACTED_VALUE : encodeURIComponent(url.searchParams.get(key) ?? "")}`).join("&")}`
            : "";
        return `${url.origin}${url.pathname}${query}${url.hash && options.redactUrlHash ? `#${REDACTED_VALUE}` : url.hash}`;
    }
    catch {
        return value;
    }
}
function shouldRedactUrlQueryKey(key, options) {
    return Boolean(options.redactAllUrlQueryValues) || isSensitiveKey(key, options);
}
//# sourceMappingURL=redaction.js.map