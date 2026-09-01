export const HOST_TOOL_RESULT_SCHEMA = "wp-codebox/host-tool-result/v1";
export class HostToolRegistry {
    tools = new Map();
    constructor(definitions = []) {
        for (const definition of definitions) {
            this.register(definition);
        }
    }
    register(definition) {
        assertValidHostToolDefinition(definition);
        if (this.tools.has(definition.name)) {
            throw new Error(`Host tool is already registered: ${definition.name}`);
        }
        this.tools.set(definition.name, definition);
    }
    get(name) {
        return this.tools.get(name);
    }
    has(name) {
        return this.tools.has(name);
    }
    list() {
        return [...this.tools.values()].map((definition) => {
            const declaration = canonicalDeclarationForHostTool(definition);
            return {
                declaration,
                name: declaration.name,
                description: declaration.description,
                parameters: declaration.parameters ?? {},
                inputSchema: inputSchemaForHostTool(definition),
                outputSchema: definition.outputSchema,
                policy: definition.policy,
            };
        });
    }
}
export function createHostToolRegistry(definitions = []) {
    return new HostToolRegistry(definitions);
}
export async function executeHostTool(definition, input, context) {
    const startedAt = new Date().toISOString();
    const inputIssue = validateJsonValueAgainstSchema(input, inputSchemaForHostTool(definition), "input");
    if (inputIssue) {
        return hostToolError(definition, context.policyCommand, startedAt, "host-tool-invalid-input", inputIssue);
    }
    try {
        const output = await definition.handler(input, context);
        const outputIssue = validateJsonValueAgainstSchema(output, definition.outputSchema, "output");
        if (outputIssue) {
            return hostToolError(definition, context.policyCommand, startedAt, "host-tool-invalid-output", outputIssue);
        }
        return {
            schema: HOST_TOOL_RESULT_SCHEMA,
            tool: definition.name,
            status: "ok",
            output,
            toolResult: hostToolCanonicalSuccess(definition, output),
            diagnostics: hostToolDiagnostics(definition, context.policyCommand),
            startedAt,
            finishedAt: new Date().toISOString(),
        };
    }
    catch (error) {
        return hostToolError(definition, context.policyCommand, startedAt, "host-tool-handler-error", error instanceof Error ? error.message : String(error));
    }
}
export function createHostToolTransportError(definition, policyCommand, startedAt, code, message, details) {
    return hostToolError(definition, policyCommand, startedAt, code, message, details);
}
function hostToolError(definition, policyCommand, startedAt, code, message, details) {
    const tool = typeof definition === "string" ? definition : definition.name;
    return {
        schema: HOST_TOOL_RESULT_SCHEMA,
        tool,
        status: "error",
        error: {
            code,
            message,
            ...(details === undefined ? {} : { details }),
        },
        toolResult: typeof definition === "string"
            ? hostToolCanonicalError(tool, message, code, details)
            : hostToolCanonicalError(definition, message, code, details),
        diagnostics: typeof definition === "string"
            ? hostToolDiagnosticsForUnknown(policyCommand)
            : hostToolDiagnostics(definition, policyCommand),
        startedAt,
        finishedAt: new Date().toISOString(),
    };
}
function assertValidHostToolDefinition(definition) {
    const declaration = canonicalDeclarationForHostTool(definition);
    if (!declaration.name || !/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/i.test(declaration.name)) {
        throw new Error("Host tool name must be a stable canonical tool id such as client/search_docs");
    }
    if (declaration.source !== sourceFromToolName(declaration.name)) {
        throw new Error(`Host tool ${declaration.name} source must match its canonical name prefix`);
    }
    if (declaration.executor !== "client") {
        throw new Error(`Host tool ${declaration.name} executor must be client`);
    }
    if (declaration.scope !== "run") {
        throw new Error(`Host tool ${declaration.name} scope must be run`);
    }
    if (!declaration.description) {
        throw new Error(`Host tool ${declaration.name} is missing a description`);
    }
    if (typeof definition.handler !== "function") {
        throw new Error(`Host tool ${declaration.name} is missing a handler`);
    }
    definition.name = declaration.name;
    definition.description = declaration.description;
    definition.inputSchema = inputSchemaForHostTool(definition);
}
function canonicalDeclarationForHostTool(definition) {
    const name = definition.declaration?.name ?? definition.name;
    const parameters = definition.declaration?.parameters ?? definition.parameters ?? definition.inputSchema;
    const runtime = definition.declaration?.runtime ?? definition.runtime;
    return {
        name,
        source: definition.declaration?.source ?? sourceFromToolName(name),
        description: definition.declaration?.description ?? definition.description,
        parameters,
        executor: definition.declaration?.executor ?? "client",
        scope: definition.declaration?.scope ?? "run",
        ...(runtime ? { runtime } : {}),
    };
}
function hostToolCanonicalSuccess(definition, result) {
    const runtime = canonicalDeclarationForHostTool(definition).runtime;
    return {
        success: true,
        tool_name: definition.name,
        result,
        metadata: {},
        ...(runtime ? { runtime } : {}),
    };
}
function hostToolCanonicalError(definition, error, code, details) {
    const toolName = typeof definition === "string" ? definition : definition.name;
    const runtime = typeof definition === "string" ? undefined : canonicalDeclarationForHostTool(definition).runtime;
    return {
        success: false,
        tool_name: toolName,
        error,
        metadata: {
            code,
            ...(details === undefined ? {} : { details }),
        },
        ...(runtime ? { runtime } : {}),
    };
}
function hostToolDiagnostics(definition, policyCommand) {
    return {
        transport: "wp-codebox-host-tool",
        resultSchema: HOST_TOOL_RESULT_SCHEMA,
        policyCommand,
        inputSchema: inputSchemaForHostTool(definition),
        outputSchema: definition.outputSchema,
        policy: definition.policy,
    };
}
function hostToolDiagnosticsForUnknown(policyCommand) {
    return {
        transport: "wp-codebox-host-tool",
        resultSchema: HOST_TOOL_RESULT_SCHEMA,
        policyCommand,
        inputSchema: {},
        outputSchema: {},
        policy: {},
    };
}
function sourceFromToolName(name) {
    return name.includes("/") ? name.split("/", 1)[0] : "client";
}
function inputSchemaForHostTool(definition) {
    return definition.declaration?.parameters ?? definition.parameters ?? definition.inputSchema ?? {};
}
function validateJsonValueAgainstSchema(value, schema, path) {
    if (schema.type && !jsonValueMatchesType(value, schema.type)) {
        return `${path} must be ${schema.type}`;
    }
    if (schema.type === "object" || schema.properties || schema.required) {
        if (!isJsonObject(value)) {
            return `${path} must be object`;
        }
        for (const key of schema.required ?? []) {
            if (!(key in value)) {
                return `${path}.${key} is required`;
            }
        }
        for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
            if (key in value) {
                const issue = validateJsonValueAgainstSchema(value[key], childSchema, `${path}.${key}`);
                if (issue) {
                    return issue;
                }
            }
        }
        if (schema.additionalProperties === false) {
            const allowed = new Set(Object.keys(schema.properties ?? {}));
            const extra = Object.keys(value).find((key) => !allowed.has(key));
            if (extra) {
                return `${path}.${extra} is not allowed`;
            }
        }
    }
    if ((schema.type === "array" || schema.items) && Array.isArray(value) && schema.items) {
        for (let index = 0; index < value.length; index++) {
            const issue = validateJsonValueAgainstSchema(value[index], schema.items, `${path}[${index}]`);
            if (issue) {
                return issue;
            }
        }
    }
    return undefined;
}
function jsonValueMatchesType(value, type) {
    if (type === "null") {
        return value === null;
    }
    if (type === "array") {
        return Array.isArray(value);
    }
    if (type === "object") {
        return isJsonObject(value);
    }
    if (type === "integer") {
        return typeof value === "number" && Number.isInteger(value);
    }
    return typeof value === type;
}
function isJsonObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=host-tool-registry.js.map