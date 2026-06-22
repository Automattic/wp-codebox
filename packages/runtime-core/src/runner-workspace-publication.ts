export const RUNNER_WORKSPACE_PUBLICATION_REQUEST_SCHEMA = "wp-codebox/runner-workspace-publication-request/v1" as const
export const RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA = "wp-codebox/runner-workspace-publication-result/v1" as const
export const RUNNER_WORKSPACE_PREPARE_REQUEST_SCHEMA = "wp-codebox/runner-workspace-prepare-request/v1" as const
export const RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA = "wp-codebox/runner-workspace-prepare-result/v1" as const
export const RUNNER_WORKSPACE_CAPTURE_REQUEST_SCHEMA = "wp-codebox/runner-workspace-capture-request/v1" as const
export const RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA = "wp-codebox/runner-workspace-capture-result/v1" as const
export const RUNNER_WORKSPACE_COMMAND_REQUEST_SCHEMA = "wp-codebox/runner-workspace-command-request/v1" as const
export const RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA = "wp-codebox/runner-workspace-command-result/v1" as const
export const RUNNER_WORKSPACE_BACKEND_FILTER = "wp_codebox_runner_workspace_backend" as const

export const RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS = [
  "workspace_adopt",
  "workspace_show",
  "workspace_clone",
  "workspace_worktree_add",
  "workspace_git_status",
  "workspace_git_diff",
  "run_runner_workspace_command",
  "publish_runner_workspace",
] as const

export type RunnerWorkspaceBackendAbilityKey = typeof RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS[number]

export interface RunnerWorkspaceBackendConfig {
  id?: string
  workspace_root_constant?: string
  abilities: Partial<Record<RunnerWorkspaceBackendAbilityKey, string>>
}

export type RunnerWorkspacePublicationRequest = {
  schema?: typeof RUNNER_WORKSPACE_PUBLICATION_REQUEST_SCHEMA
  workspace?: string
  workspace_handle?: string
  workspace_path?: string
  workspace_backend?: string
  runner_workspace?: Record<string, unknown>
  repo?: string
  target_repo?: string
  base?: string
  base_branch?: string
  head?: string
  head_branch?: string
  commit_message: string
  title?: string
  pr_title?: string
  body?: string
  pr_body?: string
  labels?: string[]
  draft?: boolean
  maintainer_can_modify?: boolean
  paths?: string[]
  changed_paths?: string[]
  evidence_context?: Record<string, unknown>
  artifact_context?: Record<string, unknown>
  context?: Record<string, unknown>
}

export type RunnerWorkspacePublicationFailureType =
  | "invalid_request"
  | "publication_unavailable"
  | "backend_error"
  | "backend_invalid_response"
  | "backend_failed"
  | string

export type RunnerWorkspacePublicationResult = {
  schema: typeof RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA
  success: boolean
  status: "published" | "failed" | "write_without_pr"
  failure_type?: RunnerWorkspacePublicationFailureType
  error?: {
    code?: string
    message?: string
    data?: unknown
    [key: string]: unknown
  }
  backend: string
  workspace?: {
    handle?: string
    path?: string
    backend?: string
  }
  branch?: {
    base?: string
    head?: string
    name?: string
    remote?: string
  }
  commit?: {
    sha?: string
    message?: string
  }
  pull_request?: {
    number?: number
    url?: string
    reused: boolean
    opened: boolean
  }
  reused?: boolean
  opened?: boolean
  evidence?: Record<string, unknown>
  artifacts?: Record<string, unknown>
}

export type RunnerWorkspaceIdentity = {
  workspace?: string
  workspace_handle?: string
  handle?: string
  workspace_path?: string
  workspace_backend?: string
  runner_workspace?: Record<string, unknown>
  repo?: string
  target_repo?: string
}

export type RunnerWorkspaceCaptureRequest = RunnerWorkspaceIdentity & {
  schema?: typeof RUNNER_WORKSPACE_CAPTURE_REQUEST_SCHEMA
  from?: string
  to?: string
  path?: string
  include_diff?: boolean
}

export type RunnerWorkspaceCaptureResult = {
  schema: typeof RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA
  success: boolean
  backend: string
  changed?: boolean
  workspace?: Record<string, unknown>
  status?: {
    handle?: string
    name?: string
    repo?: string
    path?: string
    branch?: string
    remote?: string
    commit?: string
    dirty?: number
    files?: string[]
    backend?: string
  }
  diff?: {
    name?: string
    diff?: string
    backend?: string
  }
  failure_type?: string
  error?: Record<string, unknown>
}

export type RunnerWorkspaceCommandRequest = RunnerWorkspaceIdentity & {
  schema?: typeof RUNNER_WORKSPACE_COMMAND_REQUEST_SCHEMA
  command: string
  description?: string
  timeout_seconds?: number
  env?: Record<string, string>
  context?: Record<string, unknown>
}

export type RunnerWorkspaceCommandResult = {
  schema: typeof RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA
  success: boolean
  status: "completed" | "failed" | "unavailable"
  command?: string
  description?: string
  exit_code?: number
  stdout?: string
  stderr?: string
  elapsed_ms?: number
  backend: string
  workspace?: Record<string, unknown>
  failure_type?: string
  error?: Record<string, unknown>
}
