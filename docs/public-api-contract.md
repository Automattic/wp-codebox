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
  this facade over the broad root barrel. `codeboxPublicContractPrimitives()`
  exposes the Codebox-owned runtime session, runtime profile, task, agent,
  artifact, and redacted credential schema/ability map for SDK discovery.
- `@automattic/wp-codebox-core/contracts`: command catalog and inspectable
  contract metadata used by CLI and orchestrator consumers. This entrypoint also
  exposes generic WordPress runtime discovery, CRUD/DB, REST matrix, fuzz-suite
  builder, page-load, and performance observation contracts for external fuzzing
  orchestrators. Use `runtimeDescriptor()` for public readiness/capability probing
  and `runtimeContractManifest()` when a consumer needs
  Codebox-owned ability names and schema identifiers without importing backend
  adapter bindings.
- `@automattic/wp-codebox-core/artifacts`: artifact verification, apply adapter,
  export-link, diagnostics, and partial-discovery helpers.
- `@automattic/wp-codebox-core/run-results`: task, command, browser, artifact,
  recipe, and fuzz result DTO helpers for orchestrators that need result shapes
  without importing the broad root or full public facade.
- `@automattic/wp-codebox-core/php-snippets`: PHP snippet helpers used by
  runtime backend packages that need to compose Codebox lifecycle/preload PHP.
- `@automattic/wp-codebox-core/recipe-builders`: typed recipe construction
  helpers.
- `@automattic/wp-codebox-core/agent-task-recipe`: agent-task recipe assembly
  helpers.
- `@automattic/wp-codebox-core/runtime-presets`: runtime preset registry helpers.
- The runtime backend implementation package is used by the CLI and plugin
  distribution. External integrations should compose the Codebox core facades,
  WordPress abilities, CLI, or browser SDK instead of importing backend
  implementation packages directly.
- `@automattic/wp-codebox-playground`: advanced runtime backend entrypoint and
  adapter surface for runtime-backend implementors. New consumers should prefer
  `@automattic/wp-codebox-playground/public`. Product consumers should use the Codebox-owned public surfaces above and the WordPress/browser surfaces below.
- `@automattic/wp-codebox-cli`: the executable CLI surface for schema, command,
  recipe, runtime, and artifact operations.
- `@automattic/wp-codebox-cli/recipe-secret-env`: recipe secret environment
  resolution helpers for CLI consumers that need dry-run summaries or runtime
  environment injection outside the command entrypoint.

Browser sessions that load the WordPress plugin browser runtime also publish
`window.wpCodeboxBrowser.v1`. The `v1` facade is the stable browser SDK
for product consumers running inside the browser. Legacy top-level
`window.wpCodeboxBrowser` methods remain available for existing callers.
The Codebox-owned browser preview starter is `window.wpCodebox.startBrowserPreview(...)`
or `window.wpCodeboxBrowser.v1.startBrowserPreview(...)`; callers pass the
`wp-codebox/browser-preview-boot-config/v1` DTO plus a blueprint hydrator and do
not import the raw browser backend `startPlaygroundWeb` directly.

Consumer-facing WordPress abilities use the `wp-codebox/*` namespace. Public
docs and schemas describe the canonical Codebox-owned names that integrations
should call directly.

External consumers that need to probe runtime readiness should use a Codebox-owned
descriptor instead of resolving package paths, `packages/runtime-core/dist`, sibling
worktrees, cache directories, or source/build layout. The descriptor is available
as `runtimeDescriptor()` from `@automattic/wp-codebox-core/public`,
`@automattic/wp-codebox-core/contracts`, and the root compatibility barrel; as
`wp-codebox runtime descriptor --json`; and in WordPress through
`WP_Codebox_API::runtime_descriptor()` or `wp codebox runtime descriptor`. The
descriptor returns `wp-codebox/runtime-descriptor/v1` with readiness status,
capability strings, public `wp-codebox/*` ability names, and the nested
`wp-codebox/runtime-contract-manifest/v1` contract manifest.

## Public Handoff Abilities

Native hosts and other external orchestrators should treat these abilities as
the public handoff/fanout boundary:

- `wp-codebox/create-browser-task-contract` prepares a product-facing browser
  task contract. WP Codebox owns the contract envelope, session descriptors,
  callback capability shape, phase structure, and artifact references; the host
  owns durable job state, UI state, review decisions, and any callback endpoint
  implementation that receives or forwards the result.
- `wp-codebox/normalize-browser-artifact-bundle` validates caller-provided
  browser files, safe paths, entrypoint, roles, provenance, and metadata into a
  product-neutral bundle description without interpreting product-specific
  meaning.
- `wp-codebox/persist-browser-artifact` stores browser-produced files as a
  canonical WP Codebox artifact bundle and returns artifact bundle references for
  review, replay, import, or apply-back.
- `wp-codebox/inspect-artifact` reads a stored artifact bundle and returns the
  Codebox-owned bundle DTO plus verification payload. Consumers should use this
  ability, `WP_Codebox_API::inspect_artifact()`, or `wp codebox artifacts inspect`
  instead of reading the artifact directory layout directly.
- `wp-codebox/import-artifact-bundle` and
  `wp-codebox/reimport-artifact-bundle` are the durable ingress path for an
  existing bundle. They verify bundle identity/digest and return
  `wp-codebox/artifact-result-envelope/v1`; callers own when to retry,
  replace, review, or apply returned artifacts.
- `wp-codebox/run-agent-task-fanout` runs a bounded, product-neutral fanout
  request and returns the parent `wp-codebox/agent-fanout-result/v1` envelope.
  WP Codebox owns isolated worker execution, lifecycle events, aggregation
  envelope shape, and artifact layout; the host owns placement, ranking,
  durable orchestration state, callback delivery, and final result decisions.
- `wp-codebox/headless-agent-task-request/v1` is the public agent-task handoff
  envelope for deterministic headless production loops. Callers provide
  `task_input`, `runtime_profile`, and `workspace_artifact_policy`; Codebox
  normalizes CLI JSON output to `wp-codebox/headless-agent-task-result/v1` with
  `preview`, `refs`, `artifacts`, `evidence_refs`, `diagnostics`, and the compact
  `agent_task_run_result` summary. Callers should read this envelope instead of
  depending on raw recipe, runtime, or sandbox result internals.

The public runtime contract manifest currently publishes these Codebox-owned
ability identifiers:

- `wp-codebox/resolve-runtime-requirements`
- `wp-codebox/run-agent-task`
- `wp-codebox/run-agent-task-batch`
- `wp-codebox/run-agent-task-fanout`
- `wp-codebox/run-runtime-package`
- `wp-codebox/run-wordpress-workload`
- `wp-codebox/run-fuzz-suite`

The manifest intentionally excludes backend handler bindings such as agent
execution substrate ability names, runtime command handlers, legacy aliases, and
integration-specific filters.

`wp-codebox/run-fuzz-suite` accepts public target kinds `rest`, `http`,
`ability`, `command`, `runtime`, and `runtime-action`. The WordPress plugin
ability is an in-process WordPress ability only: it runs safe in-process `rest`,
same-site `http`, and WordPress `ability` targets directly and does not start a
runtime-backed episode. Requests may set `runnerMode` / `runner_mode` to `auto`,
`php-in-process`, or `runtime-backed`; the WordPress plugin ability only provides
`php-in-process`, so `runtime-backed` fails closed with `status: "error"` before
case execution and returns metadata with `supported_by_this_ability: false`,
`ability_execution_mode: "php-in-process-only"`, and the public runtime-backed
path `wp-codebox run-fuzz-suite --runner-mode=runtime-backed`. Targets that
require the runtime command, browser, editor, or page-load executors return
`status: "skipped"`, a case-level `skipReason`, and a warning diagnostic in
permissive PHP mode rather than silently passing without exercising the target.
Public suite builders declare
`metadata.requiredRunnerCapabilities`, and the PHP ability also infers required
target/runtime-action capabilities from suite targets, so callers can choose
between PHP in-process mode and runtime-backed mode before execution.
The public core exports `PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES` and
`RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES` for readiness checks. Runtime-backed
mode supports `runtime`, browser/editor/page-load action targets, and the
`crud_operation` runtime action mapped to `wordpress.crud-operation`. When a
caller requests required coverage, pass `requireCoverage: true`; unsupported
required capabilities fail closed with `status: "error"` instead of looking like a
successful structured skip.

### WordPress fuzz runtime contract

HBEX and other orchestrator consumers should read the versioned public descriptor
`wp-codebox/wordpress-fuzz-runtime-contract/v1` instead of probing runtime commands
or private implementation details. The same descriptor is exposed through:

- PHP: `WP_Codebox_API::wordpress_fuzz_runtime_contract()`
- Ability discovery metadata on `wp-codebox/run-fuzz-suite`
- WP-CLI: `wp codebox wordpress-fuzz-runtime-contract --format=json`
- Node CLI: `wp-codebox fuzz descriptor --format=json`
- TypeScript: `wordpressFuzzRuntimeContract()` from `@automattic/wp-codebox-core/contracts`

The descriptor enumerates explicit action families, reset modes, artifact
expectations, destructive-mode requirements, unsupported capabilities, and HBEX
schema ids. Unsupported features are declared as data in
`unsupportedCapabilities`; consumers should not infer support by trying commands.

The public destructive contract is bounded: destructive fuzz coverage requires
`checkpoint-per-case` reset mode plus `mutation-isolation-artifact` and
`delete-boundary-artifact` evidence. Raw delete capability is intentionally
`null`; delete coverage is represented by the explicit `delete-boundary-artifact`
contract.

HBEX schema ids advertised by the descriptor include:

- `wp-codebox/wordpress-fuzz-runtime-contract/v1`
- `wp-codebox/fuzz-suite/v1`
- `wp-codebox/fuzz-suite-result/v1`
- `wp-codebox/fuzz-runner-capabilities/v1`
- `wp-codebox/fuzz-runner-readiness/v1`
- `wp-codebox/fuzz-coverage-plan/v1`
- `wp-codebox/fuzz-fixture-plan/v1`
- `wp-codebox/rest-mutation-fixture-opt-in/v1`
- `wp-codebox/rest-mutation-generated-fixtures/v1`
- `wp-codebox/mutation-isolation-artifact/v1`
- `wp-codebox/delete-boundary-artifact/v1`
- `wp-codebox/wordpress-workload-run/v1`

Generic mutating REST fixture generation is exposed as the public
`wp-codebox/rest-mutation-generated-fixtures/v1` contract through
`restMutationGeneratedFixturesContract()`. It derives bounded disposable sandbox
payload fixtures from route schemas, optional existing collection samples, and
typed generators. Generated operations carry explicit `confidence`, `sources`,
`bounded`, `semanticValidity`, and `unsupportedReasons` metadata. The contract
does not claim complete semantic validity; unsupported bindings remain data in
the `unsupported` list, and callers pass the returned opt-ins into fuzz-suite
builders when they accept those generated fixtures for a disposable Codebox run.

TypeScript callers running through the public Codebox contract should build fuzz
suites with `@automattic/wp-codebox-core/contracts`. Use `wp-codebox/run-fuzz-suite`
or `WP_Codebox_API` for in-process WordPress ability coverage, and use the public
`wp-codebox run-fuzz-suite --runner-mode=runtime-backed` CLI path or
`@automattic/wp-codebox-playground/public executeWordPressFuzzSuite` when the suite
needs browser, editor, page, CRUD, runtime, or runtime-action coverage.
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
`WP_Codebox_API::public_contract_primitives()` and
`WP_Codebox_API::public_contract_schemas()` provide the matching PHP discovery
surface for runtime session, runtime profile, task, agent, artifact, and
redacted credential primitives.

WordPress-hosted orchestration that shells through WP-CLI can use the matching
`wp codebox ...` wrappers for these public operations, including
`runtime descriptor`, `run-runtime-task`, `run-wordpress-workload`,
`run-runtime-package`, `resolve-runtime-requirements`, `run-fuzz-suite`, and
artifact inspection/apply commands. The WP-CLI wrappers parse JSON payloads from
`--input-json` or `--input-file` and delegate through
`WP_Codebox_API` rather than backend internals.

The workspace package mirrors the core entrypoints as `./core`,
`./core/public`, `./core/contracts`, `./core/artifacts`, `./core/run-results`,
`./core/php-snippets`, `./recipe-builders`, `./run-results`, `./agent-task-recipe`,
`./runtime-presets`, `./playground/public`, and `./cli/recipe-secret-env` for
local consumers in this repo. It intentionally does not mirror the monorepo-only
`./internals` helper entrypoint.

## Contract Areas

The stable public surface is grouped by lifecycle area rather than by product:

- **Runtime task/package:** task input, agent task recipe, agent task run result,
  headless agent-task request/result, recipe source package, runtime workload,
  runtime package execution, runtime policy, and command result contracts.
  Contained WordPress runtime consumers use
  `wp-codebox/run-runtime-task`, `wp-codebox/run-wordpress-workload`,
  `wp-codebox/run-runtime-package`, the matching CLI wrappers, or
  `WP_Codebox_API` instead of composing runtime backend internals directly.
- **Public primitive discovery:** `codeboxPublicContractPrimitives()` groups the
  stable runtime session/profile/task/agent/artifact/credential schemas and
  public task/agent ability ids under Codebox-owned names. PHP consumers use the
  equivalent `WP_Codebox_API::public_contract_primitives()` accessor. Credential
  entries advertise redacted requirement/preflight/resolution DTOs only.
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
  `wp-codebox/open-or-create-browser-contained-site` requires an explicit `mode`:
  `open-only` reuses an existing prepared/live preview and returns unavailable on
  miss, `open-or-create` reuses when possible and otherwise creates, and
  `prepare-new` always creates a fresh preview session. The old boolean
  `fallback_create` input is not part of the public contract.
- **Browser SDK:** `window.wpCodeboxBrowser.v1.info()` reports SDK version,
  capability strings, and global names; `normalizeError()` returns
  `wp-codebox/browser-sdk-error/v1`; `result()` wraps async browser operations in
  `wp-codebox/browser-sdk-result/v1`; `normalizeBrowserRunResult()` returns the
  product-safe `wp-codebox/browser-run-result/v1` DTO; `browserArtifactPersistenceRef()`
  returns `wp-codebox/browser-artifact-persistence/ref/v1`; `startBrowserPreview()`
  starts a Codebox browser preview from the boot DTO and returns
  `wp-codebox/browser-preview-start-result/v1`; `runBrowserSessionRecipe()`
  executes the existing runtime helper and returns the stable browser-run DTO;
  `createBrowserConnectorRequest()` builds the canonical
  `wp-codebox/browser-connector-request/v1` envelope for connector-scoped browser
  calls, and `executeBrowserConnectorRequest()` adapts that envelope through the
  Codebox-owned provider bridge without exposing the legacy proxy transport shape;
  `createRuntimeTaskRequest()` builds the public
  `wp-codebox/runtime-task-request/v1` envelope with an explicit `target_id`;
  `runRuntimeTask()` posts that envelope to Codebox's public
  `/wp-json/wp-codebox/v1/runtime-task` route, or calls a supplied
  `executeAbility('wp-codebox/run-runtime-task', request)` adapter, and returns
  `wp-codebox/runtime-task-result/v1`;
  `methods` exposes stable references to the existing browser runtime helpers for
  callers that need legacy raw results internally. TypeScript consumers outside
  the browser can use the matching DTO helpers exported from
  `@automattic/wp-codebox-core/public`: `normalizeBrowserRunResult()`,
  `browserRunResultEnvelope()`, `browserArtifactPersistenceProjection()`,
  `persistedBrowserArtifactRefs()`, and `artifactBundleFileManifest()`.
- **Browser metrics:** consumers read browser metric summaries from Codebox
  artifact refs and browser-run DTOs returned by the public WordPress ability,
  CLI, or browser SDK surfaces.
- **Performance observation:** `wp-codebox/performance-observation/v1` describes
  normalized command diagnostics and performance evidence: elapsed timing, memory
  delta, database query counts/time/fingerprints, repeated-query summaries, hook
  timing placeholders, network counts, and browser/admin metric placeholders.
  `wordpress.rest-performance-observation` is the runtime-backed public command for
  one in-process REST request. It returns the performance observation envelope as
  the top-level result, including query fingerprints when query capture is requested
  and `$wpdb->queries` is populated, bounded hook hotspot samples from the WordPress
  `all` hook, and `capture` metadata that reports whether query capture was
  requested, captured, unavailable, partial, or uncaptured. It is an upstream
  observation primitive, not a product-specific fuzz suite or benchmark runner.
- **WordPress hotspot artifacts:** `wp-codebox/wordpress-hotspots/v1` is the
  public aggregate artifact schema for fuzz consumers that need ranked relative
  hotspots across REST routes, page/admin/browser loads, block identifiers, and
  database observations. Build it with `wordpressHotspotsArtifact()` from
  `@automattic/wp-codebox-core/public` or `@automattic/wp-codebox-core/contracts`
  using public `wp-codebox/performance-observation/v1` and
  `wp-codebox/fuzz-suite-result/v1` inputs. The schema carries stable
  `identifier` fields plus artifact refs instead of exposing backend runtime or
  Playground internals.
- **WordPress page-load coverage:** `wordpress.simulated-admin-page-load` and
  `wordpress.simulated-frontend-page-load` return `wp-codebox/wordpress-page-load-result/v1`
  with `mode: "simulated"`, status, target, resolved admin screen or frontend
  queried-object identity where WordPress exposes it, redirects, notices/errors,
  optional query/performance observations, and a JSON artifact ref. These commands
  intentionally use a light in-process WordPress load path. `wordpress.server-page-load`
  returns the same result schema with `mode: "server-http"` for preview-server HTTP
  requests without browser execution. `wordpress.browser-page-load` returns it with
  `mode: "browser"` when a caller explicitly needs DOM, screenshot, console, or
  network evidence.
- **WordPress workload boundary:** `wp-codebox/wordpress-workload-run/v1` accepts
  Codebox-native recipe inputs plus `capture: { queries: true }` or
  `enableQueryCapture: true`. The CLI and TypeScript helpers preserve the request
  as recipe metadata and pass it to public WordPress commands; downstream adapters
  translate that DTO into their own contracts outside WP Codebox.
- **WordPress admin discovery:** `wordpress.runtime-discovery` and
  `wordpress.admin-page-inventory` expose admin pages with canonical admin URLs,
  declared capabilities, current-user access checks, and current-user role context
  for authenticated runtime fuzzing. When the request context has not populated
  WordPress admin menu globals yet, discovery performs the standard admin menu
  bootstrap before reporting an unsupported empty menu.
- **Fuzz suite:** `wp-codebox/fuzz-suite/v1` describes a generic suite of
  boundary cases against a Codebox-owned target such as an ability, command, HTTP
  endpoint, REST route, or runtime action. Canonical target kinds are `ability`,
  `command`, `http`, `rest`, `runtime`, and `runtime-action`. Runtime-backed
  callers use the public Codebox fuzz-suite ability, CLI, or `WP_Codebox_API`
  surfaces for runtime-backed coverage; PHP/plugin callers continue to advertise
  `php-in-process` capabilities for the safe in-process path. Command-backed runners map safe
  `rest_request` actions to `wordpress.rest-request` and `wp_cli` actions to
  `wordpress.wp-cli`, while episode-only/browser actions remain structured
  skips. `wp-codebox/fuzz-suite-result/v1` reports case status, diagnostics,
  artifact refs, and suite summary without embedding product-specific Woo,
  Gutenberg, Jetpack, or Core assertions.
- **Sandbox isolation proof:** `wp-codebox/sandbox-isolation-proof/v1` is the
  destructive fuzzing proof artifact for disposable sandbox lifecycle evidence.
  The required fields are `schema`, `artifactKind`, `version`, `status`,
  `baseline`, `mutation`, `restore`, `diff`, `runtimeBoundary`,
  `runtimeBoundary.destroy`, `artifacts`, and `generatedAt`. A passing proof
  records baseline creation, the mutating step, restore/reset evidence, a diff
  verdict such as `clean-after-restore`, explicit artifact refs, and a disposable
  runtime boundary with `hostAccess: "declared-mounts-only"` and
  `runtimeBoundary.destroy.status: "destroyed"`. Callers build it with
  `sandboxIsolationProof()` from `@automattic/wp-codebox-core/public` or
  `@automattic/wp-codebox-core/contracts`; the helper rejects missing destroy
  evidence or missing artifact refs instead of returning a partial proof.
- **Artifacts:** manifest, paths, capture policy, layout, references, review,
  diagnostics, test result, export link, storage, result envelope, evidence
  envelope, and materialization contracts.
- **Run results:** normalized task, terminal, command, browser, recipe summary,
  artifact handoff, progress snapshot, and fuzz result DTOs that orchestrators can
  import from `@automattic/wp-codebox-core/run-results`.
- **Inspect:** command registry metadata, JSON Schema factories, CLI `schema` and
  `commands` output, and recipe validation descriptors.

Current backend references such as host job systems, agent execution substrates,
workspace backends, or contained WordPress runtime backends describe adapters WP
Codebox may use internally. Internal/default substrate adapters are implementation
details when Codebox needs job, agent, or workspace services. They are not consumer
API names: external integrations depend on the Codebox ability ids, schemas,
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
`wp-codebox/runtime-package-task/v1`. Typed artifact declarations use
`wp-codebox/runtime-package-artifact-declaration/v1`; output projections use
`wp-codebox/runtime-package-output-projection/v1`; results use
`wp-codebox/runtime-package-result/v1`. `package.slug` is package identity;
`package.source` is the import path. Workspace-relative sources must be
normalized against an explicit workspace root before execution. Required
artifacts are declared explicitly, runtime import failures return structured
diagnostics, and semantic outputs plus explicit typed/structured artifacts remain
separate result fields. These contracts are generic Codebox runtime/package
shapes for consumers using the runtime package API.
Consumers can read the same ids from `runtimeContractManifest().schemas` and
`runtimeContractManifest().abilities`.

Agent task callers use the `wp-codebox/run-agent-task` ability or
`wp-codebox agent-task-run --json`. Caller-facing results normalize to
`wp-codebox/agent-task-run-result/v1` through `normalizeAgentTaskRunResult()`.
Headless product integrations can use `wp-codebox/headless-agent-task-request/v1`
for the caller-owned task DTO: provide `task_input`, a portable
`runtime_profile`, and `workspace_artifact_policy`; receive
`wp-codebox/headless-agent-task-result/v1` with preview/runtime access plus
artifact, evidence, transcript, log, and patch refs. Shell/bin/path and provider
plugin path details stay internal/debug inputs rather than product DTO fields.
Artifact handoff, import, and materialization results normalize to
`wp-codebox/artifact-result-envelope/v1` through `artifactResultEnvelope()` and
`normalizeArtifactResultEnvelope()`.

Run-plan progress normalizes to `wp-codebox/run-plan-progress/v1` through
`normalizeRunPlanProgressSnapshot()`. The snapshot reports `status`, `active`,
settled `counts`, per-worker status, optional `sessionId`/`runId`, and optional
`eventsRef`/`resultRef` references. Hosts may stream or persist those snapshots in
their own job system, but WP Codebox does not require host job ownership, create a
durable parent queue, or expose artifact-file paths as the only progress contract.
Cancellation appears as normalized worker/run status when requested or observed;
host UIs own the button, policy, and durable cancellation request transport.

Fuzzing callers can attach `performanceObservation()` output to case diagnostics
or evidence artifacts when command behavior needs comparable performance context.
`wordpress.run-php` diagnostics include this shape for opted-in query capture.

Fuzzing callers use `fuzzSuiteContract()` to publish or discover suites and
`fuzzSuiteResultEnvelope()` to return the stable result DTO. Hosts own how cases
are generated and executed. Product adapters may translate Woo, Gutenberg,
Jetpack, Core, or other domain-specific probes into these generic case records at
their own boundary; those product semantics are not part of the Codebox fuzz
suite contract.

For destructive fuzzing, callers should attach a
`wp-codebox/sandbox-isolation-proof/v1` artifact alongside the
`wp-codebox/fuzz-suite-result/v1` case result. The proof must contain a baseline
creation command/ref, mutating command/ref, restore command/ref, a machine-readable
diff verdict after restore, explicit bundle-relative artifact refs, and destroyed
runtime lifecycle evidence. `sandboxIsolationProof()` fails closed when these
boundary facts are missing, so orchestrators can treat absence of the proof as a
blocked destructive run rather than a successful isolated mutation.

Agent task callers use the `wp-codebox/run-agent-task` ability or
`wp-codebox agent-task-run --json`. Caller-facing results normalize to
`wp-codebox/agent-task-run-result/v1` through `normalizeAgentTaskRunResult()`.
Artifact handoff, import, and materialization results normalize to
`wp-codebox/artifact-result-envelope/v1` through `artifactResultEnvelope()` and
`normalizeArtifactResultEnvelope()`.

Runner workspace backends are an advanced adapter surface installed by integration
code and discovered via the `wp_codebox_runner_workspace_backend` filter. The
stable backend config is
`wp-codebox/runner-workspace-backend/v1`: an optional backend `id`, an optional
`workspace_root_constant`, and an `abilities` map keyed by generic runner
workspace operation names. Public callers use the Codebox ability ids and
request/result schemas while the adapter config maps each operation to its
integration-provided backend ability. See `docs/runner-workspace-backend-contract.md`.
Those adapter bindings are not part of `runtimeContractManifest()`.

## External Orchestrator Migration

External orchestrators and other dist/dynamic package loaders should import the
narrowest Codebox entrypoint that matches the runtime object they need. This
keeps packaged helpers stable when the broad root barrel continues to exist for
compatibility but stops being the place where new public helpers accumulate.

| Current import pressure | Use instead | Notes |
| --- | --- | --- |
| Root package import for command names, schema ids, ability metadata, WordPress runtime discovery, CRUD/DB contracts, REST matrix/fuzz suite builders, or performance observation | `@automattic/wp-codebox-core/contracts` | Use focused generic contracts without backend adapter exports or product-specific fuzzing logic. |
| Root package import for artifact refs, export links, bundle verification, or apply/materialization handoff | `@automattic/wp-codebox-core/artifacts` | Artifact helpers stay grouped by evidence and handoff lifecycle. |
| Root package import for runtime package, phpunit, or bench recipe assembly | `@automattic/wp-codebox-core/recipe-builders` | Recipe construction helpers are public without pulling the full runtime barrel. |
| Root package import for task, command, browser, recipe, artifact, or fuzz result DTOs | `@automattic/wp-codebox-core/run-results` | Result projection helpers are stable for orchestrators and dist loaders. |
| Workspace-local mirror import during package development | `./core/contracts`, `./core/artifacts`, `./recipe-builders`, or `./run-results` | Workspace mirrors exist for this repo's local consumers; published consumers should use package names. |

The root barrel remains published so existing integrations keep working. Treat it
as compatibility-only: new external orchestrator call sites should choose one of
the focused entrypoints above, and new Codebox helpers should be added to the
focused owner module that matches their lifecycle area.

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
