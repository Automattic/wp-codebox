export interface RuntimePolicy {
    network: "allow" | "deny" | {
        allowHosts: string[];
    };
    filesystem: "sandbox" | "readonly-mounts" | "readwrite-mounts";
    commands: string[];
    secrets: "none" | "connector-scoped";
    approvals: "never" | "on-write" | "on-command";
}
export type RuntimePolicyField = keyof RuntimePolicy;
export type RuntimePolicyValidationIssueCode = "invalid-network" | "invalid-filesystem" | "invalid-command" | "invalid-secrets" | "invalid-approvals";
export interface RuntimePolicyValidationIssue {
    code: RuntimePolicyValidationIssueCode;
    field: RuntimePolicyField;
    message: string;
}
export interface RuntimePolicyValidationResult {
    valid: boolean;
    issues: RuntimePolicyValidationIssue[];
}
export interface RuntimeCommandPolicyViolationDetails {
    code: "runtime-command-disallowed";
    command: string;
    allowedCommands: string[];
    policy: RuntimePolicy;
}
export declare class RuntimePolicyValidationError extends Error {
    readonly issues: RuntimePolicyValidationIssue[];
    readonly code: "runtime-policy-invalid";
    constructor(issues: RuntimePolicyValidationIssue[]);
    toJSON(): {
        code: "runtime-policy-invalid";
        issues: RuntimePolicyValidationIssue[];
        message: string;
        name: string;
    };
}
export declare class RuntimeCommandPolicyViolationError extends Error {
    readonly code: "runtime-command-disallowed";
    readonly command: string;
    readonly allowedCommands: string[];
    readonly policy: RuntimePolicy;
    constructor(command: string, policy: RuntimePolicy);
    toJSON(): RuntimeCommandPolicyViolationDetails & {
        message: string;
        name: string;
    };
}
export declare function validateRuntimePolicy(policy: unknown): RuntimePolicyValidationResult;
export declare function assertRuntimePolicy(policy: unknown): asserts policy is RuntimePolicy;
export declare function assertRuntimeCommandAllowed(command: string, policy: RuntimePolicy): void;
//# sourceMappingURL=runtime-policy.d.ts.map