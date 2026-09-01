import { type FuzzCoveragePlanContract } from "./fuzz-coverage-plan-contracts.js";
export declare const FUZZ_SUITE_SCHEMA: "wp-codebox/fuzz-suite/v1";
export declare const FUZZ_SUITE_RESULT_SCHEMA: "wp-codebox/fuzz-suite-result/v1";
export declare const FUZZ_RUNNER_CAPABILITIES_SCHEMA: "wp-codebox/fuzz-runner-capabilities/v1";
export declare const FUZZ_RUNNER_READINESS_SCHEMA: "wp-codebox/fuzz-runner-readiness/v1";
export declare const FUZZ_ARTIFACT_BUNDLE_SCHEMA: "wp-codebox/fuzz-artifact-bundle/v1";
export declare const FUZZ_REPLAY_CASE_REF_SCHEMA: "wp-codebox/fuzz-replay-case-ref/v1";
export declare const FUZZ_MINIMIZE_CAPABILITY_SCHEMA: "wp-codebox/fuzz-minimize-capability/v1";
export declare const WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA: "wp-codebox/wordpress-fuzz-runtime-contract/v1";
export type FuzzSuiteTargetKind = "ability" | "command" | "http" | "rest" | "runtime" | "runtime-action" | (string & {});
export type FuzzSuiteCaseStatus = "passed" | "failed" | "error" | "skipped";
export type FuzzSuiteDiagnosticSeverity = "error" | "warning" | "info";
export type FuzzSuiteRunnerMode = "php-in-process" | "runtime-backed" | (string & {});
export type FuzzSuiteResetMode = "none" | "checkpoint-per-case" | "restore-snapshot";
export type FuzzSuiteResetStatus = "not-required" | "passed" | "failed" | "unsupported";
export type FuzzSuiteMutationIntensity = "none" | "low" | "medium" | "high" | (string & {});
export type FuzzSuiteMutationIntentKind = "read" | "write" | "delete" | "destructive" | (string & {});
export type FuzzSuiteCasePhase = "setup" | "action" | "assert" | "teardown";
export interface FuzzSuiteTargetRef {
    kind: FuzzSuiteTargetKind;
    id?: string;
    entrypoint?: string;
    label?: string;
    metadata?: Record<string, unknown>;
}
export interface FuzzSuiteCase {
    id: string;
    target?: FuzzSuiteTargetRef;
    input?: unknown;
    phases?: Partial<Record<FuzzSuiteCasePhase, FuzzSuitePhaseStep[]>>;
    resetPolicy?: FuzzSuiteResetPolicy;
    reset_policy?: FuzzSuiteResetPolicy | string;
    mutation?: FuzzSuiteMutationIntent;
    mutation_intent?: FuzzSuiteMutationIntent | string;
    description?: string;
    metadata?: Record<string, unknown>;
}
export interface FuzzSuitePhaseStep {
    command: string;
    args?: string[];
    timeoutMs?: number;
    timeout_ms?: number;
    allowFailure?: boolean;
    allow_failure?: boolean;
    advisory?: boolean;
    metadata?: Record<string, unknown>;
}
export interface FuzzSuiteMutationIntent {
    intent?: FuzzSuiteMutationIntentKind;
    destructive?: boolean;
    intensity?: FuzzSuiteMutationIntensity;
    metadata?: Record<string, unknown>;
}
export interface FuzzSuiteResetPolicy {
    mode: FuzzSuiteResetMode | (string & {});
    checkpointName?: string;
    checkpoint_name?: string;
    snapshotRef?: string;
    snapshot_ref?: string;
    fixtureRefs?: string[];
    fixture_refs?: string[];
    metadata?: Record<string, unknown>;
}
export interface FuzzSuiteCaseResetResult {
    mode: FuzzSuiteResetMode | (string & {});
    status: FuzzSuiteResetStatus;
    checkpointName?: string;
    snapshotRef?: string;
    fixtureRefs?: string[];
    artifactRefs?: FuzzSuiteArtifactRef[];
    diagnostics?: FuzzSuiteDiagnostic[];
    metadata?: Record<string, unknown>;
}
export interface FuzzSuiteContract {
    schema: typeof FUZZ_SUITE_SCHEMA;
    id: string;
    version?: string;
    target?: FuzzSuiteTargetRef;
    resetPolicy?: FuzzSuiteResetPolicy;
    reset_policy?: FuzzSuiteResetPolicy | string;
    mutation?: FuzzSuiteMutationIntent;
    mutation_intent?: FuzzSuiteMutationIntent | string;
    cases: FuzzSuiteCase[];
    coveragePlan?: FuzzCoveragePlanContract;
    metadata?: Record<string, unknown>;
}
export interface FuzzSuiteRunnerCapabilities {
    schema?: typeof FUZZ_RUNNER_CAPABILITIES_SCHEMA;
    mode: FuzzSuiteRunnerMode;
    entrypoint?: string;
    capabilities: string[];
    targetKinds: string[];
    operationKinds?: string[];
    runtimeActionTypes?: string[];
    commands?: string[];
    unsupportedRequiredCapabilities?: string[];
    metadata?: Record<string, unknown>;
}
export interface FuzzRunnerCapabilitiesContract extends FuzzSuiteRunnerCapabilities {
    schema: typeof FUZZ_RUNNER_CAPABILITIES_SCHEMA;
    unsupportedRequiredCapabilities: string[];
}
export interface FuzzRunnerReadinessContract {
    schema: typeof FUZZ_RUNNER_READINESS_SCHEMA;
    status: "ready" | "unsupported";
    entrypoint: string;
    mode: FuzzSuiteRunnerMode;
    capabilities: FuzzRunnerCapabilitiesContract;
    operationKinds: string[];
    unsupportedRequiredCapabilities: string[];
    disposable?: boolean;
    isolation?: {
        runtime_backed: true;
        disposable: true;
        sandboxed: true;
    };
    guardrails?: {
        external_side_effect_guardrail: true;
        external_http_guardrail: true;
    };
    artifacts?: {
        artifact_export: true;
    };
    destructiveModeRequirements?: WordPressFuzzDestructiveModeRequirements;
    metadata?: Record<string, unknown>;
}
export interface WordPressFuzzRuntimeContract {
    schema: typeof WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA;
    version: 1;
    runtime: {
        id: "wp-codebox";
        environment: "wordpress";
    };
    publicSurfaces: {
        phpFacade: string;
        ability: string;
        wpCli: string;
        nodeCli: string;
        typescript: string;
    };
    actionFamilies: WordPressFuzzActionFamily[];
    resetModes: WordPressFuzzResetMode[];
    artifactExpectations: WordPressFuzzArtifactExpectation[];
    destructiveModeRequirements: WordPressFuzzDestructiveModeRequirements;
    unsupportedCapabilities: WordPressFuzzUnsupportedCapability[];
    hbex: {
        schemaIds: Record<string, string>;
    };
}
export interface WordPressFuzzActionFamily {
    id: string;
    label: string;
    targetKinds: string[];
    runtimeActionTypes: string[];
    commands: string[];
    mutationIntents: FuzzSuiteMutationIntentKind[];
    supported: boolean;
}
export interface WordPressFuzzResetMode {
    id: FuzzSuiteResetMode;
    supported: boolean;
    optionalForMutationIntents: FuzzSuiteMutationIntentKind[];
    artifactKinds: string[];
}
export interface WordPressFuzzArtifactExpectation {
    id: string;
    required: boolean;
    schema: string;
    producedBy: string[];
    description: string;
}
export interface WordPressFuzzDestructiveModeRequirements {
    supported: boolean;
    destructiveMutationIntent: "destructive";
    requiredSandboxBoundary: {
        disposable: true;
        destructivePermission: true;
        teardown: "discard";
    };
    requiredSandboxProof: {
        schema: "wp-codebox/destructive-sandbox-proof/v1";
        boundarySource: "runtime-created";
    };
    optionalResetModes: FuzzSuiteResetMode[];
    requiredArtifacts: string[];
    deleteBoundaryCapability: string;
    rawDeleteCapability: null;
}
export interface WordPressFuzzUnsupportedCapability {
    id: string;
    reason: string;
    replacement?: string;
}
export interface FuzzRunnerRequiredCapabilities {
    capabilities?: readonly string[];
    targetKinds?: readonly string[];
    target_kinds?: readonly string[];
    runtimeActionTypes?: readonly string[];
    runtime_action_types?: readonly string[];
    commands?: readonly string[];
}
export declare const PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES: FuzzSuiteRunnerCapabilities;
export declare const RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES: FuzzSuiteRunnerCapabilities;
export declare const WORDPRESS_FUZZ_RUNTIME_CONTRACT: WordPressFuzzRuntimeContract;
export declare function wordpressFuzzRuntimeContract(): WordPressFuzzRuntimeContract;
export interface FuzzSuiteDiagnostic {
    severity: FuzzSuiteDiagnosticSeverity;
    message: string;
    code?: string;
    caseId?: string;
    target?: FuzzSuiteTargetRef;
    metadata?: Record<string, unknown>;
}
export interface FuzzSuiteArtifactRef {
    path: string;
    kind: string;
    contentType?: string;
    sha256?: string;
    bytes?: number;
    name?: string;
    metadata?: Record<string, unknown>;
}
export interface FuzzReplayCaseRef {
    schema: typeof FUZZ_REPLAY_CASE_REF_SCHEMA;
    caseId: string;
    path: string;
    kind: "fuzz-replay-case" | (string & {});
    contentType: "application/json" | (string & {});
    sha256?: string;
    bytes?: number;
    target?: FuzzSuiteTargetRef;
    status?: FuzzSuiteCaseStatus;
    metadata?: Record<string, unknown>;
}
export interface FuzzMinimizeCapabilityContract {
    schema: typeof FUZZ_MINIMIZE_CAPABILITY_SCHEMA;
    status: "supported" | "unsupported";
    inputKind: "fuzz-replay-case" | (string & {});
    operation?: string;
    reason?: string;
    requiredArtifacts?: string[];
    metadata?: Record<string, unknown>;
}
export interface FuzzArtifactBundleContract {
    schema: typeof FUZZ_ARTIFACT_BUNDLE_SCHEMA;
    suiteId: string;
    path: string;
    manifestPath: string;
    resultRef: FuzzSuiteArtifactRef;
    caseResultStreamRef: FuzzSuiteArtifactRef;
    replayCaseRefs: FuzzReplayCaseRef[];
    hotspotRefs: FuzzSuiteArtifactRef[];
    minimize: FuzzMinimizeCapabilityContract;
    artifactRefs: FuzzSuiteArtifactRef[];
    metadata?: Record<string, unknown>;
}
export interface FuzzSuiteCaseResult {
    id: string;
    status: FuzzSuiteCaseStatus;
    success: boolean;
    target?: FuzzSuiteTargetRef;
    reset?: FuzzSuiteCaseResetResult;
    skipReason?: string;
    diagnostics: FuzzSuiteDiagnostic[];
    artifactRefs?: FuzzSuiteArtifactRef[];
    metadata?: Record<string, unknown>;
}
export interface FuzzSuiteSummary {
    total: number;
    passed: number;
    failed: number;
    error: number;
    skipped: number;
}
export interface FuzzSuiteSkippedReasonSummary {
    reason: string;
    count: number;
    caseIds?: string[];
}
export interface FuzzSuiteCoverageSummary {
    discovered: number;
    generated: number;
    executed: number;
    skipped: number;
    untested: number;
    skippedReasons: FuzzSuiteSkippedReasonSummary[];
}
export interface FuzzSuiteResultEnvelope {
    schema: typeof FUZZ_SUITE_RESULT_SCHEMA;
    suite: {
        id: string;
        version?: string;
    };
    status: FuzzSuiteCaseStatus;
    success: boolean;
    summary: FuzzSuiteSummary;
    coverageSummary?: FuzzSuiteCoverageSummary;
    coveragePlan?: FuzzCoveragePlanContract;
    cases: FuzzSuiteCaseResult[];
    diagnostics: FuzzSuiteDiagnostic[];
    artifactRefs: FuzzSuiteArtifactRef[];
    metadata?: Record<string, unknown>;
}
export declare function fuzzSuiteContract(input: {
    id: string;
    version?: string;
    target?: FuzzSuiteTargetRef;
    resetPolicy?: FuzzSuiteResetPolicy;
    reset_policy?: FuzzSuiteResetPolicy | string;
    mutation?: FuzzSuiteMutationIntent;
    mutation_intent?: FuzzSuiteMutationIntent | string;
    cases?: FuzzSuiteCase[];
    coveragePlan?: FuzzCoveragePlanContract;
    metadata?: Record<string, unknown>;
}): FuzzSuiteContract;
export declare function fuzzSuiteResultEnvelope(input: {
    suite: {
        id: string;
        version?: string;
    } | FuzzSuiteContract;
    cases?: FuzzSuiteCaseResult[];
    diagnostics?: FuzzSuiteDiagnostic[];
    artifactRefs?: FuzzSuiteArtifactRef[];
    coverageSummary?: FuzzSuiteCoverageSummary;
    coveragePlan?: FuzzCoveragePlanContract;
    metadata?: Record<string, unknown>;
}): FuzzSuiteResultEnvelope;
export declare function fuzzReplayCaseRef(input: Omit<FuzzReplayCaseRef, "schema" | "kind" | "contentType"> & Partial<Pick<FuzzReplayCaseRef, "kind" | "contentType">>): FuzzReplayCaseRef;
export declare function fuzzMinimizeUnsupportedCapability(input: {
    reason: string;
    requiredArtifacts?: string[];
    metadata?: Record<string, unknown>;
}): FuzzMinimizeCapabilityContract;
export declare function fuzzMinimizeSupportedCapability(input: {
    operation: string;
    requiredArtifacts?: string[];
    metadata?: Record<string, unknown>;
}): FuzzMinimizeCapabilityContract;
export declare function fuzzArtifactBundleContract(input: Omit<FuzzArtifactBundleContract, "schema">): FuzzArtifactBundleContract;
export declare function fuzzSuiteRequiredRunnerCapabilities(suite: FuzzSuiteContract): string[];
export declare function fuzzRunnerCapabilitiesContract(input: FuzzSuiteRunnerCapabilities, required?: FuzzSuiteContract | FuzzRunnerRequiredCapabilities | readonly string[]): FuzzRunnerCapabilitiesContract;
export declare function fuzzRunnerReadinessContract(input: FuzzSuiteRunnerCapabilities, required?: FuzzSuiteContract | FuzzRunnerRequiredCapabilities | readonly string[]): FuzzRunnerReadinessContract;
export declare function unsupportedRequiredFuzzRunnerCapabilities(required: FuzzSuiteContract | FuzzRunnerRequiredCapabilities | readonly string[] | undefined, runnerCapabilities: FuzzSuiteRunnerCapabilities): string[];
export declare function fuzzSuiteCaseResetPolicy(suite: FuzzSuiteContract, fuzzCase: FuzzSuiteCase): FuzzSuiteResetPolicy;
export declare function normalizeFuzzSuiteResetPolicy(input: unknown): FuzzSuiteResetPolicy;
export declare function fuzzSuiteResetPolicyDiagnostics(input: unknown, caseId?: string): FuzzSuiteDiagnostic[];
export declare function summarizeFuzzCases(cases: readonly Pick<FuzzSuiteCaseResult, "status">[]): FuzzSuiteSummary;
export declare function summarizeFuzzCoverage(input: {
    discovered: number;
    cases: readonly Pick<FuzzSuiteCaseResult, "id" | "status" | "skipReason" | "diagnostics">[];
}): FuzzSuiteCoverageSummary;
//# sourceMappingURL=fuzz-suite-contracts.d.ts.map