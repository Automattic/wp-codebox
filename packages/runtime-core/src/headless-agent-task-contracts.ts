import { AGENT_TASK_RUN_RESULT_SCHEMA, type AgentTaskRunResultSummary } from "./agent-task-run-result.js"
import { RUNTIME_PROFILE_SCHEMA, normalizeRuntimeAccess, normalizeRuntimeProfile, type RuntimeAccess, type RuntimeProfile } from "./runtime-boundary-contracts.js"
import { TASK_INPUT_JSON_SCHEMA, normalizeTaskInput, type TaskInput, type TaskInputRequest } from "./task-input.js"
import { isPlainObject, objectValue, stringList, stringValue, stripUndefined } from "./object-utils.js"
import { WORKSPACE_DELTA_JSON_SCHEMA, workspaceDeltaFromAgentTaskRunResult, type WorkspaceDelta } from "./workspace-delta.js"

export const HEADLESS_AGENT_TASK_REQUEST_SCHEMA = "wp-codebox/headless-agent-task-request/v1" as const
export const HEADLESS_AGENT_TASK_RESULT_SCHEMA = "wp-codebox/headless-agent-task-result/v1" as const

export interface HeadlessAgentTaskWorkspaceArtifactPolicy {
  capture?: string[]
  publish?: "never" | "reviewed" | "always" | (string & {})
  retention?: "ephemeral" | "durable" | (string & {})
  public_url_root?: string
  metadata?: Record<string, unknown>
}

export interface HeadlessAgentTaskRequest {
  schema: typeof HEADLESS_AGENT_TASK_REQUEST_SCHEMA
  task_input: TaskInput
  runtime_profile: RuntimeProfile
  workspace_artifact_policy: HeadlessAgentTaskWorkspaceArtifactPolicy
  sandbox_session_id?: string
  orchestrator?: Record<string, unknown>
  preview?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface HeadlessAgentTaskResult {
  schema: typeof HEADLESS_AGENT_TASK_RESULT_SCHEMA
  success: boolean
  status: AgentTaskRunResultSummary["status"]
  summary: string
  preview?: RuntimeAccess
  refs: AgentTaskRunResultSummary["refs"]
  artifacts: AgentTaskRunResultSummary["artifacts"]
  evidence_refs: AgentTaskRunResultSummary["refs"]["evidence_bundles"]
  workspace_delta: WorkspaceDelta
  diagnostics: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
  agent_task_run_result: AgentTaskRunResultSummary
}

export const HEADLESS_AGENT_TASK_REQUEST_JSON_SCHEMA = {
  $id: HEADLESS_AGENT_TASK_REQUEST_SCHEMA,
  type: "object",
  required: ["schema", "task_input", "runtime_profile", "workspace_artifact_policy"],
  additionalProperties: false,
  properties: {
    schema: { type: "string", const: HEADLESS_AGENT_TASK_REQUEST_SCHEMA },
    task_input: TASK_INPUT_JSON_SCHEMA,
    runtime_profile: { type: "object", description: `Portable ${RUNTIME_PROFILE_SCHEMA} descriptor for runtime dependencies, capabilities, and provider selection.` },
    workspace_artifact_policy: {
      type: "object",
      description: "Caller policy for artifact capture, publication handoff, retention, and public artifact URL roots. WP Codebox returns refs; callers own publication decisions.",
      properties: {
        capture: { type: "array", items: { type: "string" } },
        publish: { type: "string" },
        retention: { type: "string" },
        public_url_root: { type: "string" },
        metadata: { type: "object" },
      },
    },
    sandbox_session_id: { type: "string" },
    orchestrator: { type: "object" },
    preview: { type: "object" },
    metadata: { type: "object" },
  },
} as const

export const HEADLESS_AGENT_TASK_RESULT_JSON_SCHEMA = {
  $id: HEADLESS_AGENT_TASK_RESULT_SCHEMA,
  type: "object",
  required: ["schema", "success", "status", "summary", "refs", "artifacts", "evidence_refs", "workspace_delta", "diagnostics", "metadata", "agent_task_run_result"],
  additionalProperties: false,
  properties: {
    schema: { type: "string", const: HEADLESS_AGENT_TASK_RESULT_SCHEMA },
    success: { type: "boolean" },
    status: { type: "string" },
    summary: { type: "string" },
    preview: { type: "object" },
    refs: { type: "object" },
    artifacts: { type: "array", items: { type: "object" } },
    evidence_refs: { type: "array", items: { type: "object" } },
    workspace_delta: WORKSPACE_DELTA_JSON_SCHEMA,
    diagnostics: { type: "array", items: { type: "object" } },
    metadata: { type: "object" },
    agent_task_run_result: { type: "object", properties: { schema: { type: "string", const: AGENT_TASK_RUN_RESULT_SCHEMA } } },
  },
} as const

export function normalizeHeadlessAgentTaskRequest(input: unknown): HeadlessAgentTaskRequest {
  const record = objectValue(input)
  const taskInput = objectValue(record.task_input)
  if (record.schema !== HEADLESS_AGENT_TASK_REQUEST_SCHEMA) {
    throw new Error(`schema must be ${HEADLESS_AGENT_TASK_REQUEST_SCHEMA}.`)
  }
  if (!Object.keys(taskInput).length) {
    throw new Error("task_input is required.")
  }

  return stripUndefined({
    schema: HEADLESS_AGENT_TASK_REQUEST_SCHEMA,
    task_input: normalizeTaskInput(taskInput as TaskInputRequest),
    runtime_profile: normalizeRuntimeProfile({ schema: RUNTIME_PROFILE_SCHEMA, ...objectValue(record.runtime_profile ?? record.runtimeProfile) }),
    workspace_artifact_policy: normalizeWorkspaceArtifactPolicy(record.workspace_artifact_policy ?? record.workspaceArtifactPolicy),
    sandbox_session_id: stringValue(record.sandbox_session_id ?? record.sandboxSessionId) || undefined,
    orchestrator: isPlainObject(record.orchestrator) ? record.orchestrator : undefined,
    preview: isPlainObject(record.preview) ? record.preview : undefined,
    metadata: isPlainObject(record.metadata) ? record.metadata : undefined,
  }) as HeadlessAgentTaskRequest
}

export function headlessAgentTaskRequestToRunInput(request: HeadlessAgentTaskRequest): TaskInputRequest & Record<string, unknown> {
  return stripUndefined({
    ...request.task_input,
    runtime_profile: request.runtime_profile,
    workspace_artifact_policy: request.workspace_artifact_policy,
    sandbox_session_id: request.sandbox_session_id,
    orchestrator: request.orchestrator,
    preview: request.preview,
    parent_request: {
      schema: request.schema,
      metadata: request.metadata,
    },
  })
}

export function normalizeHeadlessAgentTaskResult(result: AgentTaskRunResultSummary, metadata: Record<string, unknown> = {}): HeadlessAgentTaskResult {
  const workspaceDelta = workspaceDeltaFromAgentTaskRunResult(result)
  return {
    schema: HEADLESS_AGENT_TASK_RESULT_SCHEMA,
    success: result.success,
    status: result.status,
    summary: result.summary,
    preview: result.runtime_access ? normalizeRuntimeAccess(result.runtime_access) : undefined,
    refs: result.refs,
    artifacts: result.artifacts,
    evidence_refs: result.refs.evidence_bundles,
    workspace_delta: workspaceDelta,
    diagnostics: result.diagnostics.concat(workspaceDelta.diagnostics),
    metadata: stripUndefined({ ...metadata, ...result.metadata }),
    agent_task_run_result: result,
  }
}

function normalizeWorkspaceArtifactPolicy(value: unknown): HeadlessAgentTaskWorkspaceArtifactPolicy {
  const record = objectValue(value)
  return stripUndefined({
    capture: stringList(record.capture),
    publish: stringValue(record.publish) || undefined,
    retention: stringValue(record.retention) || undefined,
    public_url_root: stringValue(record.public_url_root ?? record.publicUrlRoot) || undefined,
    metadata: isPlainObject(record.metadata) ? record.metadata : undefined,
  })
}
