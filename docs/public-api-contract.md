# Public API Contract

WP Codebox has two kinds of API surface: stable public entrypoints for host
integrations, and monorepo internals for implementation reuse. This document is
the maintained contract map for package consumers.

## Stable Entry Points

Use these package entrypoints from external integrations:

- `@automattic/wp-codebox-core`: runtime, task/package, runner workspace, tool
  bridge, browser task/contained-site, artifact metadata, recipe, policy, and
  provider contract types and helpers.
- `@automattic/wp-codebox-core/public`: curated public facade for runtime,
  task/package, runner workspace, tool bridge, browser, artifact, recipe,
  policy, and provider contract types and helpers. New external TypeScript
  consumers should prefer this facade over the broad root barrel.
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

Browser Playground sessions that load the WordPress plugin browser runtime also
publish `window.wpCodeboxBrowser.v1`. The `v1` facade is the stable browser SDK
for product consumers running inside the browser. Legacy top-level
`window.wpCodeboxBrowser` methods remain available for existing callers.

Consumer-facing WordPress abilities use the `wp-codebox/*` namespace. When an
ability has multiple registered names, new integrations should prefer the
inspectable `meta.canonical_ability` value. Aliases stay registered for existing
callers, but docs and schemas should describe the canonical Codebox-owned name
first.

The workspace package mirrors the core entrypoints as `./core`,
`./core/public`, `./core/contracts`, `./core/artifacts`, `./recipe-builders`,
`./agent-task-recipe`, `./runtime-presets`, and `./cli/recipe-secret-env` for
local consumers in this repo.

## Contract Areas

The stable public surface is grouped by lifecycle area rather than by product:

- **Runtime task/package:** task input, agent task recipe, agent task run result,
  recipe source package, runtime workload, WordPress workload primitives,
  runtime policy, provider runtime, and command result contracts.
- **Runner workspace:** workspace policy, preload artifact, source-root
  preparation, mount primitive, and runner workspace publication contracts.
- **Tool bridge:** host tool registry, managed host command, host command
  executor, sandbox tool policy, and tool-call artifact contracts.
- **Browser task and contained site:** browser interaction, callback, probe,
  review bridge, session origin, artifact lifecycle, result shape, and runtime
  boundary contracts.
- **Browser SDK:** `window.wpCodeboxBrowser.v1.info()` reports SDK version,
  capability strings, and global names; `normalizeError()` returns
  `wp-codebox/browser-sdk-error/v1`; `result()` wraps async browser operations in
  `wp-codebox/browser-sdk-result/v1`; `normalizeBrowserRunResult()` returns the
  product-safe `wp-codebox/browser-run-result/v1` DTO; `browserArtifactPersistenceRef()`
  returns `wp-codebox/browser-artifact-persistence/ref/v1`; `runBrowserSessionRecipe()`
  executes the existing runtime helper and returns the stable browser-run DTO;
  `methods` exposes stable references to the existing browser runtime helpers for
  callers that need legacy raw results internally. TypeScript consumers outside
  the browser can use the matching DTO helpers exported from
  `@automattic/wp-codebox-core/public`: `normalizeBrowserRunResult()`,
  `browserRunResultEnvelope()`, `browserArtifactPersistenceProjection()`,
  `persistedBrowserArtifactRefs()`, and `artifactBundleFileManifest()`.
- **Artifacts:** manifest, paths, capture policy, layout, references, review,
  diagnostics, test result, export link, storage, result envelope, evidence
  envelope, and materialization contracts.
- **Inspect:** command registry metadata, JSON Schema factories, CLI `schema` and
  `commands` output, and recipe validation descriptors.

Implementation backends are intentionally not public namespaces. References to
Agents API, Data Machine Code, or WordPress Playground describe the current
upstream/runtime adapter behind WP Codebox; consumers should depend on the
Codebox ability ids, schemas, package entrypoints, and browser SDK facades above.

When adding a new public type or helper, place it in the focused owner module and
export it through `@automattic/wp-codebox-core/public` or the narrowest stable
entrypoint that matches its lifecycle area. Avoid adding implementation helpers
to a public barrel only because they are convenient for one in-repo caller.

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
