export declare const TRANSPORT_FAULT_MODEL_SCHEMA: "wp-codebox/transport-fault-model/v1";
export declare const TRANSPORT_FAULT_CAPABILITIES_SCHEMA: "wp-codebox/transport-fault-capabilities/v1";
export declare const TRANSPORT_FAULT_EVIDENCE_SCHEMA: "wp-codebox/transport-fault-evidence/v1";
export declare const TRANSPORT_FAULT_SAFE_SCHEDULE_SCHEMA: "wp-codebox/transport-fault-safe-schedule/v1";
export type TransportFaultSemantic = "response-substitution" | "malformed-response" | "truncated-response" | "chunked-response" | "delay" | "jitter" | "bandwidth" | "timeout" | "connection-refusal" | "connection-reset" | "half-close" | "disconnect-after-bytes" | "host-remap" | "request-corruption" | "response-corruption";
export type TransportFaultFidelity = "exact" | "emulated" | "unsupported";
export interface TransportRequestMatcher {
    host?: string;
    method?: string;
    path?: string;
    pathPattern?: string;
    headers?: Record<string, string>;
}
export interface TransportFaultOutcome {
    passthrough?: true;
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: string;
    malformed?: boolean;
    truncateAfterBytes?: number;
    chunkBytes?: number;
    delayMs?: number;
    jitterMs?: number;
    bandwidthBytesPerSecond?: number;
    timeoutMs?: number;
    connection?: "refuse" | "reset" | "half-close";
    disconnectAfterBytes?: number;
    remapHost?: string;
    requestCorruption?: "truncate" | "flip-byte" | "invalid-encoding";
    responseCorruption?: "flip-byte" | "invalid-encoding";
    metadata?: Record<string, unknown>;
}
export interface TransportFaultRule {
    id: string;
    match: TransportRequestMatcher;
    sequence: TransportFaultOutcome[];
    repeat?: "last" | "cycle" | "none";
    metadata?: Record<string, unknown>;
}
export interface TransportFaultModel {
    schema: typeof TRANSPORT_FAULT_MODEL_SCHEMA;
    seed: string;
    rules: TransportFaultRule[];
    redactHeaders?: string[];
    metadata?: Record<string, unknown>;
}
export interface TransportFaultCapability {
    semantic: TransportFaultSemantic;
    fidelity: TransportFaultFidelity;
    reason?: string;
}
export interface TransportFaultCapabilities {
    schema: typeof TRANSPORT_FAULT_CAPABILITIES_SCHEMA;
    adapter: string;
    capabilities: TransportFaultCapability[];
}
export interface TransportFaultNegotiation {
    supported: boolean;
    required: TransportFaultSemantic[];
    unsupported: TransportFaultCapability[];
    capabilities: TransportFaultCapabilities;
}
export interface TransportFaultRequest {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
}
export interface TransportFaultDecision {
    ruleId: string;
    sequenceIndex: number;
    invocation: number;
    outcome: TransportFaultOutcome;
    semantics: TransportFaultSemantic[];
    delayMs: number;
}
export interface TransportFaultEvidence {
    schema: typeof TRANSPORT_FAULT_EVIDENCE_SCHEMA;
    fingerprint: string;
    adapter: string;
    fidelity: TransportFaultCapability[];
    request: {
        url: string;
        method: string;
        headers: Record<string, string>;
        bodyBytes?: number;
    };
    fault?: {
        ruleId: string;
        sequenceIndex: number;
        invocation: number;
        semantics: TransportFaultSemantic[];
        delayMs: number;
    };
    response?: {
        status?: number;
        headers?: Record<string, string>;
        bodyBytes?: number;
        connection?: string;
    };
}
export interface TransportFaultSafeSchedule {
    schema: typeof TRANSPORT_FAULT_SAFE_SCHEDULE_SCHEMA;
    seed: string;
    structuralFingerprint: string;
    rules: Array<{
        id: string;
        match: Omit<TransportRequestMatcher, "headers"> & {
            headerNames?: string[];
        };
        sequence: Array<Omit<TransportFaultOutcome, "headers" | "body" | "bodyBase64" | "metadata"> & {
            headerNames?: string[];
            body?: {
                encoding: "utf8" | "base64";
                bytes: number;
                redacted: true;
            };
            metadataRedacted?: true;
        }>;
        repeat?: TransportFaultRule["repeat"];
        metadataRedacted?: true;
    }>;
    redactHeaders?: string[];
    metadataRedacted?: true;
}
export declare class TransportFaultEngine {
    #private;
    readonly model: TransportFaultModel;
    readonly capabilities: TransportFaultCapabilities;
    readonly evidence: TransportFaultEvidence[];
    constructor(model: TransportFaultModel, capabilities: TransportFaultCapabilities);
    decide(request: TransportFaultRequest): TransportFaultDecision | undefined;
    record(request: TransportFaultRequest, decision: TransportFaultDecision | undefined, response?: TransportFaultEvidence["response"]): TransportFaultEvidence;
}
export declare function transportFaultModel(input: Omit<TransportFaultModel, "schema"> & {
    schema?: string;
}): TransportFaultModel;
export declare function transportFaultCapabilities(adapter: string, capabilities: readonly TransportFaultCapability[]): TransportFaultCapabilities;
export declare function transportFaultSafeSchedule(modelInput: TransportFaultModel): TransportFaultSafeSchedule;
export declare function negotiateTransportFaults(model: TransportFaultModel, capabilities: TransportFaultCapabilities): TransportFaultNegotiation;
export declare function transportRequestMatches(matcher: TransportRequestMatcher, request: TransportFaultRequest): boolean;
export declare function transportFaultOutcomeSemantics(outcome: TransportFaultOutcome): TransportFaultSemantic[];
export declare function transportFaultFingerprint(value: unknown): string;
export declare function redactTransportHeaders(headers: Record<string, string>, extra?: readonly string[]): Record<string, string>;
export declare function redactTransportUrl(raw: string): string;
//# sourceMappingURL=transport-faults.d.ts.map