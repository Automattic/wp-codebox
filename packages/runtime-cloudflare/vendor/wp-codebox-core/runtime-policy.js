export class RuntimePolicyValidationError extends Error {
    issues;
    code = "runtime-policy-invalid";
    constructor(issues) {
        super(`Runtime policy is invalid: ${issues.map((issue) => issue.message).join("; ")}`);
        this.issues = issues;
        this.name = "RuntimePolicyValidationError";
    }
    toJSON() {
        return {
            code: this.code,
            issues: this.issues,
            message: this.message,
            name: this.name,
        };
    }
}
export class RuntimeCommandPolicyViolationError extends Error {
    code = "runtime-command-disallowed";
    command;
    allowedCommands;
    policy;
    constructor(command, policy) {
        super(`Command is not allowed by runtime policy: ${command}`);
        this.name = "RuntimeCommandPolicyViolationError";
        this.command = command;
        this.allowedCommands = [...policy.commands];
        this.policy = policy;
    }
    toJSON() {
        return {
            code: this.code,
            command: this.command,
            allowedCommands: this.allowedCommands,
            policy: this.policy,
            message: this.message,
            name: this.name,
        };
    }
}
export function validateRuntimePolicy(policy) {
    const issues = [];
    const candidate = policy;
    if (!candidate || typeof candidate !== "object") {
        return {
            valid: false,
            issues: [
                { code: "invalid-network", field: "network", message: "policy must be an object with v0 policy fields" },
                { code: "invalid-filesystem", field: "filesystem", message: "policy must be an object with v0 policy fields" },
                { code: "invalid-command", field: "commands", message: "policy must be an object with v0 policy fields" },
                { code: "invalid-secrets", field: "secrets", message: "policy must be an object with v0 policy fields" },
                { code: "invalid-approvals", field: "approvals", message: "policy must be an object with v0 policy fields" },
            ],
        };
    }
    if (candidate.network !== "allow" &&
        candidate.network !== "deny" &&
        (!candidate.network ||
            typeof candidate.network !== "object" ||
            !Array.isArray(candidate.network.allowHosts) ||
            !candidate.network.allowHosts.every((host) => typeof host === "string" && host.length > 0))) {
        issues.push({
            code: "invalid-network",
            field: "network",
            message: "network must be allow, deny, or an allowHosts list",
        });
    }
    if (!["sandbox", "readonly-mounts", "readwrite-mounts"].includes(candidate.filesystem ?? "")) {
        issues.push({
            code: "invalid-filesystem",
            field: "filesystem",
            message: "filesystem must be sandbox, readonly-mounts, or readwrite-mounts",
        });
    }
    if (!Array.isArray(candidate.commands) || !candidate.commands.every((command) => typeof command === "string" && command.length > 0)) {
        issues.push({
            code: "invalid-command",
            field: "commands",
            message: "commands must be a list of non-empty command names",
        });
    }
    if (!["none", "connector-scoped"].includes(candidate.secrets ?? "")) {
        issues.push({
            code: "invalid-secrets",
            field: "secrets",
            message: "secrets must be none or connector-scoped",
        });
    }
    if (!["never", "on-write", "on-command"].includes(candidate.approvals ?? "")) {
        issues.push({
            code: "invalid-approvals",
            field: "approvals",
            message: "approvals must be never, on-write, or on-command",
        });
    }
    return { valid: issues.length === 0, issues };
}
export function assertRuntimePolicy(policy) {
    const result = validateRuntimePolicy(policy);
    if (!result.valid) {
        throw new RuntimePolicyValidationError(result.issues);
    }
}
export function assertRuntimeCommandAllowed(command, policy) {
    if (!policy.commands.includes(command)) {
        throw new RuntimeCommandPolicyViolationError(command, policy);
    }
}
//# sourceMappingURL=runtime-policy.js.map