export type RunnerWorkspacePublicationRequest = {
  schema?: "wp-codebox/runner-workspace-publication-request/v1"
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
  schema: "wp-codebox/runner-workspace-publication-result/v1"
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
