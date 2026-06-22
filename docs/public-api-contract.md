# Public API Contract

WP Codebox has two kinds of API surface: stable public entrypoints for host
integrations, and monorepo helper entrypoints for package implementation reuse.
This document is the maintained contract map for package consumers. Consumers use
Codebox APIs to assemble and run sandboxes.

## Stable Entry Points

Use these package entrypoints from external integrations:

- `@automattic/wp-codebox-core`: broad compatibility barrel for existing
  consumers. New integrations should use a focused entrypoint below.
- `@automattic/wp-codebox-core/public`: curated public facade for runtime,
  task/package, runner workspace, tool bridge, parent tool bridge, browser,
  artifact, recipe, and policy contract types and helpers. New external TypeScript consumers should prefer
  this facade over the broad root barrel.
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
- `@automattic/wp-codebox-playground/public`: stable WordPress runtime wrappers
  for creating Playground-backed WordPress runtimes and episodes, running episode
  actions with lifecycle hooks, collecting runtime/episode artifacts, and reading
  browser artifact metrics through the published Playground facade.
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
`./agent-task-recipe`, `./runtime-presets`, `./playground/public`, and
`./cli/recipe-secret-env` for local consumers in this repo.

## Contract Areas

The stable public surface is grouped by lifecycle area rather than by product:

- **Runtime task/package:** task input, agent task recipe, agent task run result,
  recipe source package, runtime workload, runtime package execution, runtime
  policy, and command result contracts. Playground-backed WordPress consumers can use
  `createWordPressRuntime()`, `createWordPressEpisode()`, and
  `runWordPressEpisodeActions()` from `@automattic/wp-codebox-playground/public`
  instead of composing core runtime internals directly.
- **Runner workspace:** workspace policy, preload artifact, source-root
  preparation, mount primitive, runner workspace publication contracts, and the
  backend adapter config schema `wp-codebox/runner-workspace-backend/v1`.
- **Tool bridge:** host tool registry, managed host command, host command
  executor, sandbox tool policy, and tool-call artifact contracts.
- **Parent tool bridge:** `wp-codebox/parent-tool-bridge/v1`,
  `wp-codebox/parent-tool-request/v1`, and `wp-codebox/parent-tool-result/v1`
  describe allowlisted calls from a sandbox to a host dispatcher. Codebox owns
  the envelope and authorization shape; host adapters own endpoint, command, and
  product payload validation.
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
- **Browser metrics:** Node consumers can call `collectBrowserArtifactMetrics()`
  from `@automattic/wp-codebox-playground/public` to summarize browser metrics
  from an existing artifact bundle directory.
- **Performance observation:** `wp-codebox/performance-observation/v1` describes
  normalized command diagnostics and performance evidence: elapsed timing, memory
  delta, database query counts/time/fingerprints, repeated-query summaries, hook
  timing placeholders, network counts, and browser/admin metric placeholders.
- **Fuzz suite:** `wp-codebox/fuzz-suite/v1` describes a generic suite of
  boundary cases against a Codebox-owned target such as an ability, command, HTTP
  endpoint, REST route, or runtime action. `wp-codebox/fuzz-suite-result/v1`
  reports case status, diagnostics, artifact refs, and suite summary without
  embedding product-specific Woo, Gutenberg, Jetpack, or Core assertions.
- **Artifacts:** manifest, paths, capture policy, layout, references, review,
  diagnostics, test result, export link, storage, result envelope, evidence
  envelope, and materialization contracts.
- **Inspect:** command registry metadata, JSON Schema factories, CLI `schema` and
  `commands` output, and recipe validation descriptors.

Current backend references such as Data Machine, Agents API, Data Machine Code,
or WordPress Playground describe the upstream/runtime adapters WP Codebox uses.
Consumers depend on the Codebox ability ids, schemas, package entrypoints, and
browser SDK facades above.

## Integration Boundary

WP Codebox is the portable integration surface around the current WordPress agent
runtime stack:

- Data Machine concepts such as jobs, artifacts, flows, and pending approvals map
  to Codebox run, artifact, approval, and session contracts before they reach a
  consumer.
- Agents API execution targets, principals, and provider mechanics map to Codebox
  task, permission, provider, and runtime-session contracts.
- Data Machine Code workspace lifecycle, GitHub workflow, evidence, and apply-back
  details map to Codebox source, workspace, artifact, and apply contracts.
- WordPress Playground boot, filesystem, preview, PHP, and WP-CLI details map to
  Codebox runtime, mount, command, preview, and browser-session contracts.

The dependency direction is one-way: Codebox adapts those upstream systems into
generic Codebox inputs. If a Data Machine workflow launches a sandbox, the
Codebox adapter translates from generic Data Machine inputs into the Codebox
task/recipe/runtime contracts at the boundary.

When adding a new public type or helper, place it in the focused owner module and
export it through `@automattic/wp-codebox-core/public` or the narrowest stable
entrypoint that matches its lifecycle area. Avoid adding implementation helpers
to a public barrel only because they are convenient for one in-repo caller.

Runtime package callers use `wp-codebox/run-runtime-package` or
`buildRuntimePackageRunRecipe()`. The public request schema is
`wp-codebox/runtime-package-execution-input/v1`; typed artifact declarations use
`wp-codebox/runtime-package-artifact-declaration/v1`; output projections use
`wp-codebox/runtime-package-output-projection/v1`. These contracts are generic
Codebox runtime/package shapes for consumers using the runtime package API.

Agent task callers use the `wp-codebox/run-agent-task` ability or
`wp-codebox agent-task-run --json`. Caller-facing results normalize to
`wp-codebox/agent-task-run-result/v1` through `normalizeAgentTaskRunResult()`.
Artifact handoff, import, and materialization results normalize to
`wp-codebox/artifact-result-envelope/v1` through `artifactResultEnvelope()` and
`normalizeArtifactResultEnvelope()`.

Fuzzing callers can attach `performanceObservation()` output to case diagnostics
or evidence artifacts when command behavior needs comparable performance context.
`wordpress.run-php` diagnostics include this shape for opted-in query capture.

Fuzzing callers use `fuzzSuiteContract()` to publish or discover suites and
`fuzzSuiteResultEnvelope()` to return the stable result DTO. Hosts own how cases
are generated and executed. Product adapters may translate Woo, Gutenberg,
Jetpack, Core, or other domain-specific probes into these generic case records at
their own boundary; those product semantics are not part of the Codebox fuzz
suite contract.

Agent task callers use the `wp-codebox/run-agent-task` ability or
`wp-codebox agent-task-run --json`. Caller-facing results normalize to
`wp-codebox/agent-task-run-result/v1` through `normalizeAgentTaskRunResult()`.
Artifact handoff, import, and materialization results normalize to
`wp-codebox/artifact-result-envelope/v1` through `artifactResultEnvelope()` and
`normalizeArtifactResultEnvelope()`.

Runner workspace backends are installed by integration code and discovered via
the `wp_codebox_runner_workspace_backend` filter. The stable backend config is
`wp-codebox/runner-workspace-backend/v1`: an optional backend `id`, an optional
`workspace_root_constant`, and an `abilities` map keyed by generic runner
workspace operation names. Public callers use the Codebox ability ids and
request/result schemas while the adapter config maps each operation to its
integration-provided backend ability. See `docs/runner-workspace-backend-contract.md`.

## Internal Entry Point

`@automattic/wp-codebox-core/internals` exists for this monorepo's package split
and may be used by tests, the CLI, and backend packages in this repository.
External integrations use the stable entrypoints listed above. Symbols exported
only through `./internals` may change or move between package releases.

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
