export const WORDPRESS_DB_OPERATION_SCHEMA = "wp-codebox/wordpress-db-operation/v1";
export const WORDPRESS_DB_RESULT_SCHEMA = "wp-codebox/wordpress-db-result/v1";
export const WORDPRESS_DB_OPERATION_JSON_SCHEMA = {
    $id: WORDPRESS_DB_OPERATION_SCHEMA,
    type: "object",
    additionalProperties: false,
    required: ["schema", "operation"],
    properties: {
        schema: { const: WORDPRESS_DB_OPERATION_SCHEMA },
        operation: { enum: ["schema", "read", "inspect", "query-summary", "write"] },
        resource: {
            type: "object",
            additionalProperties: false,
            properties: {
                table: { type: "string", minLength: 1 },
                identifiers: {
                    type: "object",
                    additionalProperties: { type: ["string", "number", "boolean", "null"] },
                },
            },
        },
        query: {
            type: "object",
            additionalProperties: true,
            properties: {
                table: { type: "string", minLength: 1 },
                columns: { type: "array", items: { type: "string", minLength: 1 } },
                where: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
                limit: { type: "integer", minimum: 1, maximum: 100 },
                sql: { type: "string", minLength: 1 },
            },
        },
        options: { type: "object", additionalProperties: true },
        metadata: { type: "object", additionalProperties: true },
    },
};
export const WORDPRESS_DB_RESULT_JSON_SCHEMA = {
    $id: WORDPRESS_DB_RESULT_SCHEMA,
    type: "object",
    additionalProperties: true,
    required: ["schema", "command", "status", "operation"],
    properties: {
        schema: { const: WORDPRESS_DB_RESULT_SCHEMA },
        command: { const: "wordpress.db-operation" },
        status: { enum: ["ok", "unsupported", "error"] },
        operation: WORDPRESS_DB_OPERATION_JSON_SCHEMA,
        item: {},
        items: { type: "array" },
        diagnostics: { type: "array" },
        errors: { type: "array" },
        artifactRefs: { type: "array" },
        metadata: { type: "object", additionalProperties: true },
    },
};
export function normalizeWordPressDbOperation(input) {
    const value = requireObject(input, "wordpress.db-operation");
    const operation = requiredString(value.operation, "wordpress.db-operation.operation");
    if (!isWordPressDbVerb(operation)) {
        throw new Error("wordpress.db-operation.operation must be schema, read, inspect, query-summary, or write.");
    }
    return stripUndefined({
        schema: WORDPRESS_DB_OPERATION_SCHEMA,
        operation,
        resource: normalizeOptionalDbResourceRef(value.resource),
        query: normalizeOptionalDbQuery(value.query),
        options: normalizeOptionalObject(value.options, "wordpress.db-operation.options"),
        metadata: normalizeOptionalObject(value.metadata, "wordpress.db-operation.metadata"),
    });
}
export function createUnsupportedWordPressDbResult(operation, message = "wordpress.db-operation is not implemented by this runtime backend.") {
    return {
        schema: WORDPRESS_DB_RESULT_SCHEMA,
        command: "wordpress.db-operation",
        status: "unsupported",
        operation,
        diagnostics: [{ code: "db-operation-unsupported", message, severity: "warning" }],
        artifactRefs: [],
    };
}
function normalizeOptionalDbResourceRef(input) {
    if (input === undefined)
        return undefined;
    const value = requireObject(input, "wordpress.db-operation.resource");
    return stripUndefined({
        table: optionalString(value.table, "wordpress.db-operation.resource.table"),
        identifiers: normalizeDbIdentifiers(value.identifiers),
    });
}
function normalizeDbIdentifiers(input) {
    if (input === undefined)
        return undefined;
    const value = requireObject(input, "wordpress.db-operation.resource.identifiers");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
        if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean" && entry !== null) {
            throw new Error(`wordpress.db-operation.resource.identifiers.${key} must be a scalar value.`);
        }
        return [key, entry];
    }));
}
function normalizeOptionalDbQuery(input) {
    if (input === undefined)
        return undefined;
    const value = requireObject(input, "wordpress.db-operation.query");
    const where = value.where === undefined ? undefined : normalizeDbScalars(value.where, "wordpress.db-operation.query.where");
    return stripUndefined({
        ...value,
        table: optionalString(value.table, "wordpress.db-operation.query.table"),
        columns: normalizeOptionalStringList(value.columns, "wordpress.db-operation.query.columns"),
        where,
        limit: normalizeOptionalLimit(value.limit),
        sql: optionalString(value.sql, "wordpress.db-operation.query.sql"),
    });
}
function normalizeDbScalars(input, label) {
    const value = requireObject(input, label);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
        if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean" && entry !== null) {
            throw new Error(`${label}.${key} must be a scalar value.`);
        }
        return [key, entry];
    }));
}
function normalizeOptionalStringList(input, label) {
    if (input === undefined)
        return undefined;
    if (!Array.isArray(input))
        throw new Error(`${label} must be an array.`);
    const normalized = input.map((entry, index) => requiredString(entry, `${label}.${index}`));
    return normalized.length ? normalized : undefined;
}
function normalizeOptionalLimit(input) {
    if (input === undefined)
        return undefined;
    if (typeof input !== "number" || !Number.isInteger(input))
        throw new Error("wordpress.db-operation.query.limit must be an integer.");
    return Math.max(1, Math.min(100, input));
}
function isWordPressDbVerb(value) {
    return value === "schema" || value === "read" || value === "inspect" || value === "query-summary" || value === "write";
}
function normalizeOptionalObject(value, label) {
    if (value === undefined)
        return undefined;
    return requireObject(value, label);
}
function requireObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object.`);
    return value;
}
function requiredString(value, label) {
    const normalized = optionalString(value, label);
    if (!normalized)
        throw new Error(`${label} must be a non-empty string.`);
    return normalized;
}
function optionalString(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        throw new Error(`${label} must be a string.`);
    const normalized = value.trim();
    return normalized === "" ? undefined : normalized;
}
function stripUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
//# sourceMappingURL=wordpress-db-contracts.js.map