import { type PerformanceObservation, type PerformanceObservationCaptureRequest } from "./performance-observation.js";
import type { RuntimePolicy } from "./runtime-policy.js";
import type { MountSpec, RuntimeCommandDiagnosticsCaptureSpec, RuntimeEpisode, RuntimeEpisodeContentDigest, RuntimeEpisodeStepResult, RuntimeEpisodeTraceRef } from "./runtime-contracts.js";
import { type WordPressCrudOperation } from "./wordpress-crud-contracts.js";
import { type WordPressDbOperation } from "./wordpress-db-contracts.js";
export declare const RUNTIME_ACTION_OBSERVATION_SCHEMA: "wp-codebox/runtime-action-observation/v1";
export declare const SANDBOX_WORKSPACE_ROOT = "/workspace";
export type RuntimeAction = RuntimeWpCliAction | RuntimePhpAction | RuntimeRestRequestAction | RuntimeWordPressCrudOperationAction | RuntimeWordPressDbOperationAction | RuntimeFilesystemAction | RuntimeBrowserAction | RuntimeBrowserRandomWalkAction | RuntimeBrowserProbeAction | RuntimeEditorOpenAction | RuntimeEditorActionsAction | RuntimeEditorValidateBlocksAction | RuntimeAdminPageAction | RuntimePageAction | RuntimeActionSequenceAction | RuntimeWordPressPluginSetupAction | RuntimeWordPressPluginStateAction | RuntimeWordPressThemeSetupAction | RuntimeWordPressHookAction | RuntimeWordPressCronEventAction;
export interface RuntimeWpCliAction {
    type: "wp_cli";
    command: string;
    timeout_ms?: number;
}
export interface RuntimePhpAction {
    type: "php";
    code: string;
    bootstrap?: "wordpress" | "none";
    diagnostics?: RuntimeCommandDiagnosticsCaptureSpec;
    timeout_ms?: number;
}
export interface RuntimeRestRequestAction {
    type: "rest_request";
    method?: string;
    path: string;
    headers?: Record<string, unknown>;
    params?: Record<string, unknown>;
    body?: string;
    body_json?: unknown;
    capture?: PerformanceObservationCaptureRequest;
    enableQueryCapture?: boolean;
    timeout_ms?: number;
}
export interface RuntimeWordPressCrudOperationAction extends Omit<WordPressCrudOperation, "schema"> {
    type: "crud_operation";
    timeout_ms?: number;
}
export interface RuntimeWordPressDbOperationAction extends Omit<WordPressDbOperation, "schema"> {
    type: "db_operation";
    timeout_ms?: number;
}
export interface RuntimeFilesystemAction {
    type: "filesystem";
    operation: "list" | "read" | "write" | "delete";
    path: string;
    content?: string;
}
export interface RuntimeBrowserAction {
    type: "browser";
    operation: "navigate" | "click" | "fill" | "press" | "select" | "wait" | "capture";
    url?: string;
    selector?: string;
    text?: string;
    value?: string;
    key?: string;
    wait_for?: string;
    duration?: string;
    capture?: string[];
    timeout_ms?: number;
}
export interface RuntimeBrowserRandomWalkAction {
    type: "random_walk";
    context?: "browser" | "admin" | "editor";
    seed?: string;
    max_steps?: number;
    maxSteps?: number;
    action_families?: string[];
    actionFamilies?: string[];
    start_url?: string;
    startUrl?: string;
    reset_policy?: Record<string, unknown>;
    resetPolicy?: Record<string, unknown>;
    capture?: string[];
    timeout_ms?: number;
    metadata?: Record<string, unknown>;
}
export interface RuntimeBrowserProbeAction {
    type: "browser_probe";
    url: string;
    wait_for?: string;
    duration?: string;
    capture?: string[];
    viewport?: string;
    timeout_ms?: number;
}
export interface RuntimeEditorOpenAction {
    type: "editor_open";
    target?: "post-new" | "site";
    post_id?: number;
    post_type?: string;
    url?: string;
    wait_selector?: string;
    capture?: string[];
    timeout_ms?: number;
}
export interface RuntimeEditorActionsAction {
    type: "editor_actions";
    steps: Array<Record<string, unknown>>;
    target?: "post-new" | "site" | "front-page";
    post_id?: number;
    post_type?: string;
    url?: string;
    wait_selector?: string;
    wait_timeout_ms?: number;
    step_timeout_ms?: number;
    capture?: string[];
    timeout_ms?: number;
}
export interface RuntimeEditorValidateBlocksAction {
    type: "editor_validate_blocks";
    content?: string;
    content_file?: string;
    target?: "post-new" | "site" | "front-page";
    post_id?: number;
    post_type?: string;
    url?: string;
    validation_provider?: string;
    wait_selector?: string;
    timeout_ms?: number;
}
export interface RuntimeAdminPageAction {
    type: "admin_page";
    path: string;
    wait_for?: string;
    capture?: string[];
    timeout_ms?: number;
}
export interface RuntimePageAction {
    type: "page";
    path: string;
    wait_for?: string;
    capture?: string[];
    timeout_ms?: number;
}
export interface RuntimeActionSequenceAction {
    type: "sequence";
    seed?: string;
    max_steps?: number;
    maxSteps?: number;
    action_families?: string[];
    actionFamilies?: string[];
    reset_policy?: Record<string, unknown>;
    resetPolicy?: Record<string, unknown>;
    steps: RuntimeAction[];
    replay?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    timeout_ms?: number;
}
export interface RuntimeWordPressPluginSetupAction {
    type: "wordpress_plugin_setup";
    action?: "install" | "list";
    plugin?: string;
    slug?: string;
    activate?: boolean;
    network?: boolean;
    timeout_ms?: number;
}
export interface RuntimeWordPressPluginStateAction {
    type: "wordpress_plugin_state";
    action?: "report" | "status" | "activate" | "deactivate";
    plugin?: string;
    slug?: string;
    file?: string;
    path?: string;
    network?: boolean;
    timeout_ms?: number;
}
export interface RuntimeWordPressThemeSetupAction {
    type: "wordpress_theme_setup";
    action?: "install" | "switch" | "list";
    theme?: string;
    slug?: string;
    activate?: boolean;
    timeout_ms?: number;
}
export interface RuntimeWordPressHookAction {
    type: "wordpress_hook";
    hook: string;
    args?: unknown[];
    mutates?: boolean;
    capability?: string;
    destructive_boundary?: string;
    timeout_ms?: number;
}
export interface RuntimeWordPressCronEventAction {
    type: "wordpress_cron_event";
    hook: string;
    operation?: "run-hook" | "schedule-single";
    args?: unknown[];
    timestamp?: number;
    mutates?: boolean;
    capability?: string;
    destructive_boundary?: string;
    timeout_ms?: number;
}
export interface RuntimeActionAdapterPolicy {
    mounts?: MountSpec[];
    writableRoots?: string[];
    filesystem?: RuntimePolicy["filesystem"];
    filesystemTraceCommand?: string | false;
}
export interface RuntimeActionObservation {
    schema: typeof RUNTIME_ACTION_OBSERVATION_SCHEMA;
    type: RuntimeAction["type"];
    status: "ok";
    action: RuntimeAction;
    data: Record<string, unknown>;
    observedAt: string;
    step?: RuntimeEpisodeStepResult;
    performance?: PerformanceObservation;
    artifactRefs?: RuntimeEpisodeTraceRef[];
    digest: RuntimeEpisodeContentDigest;
}
export declare class RuntimeActionPolicyError extends Error {
    readonly action: RuntimeAction;
    readonly code: "runtime-action-policy-violation";
    constructor(message: string, action: RuntimeAction);
}
export declare class RuntimeActionExecutionError extends Error {
    readonly artifactRefs: RuntimeEpisodeTraceRef[];
    constructor(message: string, artifactRefs: RuntimeEpisodeTraceRef[]);
}
export declare function runRuntimeAction(episode: RuntimeEpisode, action: RuntimeAction, policy?: RuntimeActionAdapterPolicy): Promise<RuntimeActionObservation>;
//# sourceMappingURL=runtime-action-adapter.d.ts.map