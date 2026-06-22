# Docs Agent Reusable Workflow

WP Codebox publishes a reusable GitHub Actions workflow for Docs Agent runs:

```yaml
jobs:
  update-docs:
    uses: Automattic/wp-codebox/.github/workflows/docs-agent-runner.yml@main
    with:
      recipe_path: .github/docs-agent-recipe.json
      prompt: ${{ inputs.prompt }}
    secrets: inherit
```

Consumers provide a recipe that describes the Docs Agent bundle, target
repository, runtime policy, verification commands, artifact expectations, and
output projection. The workflow accepts Codebox recipe fields and returns stable
run outputs; implementation-specific runtime wiring, workspace adapters,
plugins, and model setup stay behind the WP Codebox boundary.

## Recipe Schema

The recipe schema id is `wp-codebox/docs-agent-runner-recipe/v1`.

```json
{
  "schema": "wp-codebox/docs-agent-runner-recipe/v1",
  "targetRepository": "Automattic/agents-api",
  "prompt": "Refresh the API docs for the changed files.",
  "docsAgent": {
    "repository": "https://github.com/Automattic/docs-agent.git",
    "ref": "main",
    "bundlePath": "bundles/docs-agent"
  },
  "runner": {
    "verificationCommands": [
      { "command": "npm test", "description": "Run docs checks" }
    ]
  },
  "policy": {
    "successRequiresPr": false,
    "requireAppToken": true,
    "allowedRepositories": ["Automattic/agents-api", "Automattic/docs-agent"]
  },
  "engine": {
    "key": "docs_agent",
    "outputMappings": {
      "docs_pr_url": "metadata.engine_data.docs_agent.pr_url"
    }
  },
  "artifacts": {
    "transcriptName": "docs-agent-transcript"
  }
}
```

`recipe_json` may be used instead of `recipe_path` when a caller wants to build
the recipe in a previous workflow step.

## Inputs

- `recipe_path`: repository-relative path to a recipe JSON file.
- `recipe_json`: inline recipe JSON used when `recipe_path` is empty.
- `prompt`: optional prompt override for the run.
- `target_repo`: optional `OWNER/REPO` target override.
- `run_agent`: set to `false` to record a skipped run.
- `provider` and `model`: model selection for the recipe owner.
- `wp_codebox_ref`: WP Codebox ref used for the runtime boundary.
- `wordpress_version`: WordPress version used by the contained runtime.
- `dry_run`: validates the runner request without a live agent call.

## Outputs

- `job_status`: normalized terminal status.
- `transcript_json`: transcript artifact path when available.
- `transcript_summary`: short transcript label when available.
- `engine_data_json`: projected recipe outputs as one JSON object.
- `credential_mode`: credential source selected for the run.

The workflow is intentionally recipe-first. Consumers should model new behavior
as fields in `wp-codebox/docs-agent-runner-recipe/v1` instead of depending on
worker filesystem paths, runtime internals, package internals, or the private
workflow that executes the recipe.
