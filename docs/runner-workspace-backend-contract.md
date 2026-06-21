# Runner Workspace Backend Contract

`wp-codebox/runner-workspace-backend/v1` is the integration-owned backend
configuration shape consumed by the `wp_codebox_runner_workspace_backend` filter.
It is not a consumer API. External callers use WP Codebox runner workspace
abilities and result schemas; backend operation names stay behind the adapter.

```json
{
  "schema": "wp-codebox/runner-workspace-backend/v1",
  "version": 1,
  "id": "example-backend",
  "workspace_root_constant": "EXAMPLE_WORKSPACE_ROOT",
  "abilities": {
    "workspace_adopt": "example-workspace/adopt",
    "workspace_show": "example-workspace/show",
    "workspace_clone": "example-workspace/clone",
    "workspace_worktree_add": "example-workspace/worktree-add",
    "workspace_git_status": "example-workspace/git-status",
    "workspace_git_diff": "example-workspace/git-diff",
    "run_runner_workspace_command": "example-workspace/run-command",
    "publish_runner_workspace": "example-workspace/publish"
  }
}
```

The stable backend operation keys are:

- `workspace_adopt`
- `workspace_show`
- `workspace_clone`
- `workspace_worktree_add`
- `workspace_git_status`
- `workspace_git_diff`
- `run_runner_workspace_command`
- `publish_runner_workspace`

Validation is intentionally generic. `schema` and `version` are optional for
existing integrations, but when present they must match this contract. `id` is an
opaque backend slug for diagnostics. `abilities` values must be private
WordPress ability names in `namespace/name` form. Those names are adapter inputs,
not documented consumer-facing operation ids.

The public WP Codebox operation ids remain:

- `wp-codebox/runner-workspace-prepare`
- `wp-codebox/runner-workspace-capture`
- `wp-codebox/runner-workspace-command`
- `wp-codebox/runner-workspace-publish`

Backend errors returned through public WP Codebox abilities are sanitized before
they reach callers. Raw backend names, ability fields, and backend-specific
failure slugs must not become part of public result contracts.
