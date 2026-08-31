import type { JsonValue } from "./host-tool-registry.js";
export declare const BROWSER_INTERACTION_SCRIPT_SCHEMA: "wp-codebox/browser-interaction-script/v1";
export declare const BROWSER_TOOL_VERIFIER_RESULT_SCHEMA: "wp-codebox/browser-tool-verifier-result/v1";
/**
 * Backend-agnostic browser interaction step contract (issue #310).
 *
 * runtime-core declares the schema; a runtime backend (e.g. runtime-playground)
 * implements the executor that maps each step onto its driver. Steps are a thin,
 * stable mapping over locator-style actions — not a test-runner DSL.
 *
 * Layer purity: this type knows nothing about Playwright or Playground. It is the
 * shared contract any backend can satisfy.
 */
export declare const BROWSER_INTERACTION_STEP_KINDS: readonly ["navigate", "click", "fill", "type", "press", "drag", "hover", "select", "waitFor", "evaluate", "expect", "assertObservation", "screenshot", "capture", "callTool"];
export type BrowserInteractionStepKind = typeof BROWSER_INTERACTION_STEP_KINDS[number];
export declare const BROWSER_RANDOM_WALK_SCHEMA: "wp-codebox/browser-random-walk/v1";
export declare const BROWSER_ACTION_CORPUS_SCHEMA: "wp-codebox/browser-action-corpus/v1";
export declare const BROWSER_ACTION_CORPUS_ARTIFACT_SCHEMA: "wp-codebox/browser-action-corpus-artifact/v1";
export declare const BROWSER_RANDOM_WALK_CONTEXTS: readonly ["browser", "admin", "editor"];
export type BrowserRandomWalkContext = typeof BROWSER_RANDOM_WALK_CONTEXTS[number];
export declare const BROWSER_RANDOM_WALK_ACTION_FAMILIES: readonly ["click", "fill", "press", "select", "navigate", "capture"];
export type BrowserRandomWalkActionFamily = typeof BROWSER_RANDOM_WALK_ACTION_FAMILIES[number];
/** Locator/element state checked by an `expect` step. */
export declare const BROWSER_INTERACTION_EXPECT_STATES: readonly ["visible", "hidden", "attached", "detached", "enabled", "disabled", "checked", "unchecked", "editable"];
export type BrowserInteractionExpectState = typeof BROWSER_INTERACTION_EXPECT_STATES[number];
/** Drop target for a `drag` step: an element selector or absolute viewport coordinates. */
export type BrowserInteractionDragTarget = {
    selector: string;
} | {
    x: number;
    y: number;
};
export interface BrowserInteractionStep {
    kind: BrowserInteractionStepKind;
    /** Stable locator string (CSS, `text=`, `role=button[name='...']`, etc.). */
    selector?: string;
    /** Navigation target for `navigate`. */
    url?: string;
    /** Visible-text locator shortcut for `click`/`hover`. */
    text?: string;
    /** Input value for `fill`/`type`, or option value for `select`. */
    value?: string;
    /** Keyboard key for `press`. */
    key?: string;
    /** Wait/load condition: domcontentloaded|load|networkidle|selector:<sel>|duration|painted|frame-painted:<iframe-selector>|frame-url-painted:<url-fragment>. */
    waitFor?: string;
    /** Drag source selector for `drag`. */
    from?: string;
    /** Drag drop target for `drag`. */
    to?: BrowserInteractionDragTarget;
    /** Option label/value(s) for `select`. */
    values?: string[];
    /** Arbitrary page JS for `evaluate` (policy-gated separately). */
    expression?: string;
    /** Optional expected value an `evaluate` result must deep-equal to assert. */
    assert?: unknown;
    /** Observation assertion for captured browser runtime evidence. */
    assertion?: string;
    /** Expected locator state for `expect`. */
    state?: BrowserInteractionExpectState;
    /** Optional screenshot name for `screenshot`; screenshot steps may also use waitFor for painted-readiness waits before capture. */
    name?: string;
    /** Optional iframe selector for `screenshot`; captures the iframe document instead of the top page. */
    frameSelector?: string;
    /** Optional iframe URL fragment for `screenshot`; captures the matching iframe document instead of the top page. */
    frameUrl?: string;
    /** Optional wait duration (e.g. 500ms, 2s) for `waitFor`/`navigate`. */
    duration?: string;
    /** Per-step timeout override (e.g. 5s). */
    timeout?: string;
    /** Caller-provided host tool command name for `callTool`. */
    tool?: string;
    /** JSON input passed to the caller-provided host tool. */
    input?: JsonValue;
}
export interface BrowserToolVerifierInputSummary {
    type: "null" | "boolean" | "number" | "string" | "array" | "object";
    keys?: string[];
    itemCount?: number;
}
export interface BrowserToolVerifierResult {
    schema: typeof BROWSER_TOOL_VERIFIER_RESULT_SCHEMA;
    status: "unsupported" | "ok" | "error";
    step: {
        index: number;
        kind: "callTool";
        tool: string;
    };
    tool: string;
    inputSummary: BrowserToolVerifierInputSummary;
    result?: JsonValue;
    error?: {
        code: string;
        message: string;
    };
    evidence: {
        redaction: {
            policy: "required";
            sensitive: true;
            reason: string;
        };
        rawInputSerialized: false;
        rawSecretsSerialized: false;
    };
    startedAt: string;
    finishedAt: string;
}
export interface BrowserRandomWalkContract {
    schema: typeof BROWSER_RANDOM_WALK_SCHEMA;
    context: BrowserRandomWalkContext;
    seed: string;
    maxSteps: number;
    actionFamilies: BrowserRandomWalkActionFamily[];
    startUrl?: string;
    resetPolicy?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface BrowserRandomWalkPlan {
    schema: typeof BROWSER_RANDOM_WALK_SCHEMA;
    status: "planned" | "unsupported";
    context: BrowserRandomWalkContext;
    seed: string;
    maxSteps: number;
    actionFamilies: BrowserRandomWalkActionFamily[];
    steps: BrowserInteractionStep[];
    replay: Record<string, unknown>;
    diagnostics: {
        code: string;
        message: string;
        metadata?: Record<string, unknown>;
    }[];
}
export declare const BROWSER_ACTION_CORPUS_GENERATOR_KINDS: readonly ["text", "email", "url", "search", "number", "password", "textarea", "checkbox", "radio", "select"];
export type BrowserActionCorpusGeneratorKind = typeof BROWSER_ACTION_CORPUS_GENERATOR_KINDS[number];
export type BrowserActionCorpusDescriptorKind = "link" | "button" | "input" | "textarea" | "select";
export interface BrowserActionCorpusDescriptor {
    id: string;
    kind: BrowserActionCorpusDescriptorKind;
    selector: string;
    label?: string;
    name?: string;
    role?: string;
    type?: string;
    formId?: string;
    href?: string;
    optionValues?: string[];
    disabled?: boolean;
    readonly?: boolean;
    /** Adaptive exploration frame identity. Omitted for the main document and one-shot corpus discovery. */
    frameId?: string;
}
export interface BrowserActionCorpusContract {
    schema: typeof BROWSER_ACTION_CORPUS_SCHEMA;
    context: BrowserRandomWalkContext;
    seed: string;
    maxSteps: number;
    startUrl?: string;
    includeFamilies: BrowserRandomWalkActionFamily[];
    generatorPrefix: string;
    metadata?: Record<string, unknown>;
}
export interface BrowserActionCorpusPlan {
    schema: typeof BROWSER_ACTION_CORPUS_SCHEMA;
    status: "planned" | "empty";
    context: BrowserRandomWalkContext;
    seed: string;
    maxSteps: number;
    startUrl?: string;
    descriptors: BrowserActionCorpusDescriptor[];
    steps: BrowserInteractionStep[];
    replay: {
        schema: typeof BROWSER_ACTION_CORPUS_SCHEMA;
        seed: string;
        maxSteps: number;
        context: BrowserRandomWalkContext;
        startUrl?: string;
        descriptorIds: string[];
        steps: BrowserInteractionStep[];
    };
    observations: {
        descriptorsDiscovered: number;
        descriptorsSelected: number;
        stepsPlanned: number;
        fillSteps: number;
        clickSteps: number;
        selectSteps: number;
    };
    diagnostics: {
        code: string;
        message: string;
        metadata?: Record<string, unknown>;
    }[];
}
export interface BrowserActionCorpusArtifact {
    schema: typeof BROWSER_ACTION_CORPUS_ARTIFACT_SCHEMA;
    contract: BrowserActionCorpusContract;
    plan: BrowserActionCorpusPlan;
    capturedAt: string;
}
export interface BrowserInteractionStepValidationIssue {
    index: number;
    message: string;
}
export interface BrowserInteractionScriptValidationResult {
    valid: boolean;
    steps: BrowserInteractionStep[];
    issues: BrowserInteractionStepValidationIssue[];
}
export declare function browserToolVerifierInputSummary(input: JsonValue): BrowserToolVerifierInputSummary;
/**
 * Validate an ordered browser interaction script against the backend-agnostic
 * step contract. Returns normalized steps plus per-index issues; backends call
 * this before executing so every backend enforces the same contract.
 */
export declare function validateBrowserInteractionScript(input: unknown): BrowserInteractionScriptValidationResult;
/** True when an interaction script contains at least one policy-gated evaluate step. */
export declare function browserInteractionScriptUsesEvaluate(steps: readonly BrowserInteractionStep[]): boolean;
/** Exact caller-provided tool command names referenced by `callTool` steps. */
export declare function browserInteractionScriptToolCalls(steps: readonly BrowserInteractionStep[]): string[];
export declare function browserRandomWalkContract(input: Record<string, unknown>): BrowserRandomWalkContract;
export declare function planBrowserRandomWalk(input: Record<string, unknown>): BrowserRandomWalkPlan;
export declare function browserActionCorpusContract(input: Record<string, unknown>): BrowserActionCorpusContract;
export declare function planBrowserActionCorpus(contractInput: Record<string, unknown> | BrowserActionCorpusContract, descriptorsInput: readonly BrowserActionCorpusDescriptor[]): BrowserActionCorpusPlan;
export declare function browserActionCorpusArtifact(contractInput: Record<string, unknown> | BrowserActionCorpusContract, descriptors: readonly BrowserActionCorpusDescriptor[], capturedAt: string): BrowserActionCorpusArtifact;
//# sourceMappingURL=browser-interaction.d.ts.map