# Public API Contract

WP Codebox has two kinds of API surface: stable public entrypoints for host
integrations, and monorepo internals for implementation reuse. This document is
the maintained contract map for package consumers.

## Stable Entry Points

Use these package entrypoints from external integrations:

- `@automattic/wp-codebox-core`: runtime, task/package, runner workspace, tool
  bridge, browser task/contained-site, artifact metadata, recipe, policy, and
  provider contract types and helpers.
- `@automattic/wp-codebox-core/contracts`: command catalog and inspectable
  contract metadata used by CLI and orchestrator consumers.
- `@automattic/wp-codebox-core/artifacts`: artifact verification, apply adapter,
  export-link, diagnostics, and partial-discovery helpers.
- `@automattic/wp-codebox-core/recipe-builders`: typed recipe construction
  helpers.
- `@automattic/wp-codebox-core/agent-task-recipe`: agent-task recipe assembly
  helpers.
- `@automattic/wp-codebox-core/runtime-presets`: runtime preset registry helpers.
- `@automattic/wp-codebox-playground`: the current WordPress Playground runtime
  backend factory and backend-owned helper types.
- `@automattic/wp-codebox-cli`: the executable CLI surface for schema, command,
  recipe, runtime, and artifact operations.
- `@automattic/wp-codebox-cli/recipe-secret-env`: recipe secret environment
  resolution helpers for CLI consumers that need dry-run summaries or runtime
  environment injection outside the command entrypoint.

The workspace package mirrors the core entrypoints as `./core`,
`./core/contracts`, `./core/artifacts`, `./recipe-builders`,
`./agent-task-recipe`, `./runtime-presets`, and `./cli/recipe-secret-env` for
local consumers in this repo.

## Contract Areas

The stable public surface is grouped by lifecycle area rather than by product:

- **Runtime task/package:** task input, agent task recipe, recipe source package,
  runtime workload, runtime policy, provider runtime, and command result
  contracts.
- **Runner workspace:** workspace policy, preload artifact, source-root
  preparation, mount primitive, and runner workspace publication contracts.
- **Tool bridge:** host tool registry, managed host command, host command
  executor, sandbox tool policy, and tool-call artifact contracts.
- **Browser task and contained site:** browser interaction, callback, probe,
  review bridge, session origin, artifact lifecycle, result shape, and runtime
  boundary contracts.
- **Artifacts:** manifest, paths, capture policy, layout, references, review,
  diagnostics, test result, export link, storage, result envelope, evidence
  envelope, and materialization contracts.
- **Inspect:** command registry metadata, JSON Schema factories, CLI `schema` and
  `commands` output, and recipe validation descriptors.

When adding a new public type or helper, place it in the focused owner module and
export it through the narrowest stable entrypoint that matches its lifecycle
area. Avoid adding implementation helpers to a public barrel only because they
are convenient for one in-repo caller.

## Internal Entry Point

`@automattic/wp-codebox-core/internals` exists for this monorepo's package split
and may be used by tests, the CLI, and backend packages in this repository. It is
not a stable compatibility surface for external integrations. Symbols exported
only through `./internals` may change or move without a public API migration.

Keep `./internals` intentionally small. If an internal helper becomes useful to
external consumers, move the consumer-safe contract into the focused public owner
module, export it from a stable entrypoint, and update this document.

## Stability Rules

- Stable entrypoints may add new exports in minor releases when the names are
  caller-neutral and match an existing lifecycle area.
- Existing stable export names, schemas, command ids, and artifact file names need
  an intentional migration path before incompatible changes.
- Product-specific orchestration, queues, review UI, deploy policy, scoring, and
  apply-back decisions remain outside the public runtime contract.
- The CLI's inspectable outputs (`schema`, `commands`, recipe validation, and
  artifact verification) are part of the public contract when consumed as JSON.
