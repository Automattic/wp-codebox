import type { TransportFaultModel } from "./transport-faults.js";
export declare const ADVERSARIAL_CAMPAIGN_SCHEMA: "wp-codebox/adversarial-campaign/v1";
export declare const ADVERSARIAL_CAMPAIGN_RESULT_SCHEMA: "wp-codebox/adversarial-campaign-result/v1";
export declare const ADVERSARIAL_FINDING_SCHEMA: "wp-codebox/adversarial-finding/v1";
export declare const ADVERSARIAL_REPLAY_SCHEMA: "wp-codebox/adversarial-replay/v1";
export declare const ADVERSARIAL_ORACLE_SCHEMA: "wp-codebox/adversarial-oracle/v1";
export declare const DIFFERENTIAL_RESULT_SCHEMA: "wp-codebox/differential-result/v1";
export type AdversarialMutationKind = "scalar" | "structured" | "binary" | "sequence";
export type AdversarialCaseStatus = "passed" | "failed" | "error" | "timed-out" | "resource-exhausted";
export type AdversarialClockSurface = "runtime" | "wordpress" | "scheduler" | "database";
export type AdversarialClockOperation = "freeze" | "advance" | "skew" | "restore";
/** A portable, normalized clock instruction. Runtime adapters negotiate its fidelity. */
export interface AdversarialClockScheduleEntry {
    surface: AdversarialClockSurface;
    operation: AdversarialClockOperation;
    time?: number;
    milliseconds?: number;
}
export interface AdversarialAction {
    type: string;
    input?: unknown;
    /** Transitions applied immediately before this action's first declared phase. */
    clock?: AdversarialClockScheduleEntry[];
    metadata?: Record<string, unknown>;
}
export interface AdversarialCorpusEntry {
    id: string;
    actions: AdversarialAction[];
    input?: unknown;
    signals?: string[];
    metadata?: Record<string, unknown>;
}
export interface AdversarialResourceBudget {
    maxCases: number;
    maxActionsPerCase: number;
    maxInputBytes: number;
    maxCaseTimeMs: number;
    maxWallTimeMs: number;
    maxArtifactBytes: number;
    workers: number;
}
export interface AdversarialMatrixDimension {
    name: string;
    values: string[];
}
export interface AdversarialOracleContract {
    schema: typeof ADVERSARIAL_ORACLE_SCHEMA;
    id: string;
    severity: "low" | "medium" | "high" | "critical";
    description?: string;
    metadata?: Record<string, unknown>;
}
export interface AdversarialCampaign {
    schema: typeof ADVERSARIAL_CAMPAIGN_SCHEMA;
    id: string;
    seed: string;
    corpus: AdversarialCorpusEntry[];
    mutationKinds: AdversarialMutationKind[];
    budgets: AdversarialResourceBudget;
    oracles: AdversarialOracleContract[];
    matrix?: AdversarialMatrixDimension[];
    faults?: TransportFaultModel;
    provenance?: Record<string, unknown>;
    replayCommand?: string;
    metadata?: Record<string, unknown>;
}
export interface AdversarialCasePlan extends AdversarialCorpusEntry {
    caseId: string;
    corpusId: string;
    iteration: number;
    workerId: number;
    matrix: Record<string, string>;
    mutation: {
        kind: AdversarialMutationKind;
        path: string;
        description: string;
    };
}
export interface AdversarialExecutionObservation {
    status: AdversarialCaseStatus;
    signals?: string[];
    diagnostics?: Array<{
        code: string;
        message: string;
        severity?: string;
        metadata?: Record<string, unknown>;
    }>;
    artifacts?: Array<{
        path: string;
        kind: string;
        bytes?: number;
        sha256?: string;
    }>;
    stateDigest?: string;
    metrics?: {
        durationMs?: number;
        memoryBytes?: number;
        cpuMs?: number;
        [name: string]: number | undefined;
    };
    metadata?: Record<string, unknown>;
}
export interface AdversarialOracleResult {
    oracleId: string;
    failed: boolean;
    code?: string;
    message?: string;
    evidence?: Record<string, unknown>;
}
export interface AdversarialFinding {
    schema: typeof ADVERSARIAL_FINDING_SCHEMA;
    fingerprint: string;
    caseId: string;
    corpusId: string;
    oracleIds: string[];
    status: AdversarialCaseStatus;
    minimized: AdversarialCorpusEntry;
    original: AdversarialCorpusEntry;
    replay: AdversarialReplay;
    diagnostics: AdversarialExecutionObservation["diagnostics"];
    artifactRefs: NonNullable<AdversarialExecutionObservation["artifacts"]>;
    secretScan: {
        status: "passed" | "redacted";
        redactions: number;
    };
    duplicates: number;
    matrix: Record<string, string>;
}
export interface AdversarialReplay {
    schema: typeof ADVERSARIAL_REPLAY_SCHEMA;
    campaignId: string;
    seed: string;
    caseId: string;
    corpusId: string;
    workerId: number;
    iteration: number;
    matrix: Record<string, string>;
    actions: AdversarialAction[];
    input?: unknown;
    faultSchedule?: TransportFaultModel;
    schedule: AdversarialScheduleEntry[];
    provenance?: Record<string, unknown>;
    command: string;
    expectedFingerprint?: string;
    expectedStateDigest?: string;
}
export interface AdversarialScheduleEntry {
    round: number;
    workerId: number;
    caseId: string;
    corpusId: string;
    iteration: number;
}
export interface AdversarialCampaignResult {
    schema: typeof ADVERSARIAL_CAMPAIGN_RESULT_SCHEMA;
    campaignId: string;
    seed: string;
    status: "passed" | "findings" | "incomplete";
    summary: {
        generated: number;
        executed: number;
        retained: number;
        findings: number;
        duplicates: number;
        timedOut: number;
    };
    corpus: AdversarialCorpusEntry[];
    findings: AdversarialFinding[];
    schedule: AdversarialScheduleEntry[];
    noveltySignals: string[];
    diagnostics: Array<{
        code: string;
        message: string;
    }>;
    resourceUsage: {
        wallTimeMs: number;
        artifactBytes: number;
    };
}
export interface AdversarialCampaignRunnerOptions {
    execute(plan: AdversarialCasePlan, signal: AbortSignal): Promise<AdversarialExecutionObservation>;
    evaluate?(plan: AdversarialCasePlan, observation: AdversarialExecutionObservation, oracles: readonly AdversarialOracleContract[]): Promise<AdversarialOracleResult[]> | AdversarialOracleResult[];
    now?: () => number;
    replayCommand?: (campaign: AdversarialCampaign, plan: AdversarialCasePlan, fingerprint: string) => string;
    signal?: AbortSignal;
    retainNovelty?: boolean;
    minimize?: boolean;
    /** Grace to wait for a cancelled case before terminalizing the campaign. */
    abortSettleGraceMs?: number;
}
export interface DifferentialCell {
    id: string;
    role?: "base" | "candidate";
    runtime?: Record<string, string>;
    fingerprint?: string;
    status: AdversarialCaseStatus | "missing";
}
export interface DifferentialResult {
    schema: typeof DIFFERENTIAL_RESULT_SCHEMA;
    classification: "candidate-regression" | "pre-existing" | "platform-difference" | "nondeterminism" | "equivalent";
    cells: DifferentialCell[];
    fingerprints: string[];
}
export declare function adversarialCampaign(input: Omit<AdversarialCampaign, "schema" | "budgets" | "mutationKinds" | "oracles"> & {
    budgets?: Partial<AdversarialResourceBudget>;
    mutationKinds?: AdversarialMutationKind[];
    oracles?: AdversarialOracleContract[];
}): AdversarialCampaign;
export declare function runAdversarialCampaign(campaignInput: AdversarialCampaign, options: AdversarialCampaignRunnerOptions): Promise<AdversarialCampaignResult>;
export declare function mutateAdversarialValue(value: unknown, kind: AdversarialMutationKind, seed: string): {
    value: unknown;
    path: string;
    description: string;
};
export declare function adversarialFindingFingerprint(value: unknown): string;
export declare function classifyDifferentialResult(cells: DifferentialCell[]): DifferentialResult;
export declare function normalizeAdversarialClockSchedule(entries: readonly AdversarialClockScheduleEntry[]): AdversarialClockScheduleEntry[];
//# sourceMappingURL=adversarial-campaign.d.ts.map