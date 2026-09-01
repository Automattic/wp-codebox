export declare const REDACTED_VALUE = "[redacted]";
export type RedactionPolicyProfileName = "audit_metadata" | "provider_proxy" | "browser_event" | "public_session_dto";
export interface RedactionPolicyProfile {
    name: RedactionPolicyProfileName;
    exactKeys: readonly string[];
    sensitiveKeyTokens: readonly string[];
    allowedKeys?: readonly string[];
}
export interface SensitiveKeyOptions {
    pattern?: RegExp;
    extraPattern?: RegExp;
    profile?: RedactionPolicyProfileName;
}
export interface RedactJsonOptions extends SensitiveKeyOptions {
    redactStrings?: boolean;
}
export interface RedactStringOptions extends SensitiveKeyOptions {
    redactAllUrlQueryValues?: boolean;
    redactUrlHash?: boolean;
    redactQueryAssignments?: boolean;
}
export declare function getRedactionPolicyProfile(profile: RedactionPolicyProfileName): RedactionPolicyProfile;
export declare function isSensitiveKey(key: string, options?: SensitiveKeyOptions): boolean;
export declare function isRedactedValue(value: string): boolean;
export declare function containsSecretLikeValue(value: string): boolean;
export declare function redactJsonValue(value: unknown, options?: RedactJsonOptions, key?: string): unknown;
export declare function redactJsonText(value: string, options?: RedactJsonOptions): string;
export declare function redactString(value: string, options?: RedactStringOptions): string;
export declare function redactError(error: unknown, options?: RedactStringOptions): Error;
export declare function redactUrl(value: string, options?: RedactStringOptions): string;
//# sourceMappingURL=redaction.d.ts.map