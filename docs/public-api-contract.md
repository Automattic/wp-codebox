# Public API Contract

WP Codebox has two kinds of API surface: stable public entrypoints for host
integrations, and monorepo helper entrypoints for package implementation reuse.
This document is the maintained contract map for package consumers. Consumers use
Codebox APIs to assemble and run sandboxes.

## Stable Entry Points

Use these package entrypoints from external integrations:

- `@automattic/wp-codebox-core`: compatibility-only broad barrel for existing
  consumers. New integrations should use a focused entrypoint below; new helper
  additions belong in `public` or a lifecycle subpath, not the root barrel.
- `@automattic/wp-codebox-core/public`: curated public facade for runtime,
  task/package, runner workspace, tool bridge, parent tool bridge, browser,
  artifact, recipe, and policy contract types and helpers. New external TypeScript consumers should prefer
  this facade over the broad root barrel.
- `@automattic/wp-codebox-core/contracts`: command catalog and inspectable
  contract metadata used by CLI and orchestrator consumers. Use
  `runtimeContractManifest()` when a consumer needs Codebox-owned ability names
  and schema identifiers without importing backend adapter bindings.
- `@automattic/wp-codebox-core/artifacts`: artifact verification, apply adapter,
  export-link, diagnostics, and partial-discovery helpers.
- `@automattic/wp-codebox-core/run-results`: task, command, browser, artifact,
  recipe, and fuzz result DTO helpers for orchestrators that need result shapes
  without importing the broad root or full public facade.
- `@automattic/wp-codebox-core/recipe-builders`: typed recipe construction
  helpers.
- `@automattic/wp-codebox-core/agent-task-recipe`: agent-task recipe assembly
  helpers.
- `@automattic/wp-codebox-core/runtime-presets`: runtime preset registry helpers.
- `@automattic/wp-codebox-playground`: advanced runtime backend entrypoint for
  implementors that need the current contained WordPress runtime factory and
  backend-owned helper types. New consumers should prefer
  `@automattic/wp-codebox-playground/public` unless they are implementing a
  runtime backend.
- `@automattic/wp-codebox-playground/public`: stable WordPress runtime wrappers
  for creating contained WordPress runtimes and episodes, running episode
  actions with lifecycle hooks, running typed WordPress actions such as WP-CLI,
  PHP, REST requests, browser probes/actions, and editor opens, collecting
  runtime/episode artifacts, and reading browser artifact metrics through the
  published runtime facade.
- `@automattic/wp-codebox-cli`: the executable CLI surface for schema, command,
  recipe, runtime, and artifact operations.
- `@automattic/wp-codebox-cli/recipe-secret-env`: recipe secret environment
  resolution helpers for CLI consumers that need dry-run summaries or runtime
  environment injection outside the command entrypoint.

Browser sessions that load the WordPress plugin browser runtime also publish
`window.wpCodeboxBrowser.v1`. The `v1` facade is the stable browser SDK
for product consumers running inside the browser. Legacy top-level
`window.wpCodeboxBrowser` methods remain available for existing callers.

Consumer-facing WordPress abilities use the `wp-codebox/*` namespace. When an
ability has multiple registered names, new integrations should prefer the
inspectable `meta.canonical_ability` value. Aliases stay registered for existing
callers, but docs and schemas should describe the canonical Codebox-owned name
first.

The public runtime contract manifest currently publishes these Codebox-owned
ability identifiers:

- `wp-codebox/run-agent-task`
- `wp-codebox/run-agent-task-batch`
- `wp-codebox/run-agent-task-fanout`
- `wp-codebox/run-runtime-package`
- `wp-codebox/run-wordpress-workload`
- `wp-codebox/run-fuzz-suite`

It also includes compatibility aliases for the `run-sandbox-task` family. The
manifest intentionally excludes backend handler bindings such as agent execution
substrate ability names, runtime command handlers, and integration-specific
filters.

`wp-codebox/run-fuzz-suite` accepts public target kinds `rest`, `http`,
`ability`, `command`, `runtime`, and `runtime-action`. The WordPress plugin
ability runs safe in-process `rest`, same-site `http`, and WordPress `ability`
targets directly. Targets that require the runtime command, browser, editor, or
page-load executors return `status: "skipped"`, a case-level `skipReason`, and a
warning diagnostic rather than silently passing without exercising the target.
Public suite builders declare `metadata.requiredRunnerCapabilities` so callers
can choose between PHP in-process mode and runtime-backed mode before execution.
The public core exports `PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES` and
`RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES` for readiness checks. Runtime-backed
mode supports `runtime`, browser/editor/page-load action targets, and the
`crud_operation` runtime action mapped to `wordpress.crud-operation`. When a
caller requests required coverage, pass `requireCoverage: true`; unsupported
required capabilities fail closed with `status: "error"` instead of looking like a
successful structured skip.
Documented skip reason codes are:

- `wp_codebox_fuzz_target_command_unsupported`
- `wp_codebox_fuzz_runtime_action_wp_cli_unsupported`
- `wp_codebox_fuzz_runtime_action_php_unsupported`
- `wp_codebox_fuzz_runtime_action_browser_unsupported`
- `wp_codebox_fuzz_runtime_action_browser_probe_unsupported`
- `wp_codebox_fuzz_runtime_action_editor_open_unsupported`
- `wp_codebox_fuzz_runtime_action_admin_page_unsupported`
- `wp_codebox_fuzz_runtime_action_page_unsupported`
- `wp_codebox_fuzz_runtime_action_unsupported`
- `wp_codebox_fuzz_step_unsupported`

WordPress consumers should prefer `WP_Codebox_API` for PHP calls and
`wp-codebox/*` ability ids for ability-oriented calls. Runtime adapters may use
backend systems internally, while public docs and schemas present Codebox-owned
ability names, schemas, and facades to callers.

The workspace package mirrors the core entrypoints as `./core`,
`./core/public`, `./core/contracts`, `./core/artifacts`, `./core/run-results`,
`./recipe-builders`, `./run-results`, `./agent-task-recipe`,
`./runtime-presets`, `./playground/public`, and `./cli/recipe-secret-env` for
local consumers in this repo. It intentionally does not mirror the monorepo-only
`./internals` helper entrypoint.

## Contract Areas

The stable public surface is grouped by lifecycle area rather than by product:

- **Runtime task/package:** task input, agent task recipe, agent task run result,
  recipe source package, runtime workload, runtime package execution, runtime
  policy, and command result contracts. Contained WordPress runtime consumers can use
  `createWordPressRuntime()`, `createWordPressEpisode()`, and
  `runWordPressEpisodeActions()` from `@automattic/wp-codebox-playground/public`
  instead of composing core runtime internals directly. The same entrypoint also
  exposes consumer-safe action helpers: `runWordPressWpCli()`,
  `runWordPressPhp()`, `requestWordPressRest()`, `runWordPressBrowserAction()`,
  `probeWordPressBrowser()`, `openWordPressEditor()`,
  `openWordPressAdminPage()`, `visitWordPressPage()`, discovery/inventory
  helpers, CRUD/DB read helpers, in-process `loadWordPressAdminPage()` and
  `loadWordPressFrontendPage()` helpers, `executeWordPressRestMatrix()`,
  `executeFuzzSuite()`, `wordpressAdminPageLoadAction()`, and
  `wordpressFrontendPageLoadAction()`. `openWordPressAdminPage()` keeps browser
  probe semantics; use the `load*Page()` helpers for the in-process page-load
  command contracts.
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
  boundary contracts. Public WordPress abilities return compact browser/session
  product DTOs by default; executable Playground recipes, runtime payloads,
  sandbox paths, and implementation diagnostics are internal/debug contracts.
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
- **WordPress page-load coverage:** `wordpress.admin-page-load` and
  `wordpress.frontend-page-load` return `wp-codebox/wordpress-page-load-result/v1`
  with status, target, resolved admin screen or frontend queried-object identity
  where WordPress exposes it, redirects, notices/errors, optional query/performance
  observations, and a JSON artifact ref. These commands intentionally use a light
  in-process WordPress load path; browser-heavy probes remain available through
  browser commands and `openWordPressAdminPage()` when a caller explicitly needs
  DOM, screenshot, console, or network evidence.
- **WordPress admin discovery:** `wordpress.runtime-discovery` and
  `wordpress.admin-page-inventory` expose admin pages with canonical admin URLs,
  declared capabilities, current-user access checks, and current-user role context
  for authenticated runtime fuzzing. When the request context has not populated
  WordPress admin menu globals yet, discovery performs the standard admin menu
  bootstrap before reporting an unsupported empty menu.
- **Fuzz suite:** `wp-codebox/fuzz-suite/v1` describes a generic suite of
  boundary cases against a Codebox-owned target such as an ability, command, HTTP
  endpoint, REST route, or runtime action. Canonical target kinds are `ability`,
  `command`, `http`, `rest`, `runtime`, and `runtime-action`. Runtime actions use
  the same public action types as `@automattic/wp-codebox-playground/public` where
  a runner can execute them directly; command-backed runners map safe
  `rest_request` actions to `wordpress.rest-request` and `wp_cli` actions to
  `wordpress.wp-cli`, while episode-only/browser actions remain structured
  skips. `wp-codebox/fuzz-suite-result/v1` reports case status, diagnostics,
  artifact refs, and suite summary without embedding product-specific Woo,
  Gutenberg, Jetpack, or Core assertions.
- **Artifacts:** manifest, paths, capture policy, layout, references, review,
  diagnostics, test result, export link, storage, result envelope, evidence
  envelope, and materialization contracts.
- **Run results:** normalized task, terminal, command, browser, recipe summary,
  artifact handoff, and fuzz result DTOs that orchestrators can import from
  `@automattic/wp-codebox-core/run-results`.
- **Inspect:** command registry metadata, JSON Schema factories, CLI `schema` and
  `commands` output, and recipe validation descriptors.

Current backend references such as host job systems, agent execution substrates,
workspace backends, or contained WordPress runtime backends describe adapters WP
Codebox may use internally. Consumers depend on the Codebox ability ids, schemas,
package entrypoints, and browser SDK facades above.

## Integration Boundary

WP Codebox is the portable integration surface around WordPress agent runtime
work:

- Host job-system concepts such as jobs, artifacts, flows, and pending approvals
  map to Codebox run, artifact, approval, and session contracts before they reach
  a consumer.
- Agent execution substrate targets, principals, and provider mechanics map to
  Codebox task, permission, provider, and runtime-session contracts.
- Workspace backend lifecycle, source-control workflow, evidence, and apply-back
  details map to Codebox source, workspace, artifact, and apply contracts.
- Contained WordPress runtime boot, filesystem, preview, PHP, and WP-CLI details
  map to Codebox runtime, mount, command, preview, and browser-session contracts.

The dependency direction is one-way: Codebox adapts host systems into generic
Codebox inputs. If a host job system launches a sandbox, the Codebox adapter
translates from host-owned inputs into the Codebox task/recipe/runtime contracts
at the boundary.

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
Consumers can read the same ids from `runtimeContractManifest().schemas` and
`runtimeContractManifest().abilities`.

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
Those adapter bindings are not part of `runtimeContractManifest()`.

## Homeboy Extensions Migration

Homeboy Extensions and other dist/dynamic package loaders should import the
narrowest Codebox entrypoint that matches the runtime object they need. This
keeps packaged helpers stable when the broad root barrel continues to exist for
compatibility but stops being the place where new public helpers accumulate.

| Current import pressure | Use instead | Notes |
| --- | --- | --- |
| Root package import for command names, schema ids, or ability metadata | `@automattic/wp-codebox-core/contracts` | Use `runtimeContractManifest()` and command contract helpers without backend adapter exports. |
| Root package import for artifact refs, export links, bundle verification, or apply/materialization handoff | `@automattic/wp-codebox-core/artifacts` | Artifact helpers stay grouped by evidence and handoff lifecycle. |
| Root package import for runtime package, phpunit, or bench recipe assembly | `@automattic/wp-codebox-core/recipe-builders` | Recipe construction helpers are public without pulling the full runtime barrel. |
| Root package import for task, command, browser, recipe, artifact, or fuzz result DTOs | `@automattic/wp-codebox-core/run-results` | Result projection helpers are stable for orchestrators and dist loaders. |
| Workspace-local mirror import during package development | `./core/contracts`, `./core/artifacts`, `./recipe-builders`, or `./run-results` | Workspace mirrors exist for this repo's local consumers; published consumers should use package names. |

The root barrel remains published so existing integrations keep working. Treat it
as compatibility-only: new Homeboy Extensions call sites should choose one of the
focused entrypoints above, and new Codebox helpers should be added to the focused
owner module that matches their lifecycle area.

## Internal Entry Point

`@automattic/wp-codebox-core/internals` exists for this monorepo's package split
and may be used by tests, the CLI, and backend packages in this repository. The
workspace package does not expose a `./core/internals` mirror. External
integrations use the stable entrypoints listed above. Symbols exported only
through `./internals` may change or move between package releases.

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
