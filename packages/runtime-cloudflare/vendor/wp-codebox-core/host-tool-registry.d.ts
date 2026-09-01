export declare const HOST_TOOL_RESULT_SCHEMA: "wp-codebox/host-tool-result/v1";
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export interface HostToolJsonSchema {
    type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
    required?: string[];
    properties?: Record<string, HostToolJsonSchema>;
    additionalProperties?: boolean;
    items?: HostToolJsonSchema;
}
export interface HostToolPolicyMetadata {
    capability?: string;
    permissions?: string[];
    risk?: "read" | "write" | "external" | (string & {});
    description?: string;
}
export type HostToolRuntimeMetadata = JsonObject;
export interface HostToolCanonicalDeclaration {
    name: string;
    source?: string;
    description: string;
    parameters?: HostToolJsonSchema;
    executor?: "client";
    scope?: "run";
    runtime?: HostToolRuntimeMetadata;
}
export interface HostToolCallContext {
    tool: string;
    policyCommand: string;
    metadata?: Record<string, unknown>;
}
export type HostToolHandler = (input: JsonValue, context: HostToolCallContext) => Promise<JsonValue> | JsonValue;
export interface HostToolDefinition {
    /**
     * Canonical per-run tool declaration supplied by the caller. Codebox treats
     * this as transport input; Agents API owns the generic declaration contract.
     */
    declaration?: HostToolCanonicalDeclaration;
    name: string;
    description: string;
    parameters?: HostToolJsonSchema;
    inputSchema?: HostToolJsonSchema;
    outputSchema: HostToolJsonSchema;
    policy: HostToolPolicyMetadata;
    runtime?: HostToolRuntimeMetadata;
    handler: HostToolHandler;
}
export interface HostToolCanonicalResultOk {
    success: true;
    tool_name: string;
    result: JsonValue;
    metadata: JsonObject;
    runtime?: HostToolRuntimeMetadata;
}
export interface HostToolCanonicalResultError {
    success: false;
    tool_name: string;
    error: string;
    metadata: JsonObject;
    runtime?: HostToolRuntimeMetadata;
}
export type HostToolCanonicalResult = HostToolCanonicalResultOk | HostToolCanonicalResultError;
export interface HostToolResultOk {
    schema: typeof HOST_TOOL_RESULT_SCHEMA;
    tool: string;
    status: "ok";
    output: JsonValue;
    toolResult: HostToolCanonicalResultOk;
    diagnostics: HostToolTransportDiagnostics;
    startedAt: string;
    finishedAt: string;
}
export interface HostToolResultError {
    schema: typeof HOST_TOOL_RESULT_SCHEMA;
    tool: string;
    status: "error";
    error: {
        code: string;
        message: string;
        details?: JsonValue;
    };
    toolResult: HostToolCanonicalResultError;
    diagnostics: HostToolTransportDiagnostics;
    startedAt: string;
    finishedAt: string;
}
export type HostToolResult = HostToolResultOk | HostToolResultError;
export interface HostToolCatalogEntry {
    /** Agents API-shaped declaration exposed to sandbox agents. */
    declaration: HostToolCanonicalDeclaration;
    name: string;
    description: string;
    parameters: HostToolJsonSchema;
    inputSchema: HostToolJsonSchema;
    outputSchema: HostToolJsonSchema;
    policy: HostToolPolicyMetadata;
}
export interface HostToolTransportDiagnostics {
    transport: "wp-codebox-host-tool";
    resultSchema: typeof HOST_TOOL_RESULT_SCHEMA;
    policyCommand: string;
    inputSchema: HostToolJsonSchema;
    outputSchema: HostToolJsonSchema;
    policy: HostToolPolicyMetadata;
}
export declare class HostToolRegistry {
    private readonly tools;
    constructor(definitions?: HostToolDefinition[]);
    register(definition: HostToolDefinition): void;
    get(name: string): HostToolDefinition | undefined;
    has(name: string): boolean;
    list(): HostToolCatalogEntry[];
}
export declare function createHostToolRegistry(definitions?: HostToolDefinition[]): HostToolRegistry;
export declare function executeHostTool(definition: HostToolDefinition, input: JsonValue, context: HostToolCallContext): Promise<HostToolResult>;
export declare function createHostToolTransportError(definition: HostToolDefinition | string, policyCommand: string, startedAt: string, code: string, message: string, details?: JsonValue): HostToolResultError;
//# sourceMappingURL=host-tool-registry.d.ts.map