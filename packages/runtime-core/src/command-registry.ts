import { BROWSER_PROBE_ACCEPTED_ARGS, BROWSER_PROBE_BROWSER_VALUES, BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_CHROMIUM_PROFILE_IDS, BROWSER_PROBE_THROTTLE_PROFILE_IDS } from "./browser-probe-contract.js"

export type CommandHandlerBinding =
  | { kind: "playground"; method: string }
  | { kind: "recipe-alias"; command: string }

export type CommandJsonSchema = Record<string, unknown> & { $id?: string }

export interface CommandOutputSchemaContract {
  id: string
  jsonSchema?: CommandJsonSchema
}

export interface CommandDefinition {
  id: string
  description: string
  acceptedArgs: Array<{
    name: string
    description: string
    required?: boolean
    repeatable?: boolean
    format?: string
  }>
  outputShape: string
  outputSchema?: CommandOutputSchemaContract
  policyRequirement: string
  requiresPolicyCommands?: readonly string[]
  validation?: CommandValidationDescriptor
  recipe: boolean
  handler: CommandHandlerBinding
}

export interface CommandValidationDescriptor {
  requiredArgs?: readonly CommandRequiredArgDescriptor[]
  requiredAnyArgs?: readonly CommandRequiredAnyArgDescriptor[]
  argRules?: readonly CommandArgValidationDescriptor[]
}

export interface CommandRequiredArgDescriptor {
  name: string
  code: string
  message: string
}

export interface CommandRequiredAnyArgDescriptor {
  names: readonly string[]
  code: string
  message: string
}

export type CommandArgValidationDescriptor =
  | { name: string; kind: "boolean"; code: string; message: string }
  | { name: string; kind: "duration"; code: string; message: string }
  | { name: string; kind: "positive-integer"; code: string; message: string }
  | { name: string; kind: "viewport"; code: string; message: string }
  | { name: string; kind: "enum"; values: readonly string[]; prefixes?: readonly string[]; code: string; message: string }
  | { name: string; kind: "comma-list-enum"; values: readonly string[]; code: string; message: string }

const objectEnvelopeSchema = (id: string, extraProperties: Record<string, unknown> = {}): CommandOutputSchemaContract => ({
  id,
  jsonSchema: {
    $id: id,
    type: "object",
    additionalProperties: true,
    properties: {
      schema: { const: id },
      command: { type: "string" },
      status: { type: "string" },
      ...extraProperties,
    },
  },
})

const artifactSummarySchema = (id: string, artifactProperties: Record<string, unknown> = {}): CommandOutputSchemaContract => objectEnvelopeSchema(id, {
  artifacts: {
    type: "object",
    additionalProperties: true,
    properties: artifactProperties,
  },
})

const snapshotScopingAcceptedArgs: CommandDefinition["acceptedArgs"] = [
  { name: "snapshot-include-wp-content", description: "Comma-separated wp-content-relative paths to include in the runtime snapshot. Defaults to all non-excluded paths.", format: "string" },
  { name: "snapshot-exclude-wp-content", description: "Comma-separated wp-content-relative paths to exclude from the runtime snapshot.", format: "string" },
  { name: "snapshot-database-tables", description: "Comma-separated database table base names to include, such as posts,postmeta,options.", format: "string" },
  { name: "snapshot-exclude-database-tables", description: "Comma-separated database table base names to exclude from the runtime snapshot.", format: "string" },
  { name: "snapshot-option-names", description: "Comma-separated option_name values or LIKE patterns using * for the options table.", format: "string" },
  { name: "snapshot-post-types", description: "Comma-separated post types used to scope posts and postmeta table exports.", format: "string" },
]

const browserActionCaptureValues = ["steps", "actions", "console", "errors", "html", "network", "screenshot", "dom-snapshot"] as const
const browserScenarioCaptureValues = ["steps", "actions", "console", "errors", "html", "network", "performance", "memory", "screenshot", "dom-snapshot"] as const
const editorCaptureValues = ["steps", "console", "errors", "html", "screenshot", "editor-state"] as const

const browserProbeValidation: CommandValidationDescriptor = {
  requiredArgs: [
    { name: "url", code: "missing-url", message: "wordpress.browser-probe requires url=<path-or-url>." },
  ],
  argRules: [
    { name: "wait-for", kind: "enum", values: ["domcontentloaded", "load", "networkidle", "duration"], prefixes: ["selector:"], code: "invalid-wait-for", message: "wordpress.browser-probe wait-for must be domcontentloaded, load, networkidle, selector:<selector>, or duration." },
    { name: "duration", kind: "duration", code: "invalid-duration", message: "wordpress.browser-probe duration must look like 500ms or 2s." },
    { name: "stall-timeout", kind: "duration", code: "invalid-stall-timeout", message: "wordpress.browser-probe stall-timeout must look like 500ms or 2s." },
    { name: "fail-fast", kind: "boolean", code: "invalid-fail-fast", message: "wordpress.browser-probe fail-fast must be true or false." },
    { name: "repeat", kind: "positive-integer", code: "invalid-repeat", message: "wordpress.browser-probe repeat must be a positive integer." },
    { name: "reset-between", kind: "enum", values: ["none", "reload", "new-page"], code: "invalid-reset-between", message: "wordpress.browser-probe reset-between must be none, reload, or new-page." },
    { name: "profiles", kind: "comma-list-enum", values: BROWSER_PROBE_CHROMIUM_PROFILE_IDS, code: "invalid-profile", message: "wordpress.browser-probe profile is unsupported" },
    { name: "profile", kind: "enum", values: BROWSER_PROBE_CHROMIUM_PROFILE_IDS, code: "invalid-profile", message: "wordpress.browser-probe profile is unsupported" },
    { name: "throttle", kind: "enum", values: ["none", ...BROWSER_PROBE_THROTTLE_PROFILE_IDS], code: "invalid-throttle", message: "wordpress.browser-probe throttle is unsupported" },
    { name: "browser", kind: "enum", values: BROWSER_PROBE_BROWSER_VALUES, code: "invalid-browser", message: `wordpress.browser-probe browser must be ${BROWSER_PROBE_BROWSER_VALUES.join(" or ")}.` },
    { name: "viewport", kind: "viewport", code: "invalid-viewport", message: "wordpress.browser-probe viewport must use <width>x<height>, for example 390x844." },
    { name: "capture", kind: "comma-list-enum", values: BROWSER_PROBE_CAPTURE_VALUES, code: "invalid-capture", message: "wordpress.browser-probe capture does not support" },
  ],
}

const browserActionsValidation: CommandValidationDescriptor = {
  requiredAnyArgs: [
    { names: ["steps-json", "url"], code: "missing-steps", message: "wordpress.browser-actions requires steps-json=<array> or url=<path-or-url>." },
  ],
  argRules: [
    { name: "step-timeout", kind: "duration", code: "invalid-duration", message: "wordpress.browser-actions step-timeout must look like 500ms or 2s." },
    { name: "timeout", kind: "duration", code: "invalid-duration", message: "wordpress.browser-actions timeout must look like 500ms or 2s." },
    { name: "capture", kind: "comma-list-enum", values: browserActionCaptureValues, code: "invalid-capture", message: "wordpress.browser-actions capture does not support" },
  ],
}

const browserScenarioValidation: CommandValidationDescriptor = {
  requiredAnyArgs: [
    { names: ["scenario-json", "url"], code: "missing-scenario", message: "wordpress.browser-scenario requires scenario-json=<object> or url=<path-or-url>." },
  ],
  argRules: [
    { name: "step-timeout", kind: "duration", code: "invalid-duration", message: "wordpress.browser-scenario step-timeout must look like 500ms or 2s." },
    { name: "timeout", kind: "duration", code: "invalid-duration", message: "wordpress.browser-scenario timeout must look like 500ms or 2s." },
    { name: "capture", kind: "comma-list-enum", values: browserScenarioCaptureValues, code: "invalid-capture", message: "wordpress.browser-scenario capture does not support" },
  ],
}

const editorActionsValidation: CommandValidationDescriptor = {
  requiredArgs: [
    { name: "steps-json", code: "missing-steps", message: "wordpress.editor-actions requires steps-json=<array>." },
  ],
  argRules: [
    { name: "wait-timeout", kind: "duration", code: "invalid-duration", message: "wordpress.editor-actions wait-timeout must look like 500ms or 2s." },
    { name: "step-timeout", kind: "duration", code: "invalid-duration", message: "wordpress.editor-actions step-timeout must look like 500ms or 2s." },
    { name: "timeout", kind: "duration", code: "invalid-duration", message: "wordpress.editor-actions timeout must look like 500ms or 2s." },
    { name: "capture", kind: "comma-list-enum", values: editorCaptureValues, code: "invalid-capture", message: "wordpress.editor-actions capture does not support" },
  ],
}

export const commandRegistry = [
  {
    id: "inspect-mounted-inputs",
    description: "List mounted input entries visible inside the Playground runtime.",
    acceptedArgs: [],
    outputShape: "JSON array of mounted input descriptors.",
    policyRequirement: "Runtime policy commands must include inspect-mounted-inputs.",
    recipe: true,
    handler: { kind: "playground", method: "inspectMountedInputs" },
  },
  {
    id: "command-agent-run",
    description: "Run one declared runtime command through a generic command-agent envelope and capture stdout, stderr, exit status, JSON output, metadata, diagnostics, environment names, and artifact refs.",
    acceptedArgs: [
      { name: "command", description: "Declared runtime command id to execute. The target command must also be allowed by runtime policy.", required: true, format: "string" },
      { name: "args-json", description: "Target command arguments as a JSON array of strings.", format: "JSON array" },
      { name: "parse-json", description: "Parse target stdout as JSON and include it as json in the result envelope.", format: "boolean" },
      { name: "session-id", description: "Optional caller session id recorded as metadata only.", format: "string" },
      { name: "correlation-id", description: "Optional caller correlation id recorded as metadata only.", format: "string" },
      { name: "session-metadata-json", description: "Optional non-secret session metadata object.", format: "JSON object" },
      { name: "auth-required", description: "When true, auth-context-json must be supplied; auth values are never emitted.", format: "boolean" },
      { name: "auth-context-json", description: "Optional non-secret auth context object. Only object keys are emitted in results.", format: "JSON object" },
    ],
    outputShape: "wp-codebox/command-agent-run/v1 JSON envelope with target command, stdout, stderr, exitCode, status, optional parsed JSON, session/correlation metadata, auth context keys, environment names, diagnostics, and artifact refs.",
    outputSchema: objectEnvelopeSchema("wp-codebox/command-agent-run/v1", {
      target: { type: "object" },
      exitCode: { type: "integer" },
      stdout: { type: "string" },
      stderr: { type: "string" },
      diagnostics: { type: "object" },
      artifactRefs: { type: "array" },
    }),
    policyRequirement: "Runtime policy commands must include command-agent-run and the target command.",
    recipe: true,
    handler: { kind: "playground", method: "runCommandAgent" },
  },
  {
    id: "wordpress.run-php",
    description: "Run PHP against WordPress, bootstrapping wp-load.php unless bootstrap=none is supplied.",
    acceptedArgs: [
      { name: "code", description: "Inline PHP code to run.", format: "PHP string" },
      { name: "code-file", description: "Path to a PHP file whose contents should run.", format: "path" },
      { name: "bootstrap", description: "Use bootstrap=none to skip wp-load.php.", format: "wordpress|none" },
      { name: "capture-diagnostics", description: "Opt-in comma-separated bounded diagnostics capture. Currently supports wpdb-queries.", format: "comma-separated enum" },
      { name: "diagnostics-max-items", description: "Maximum diagnostic records to keep. Defaults to 50 and is capped at 500.", format: "positive integer" },
      { name: "diagnostics-max-bytes", description: "Maximum serialized diagnostics bytes to keep. Defaults to 65536 and is capped at 524288.", format: "positive integer" },
    ],
    outputShape: "Raw command stdout from the PHP snippet.",
    policyRequirement: "Runtime policy commands must include wordpress.run-php.",
    recipe: true,
    handler: { kind: "playground", method: "runPhp" },
  },
  {
    id: "wordpress.wp-cli",
    description: "Run a WP-CLI command inside the same disposable WordPress runtime.",
    acceptedArgs: [
      { name: "command", description: "WP-CLI command line, with or without the leading wp token.", required: true, format: "string" },
    ],
    outputShape: "Raw WP-CLI stdout.",
    policyRequirement: "Runtime policy commands must include wordpress.wp-cli.",
    recipe: true,
    handler: { kind: "playground", method: "runWpCli" },
  },
  {
    id: "wordpress.export-browser-storage-state",
    description: "Export reusable Playwright browser storageState JSON for a generic WordPress fixture user and record reviewer-safe metadata.",
    acceptedArgs: [
      { name: "storage-state", description: "Optional Playwright storageState JSON, wp-codebox storage-state envelope, or @<path> to JSON to materialize as a reusable artifact. When omitted, WP Codebox exports a WordPress fixture-user storage state.", format: "JSON object or @path" },
      { name: "browser-urls", description: "Comma-separated browser origins or URLs whose hosts should receive WordPress auth cookies. Defaults to the runtime preview URL.", format: "comma-separated URLs" },
      { name: "user-json", description: "Optional fixture user object with userId, username, email, role, displayName, or password fields.", format: "JSON object" },
      { name: "output-dir", description: "Optional artifact directory relative to the runtime artifact root; defaults to files/browser-storage-state.", format: "relative path" },
    ],
    outputShape: "wp-codebox/browser-storage-state-export/v1 JSON with storageState and summary artifact refs plus redacted schema/kind, user, cookie host counts, origin count, and diagnostics.",
    outputSchema: artifactSummarySchema("wp-codebox/browser-storage-state-export/v1", {
      storageState: { type: "string" },
      summary: { type: "string" },
    }),
    policyRequirement: "Runtime policy commands must include wordpress.export-browser-storage-state.",
    recipe: true,
    handler: { kind: "playground", method: "runExportBrowserStorageState" },
  },
  {
    id: "wordpress.capture-state-bundle",
    description: "Capture the current WordPress runtime state as a portable state bundle source for replayable Playground artifacts.",
    acceptedArgs: [
      { name: "label", description: "Optional human-readable capture label recorded in the command output.", format: "string" },
      ...snapshotScopingAcceptedArgs,
    ],
    outputShape: "wp-codebox/wordpress-state-bundle-capture/v1 JSON with runtime snapshot id, artifact refs, replay status, and capture summary.",
    outputSchema: artifactSummarySchema("wp-codebox/wordpress-state-bundle-capture/v1", {
      runtimeSnapshot: { type: "string" },
      manifest: { type: "string" },
    }),
    policyRequirement: "Runtime policy commands must include wordpress.capture-state-bundle.",
    recipe: true,
    handler: { kind: "playground", method: "runCaptureStateBundle" },
  },
  {
    id: "wordpress.export-replay-package",
    description: "Export the current imported WordPress runtime as a replay package with a compact blueprint, external runtime snapshot, notes, manifest, and metrics.",
    acceptedArgs: [
      { name: "label", description: "Optional human-readable export label recorded in the command output and package source metadata.", format: "string" },
      { name: "output-dir", description: "Optional package directory relative to the runtime artifact root; defaults to files/replay-package.", format: "relative path" },
      { name: "landing-page", description: "Optional replay landing page recorded in blueprint.after.json.", format: "path" },
      { name: "import-ms", description: "Optional importer duration supplied by the caller so replay export metrics can include the preceding import phase.", format: "non-negative integer" },
      ...snapshotScopingAcceptedArgs,
    ],
    outputShape: "wp-codebox/wordpress-replay-export/v1 JSON with import/materialization/snapshot/export metrics and manifest, blueprint.after.json, blueprint.after-notes.json, and files/runtime-snapshot.json artifact paths.",
    outputSchema: artifactSummarySchema("wp-codebox/wordpress-replay-export/v1", {
      manifest: { type: "string" },
      blueprint: { type: "string" },
      runtimeSnapshot: { type: "string" },
    }),
    policyRequirement: "Runtime policy commands must include wordpress.export-replay-package.",
    recipe: true,
    handler: { kind: "playground", method: "runExportReplayPackage" },
  },
  {
    id: "wp-codebox.checkpoint-create",
    description: "Create a named runtime checkpoint for later restore within the same recipe run.",
    acceptedArgs: [
      { name: "name", description: "Checkpoint name. Use letters, numbers, dots, underscores, or hyphens.", required: true, format: "string" },
      { name: "metadata-json", description: "Optional non-secret JSON object recorded on the checkpoint metadata.", format: "JSON object" },
      ...snapshotScopingAcceptedArgs,
    ],
    outputShape: "wp-codebox/runtime-checkpoint-result/v1 JSON with checkpoint name, snapshot id, created timestamp, summary, and metadata.",
    outputSchema: objectEnvelopeSchema("wp-codebox/runtime-checkpoint-result/v1", {
      operation: { const: "create" },
      checkpoint: { type: "object" },
    }),
    policyRequirement: "Host-side recipe helper; supported runtime backends create a same-run checkpoint, unsupported backends fail closed with structured diagnostics.",
    recipe: true,
    handler: { kind: "recipe-alias", command: "wp-codebox.checkpoint-create" },
  },
  {
    id: "wp-codebox.checkpoint-restore",
    description: "Restore a previously created named runtime checkpoint within the same recipe run.",
    acceptedArgs: [
      { name: "name", description: "Checkpoint name to restore.", required: true, format: "string" },
    ],
    outputShape: "wp-codebox/runtime-checkpoint-result/v1 JSON with restored checkpoint metadata.",
    outputSchema: objectEnvelopeSchema("wp-codebox/runtime-checkpoint-result/v1", {
      operation: { const: "restore" },
      checkpoint: { type: "object" },
    }),
    policyRequirement: "Host-side recipe helper; supported runtime backends restore a same-run checkpoint, unsupported backends fail closed with structured diagnostics.",
    recipe: true,
    handler: { kind: "recipe-alias", command: "wp-codebox.checkpoint-restore" },
  },
  {
    id: "wp-codebox.checkpoint-list",
    description: "List named runtime checkpoints created during the current recipe run.",
    acceptedArgs: [],
    outputShape: "wp-codebox/runtime-checkpoint-result/v1 JSON with checkpoint metadata entries.",
    outputSchema: objectEnvelopeSchema("wp-codebox/runtime-checkpoint-result/v1", {
      operation: { const: "list" },
      checkpoints: { type: "array" },
    }),
    policyRequirement: "Host-side recipe helper; supported runtime backends list same-run checkpoints, unsupported backends fail closed with structured diagnostics.",
    recipe: true,
    handler: { kind: "recipe-alias", command: "wp-codebox.checkpoint-list" },
  },
  {
    id: "wordpress.ability",
    description: "Execute a registered WordPress Ability in the sandbox.",
    acceptedArgs: [
      { name: "name", description: "Ability name to execute.", required: true, format: "string" },
      { name: "input", description: "Ability input payload.", format: "JSON object" },
      { name: "expected-result-schema", description: "Optional schema id (or JSON schema with $id/const) the ability result envelope must report.", format: "JSON string or object" },
    ],
    outputShape: "JSON object with command, name, input, and result fields. When expected-result-schema is supplied, returns wp-codebox/generic-ability-runtime-run-result/v1 with resultEnvelope/evidenceEnvelope fields and fails on schema mismatch.",
    policyRequirement: "Runtime policy commands must include wordpress.ability.",
    recipe: true,
    handler: { kind: "playground", method: "runAbility" },
  },
  {
    id: "wordpress.http-request",
    description: "Execute a generic HTTP request against the live runtime preview or an absolute URL.",
    acceptedArgs: [
      { name: "method", description: "HTTP method for the request; defaults to GET.", format: "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS" },
      { name: "url", description: "Preview path or absolute URL to request.", required: true, format: "path or URL" },
      { name: "headers-json", description: "Optional request headers object.", format: "JSON object" },
      { name: "body", description: "Optional raw request body.", format: "string" },
      { name: "expect-status", description: "Optional expected HTTP status; the command fails when the response status differs.", format: "HTTP status code" },
    ],
    outputShape: "JSON object with command, method, url, resolvedUrl, status, headers, bodyBytes, timing, and diagnostics.",
    policyRequirement: "Runtime policy commands must include wordpress.http-request.",
    recipe: true,
    handler: { kind: "playground", method: "runHttpRequest" },
  },
  {
    id: "wordpress.rest-request",
    description: "Execute an in-process WordPress REST request with WP_REST_Request and rest_do_request().",
    acceptedArgs: [
      { name: "method", description: "HTTP method for the REST request; defaults to GET.", format: "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS" },
      { name: "path", description: "REST route path, with or without the /wp-json prefix.", required: true, format: "REST route path" },
      { name: "headers-json", description: "Optional request headers object.", format: "JSON object" },
      { name: "params-json", description: "Optional request parameters object.", format: "JSON object" },
      { name: "body", description: "Optional raw request body.", format: "string" },
      { name: "body-json", description: "Optional JSON request body string; takes precedence over body.", format: "JSON string" },
      { name: "user", description: "Named fixture user from recipe inputs.fixtureUsers to resolve before running the REST request.", format: "fixture user name" },
      { name: "session", description: "Named user session from recipe inputs.userSessions to resolve before running the REST request.", format: "user session name" },
    ],
    outputShape: "JSON object with command, method, path, route, status, headers, body/data, optional safe userSession metadata, timing, and diagnostics.",
    policyRequirement: "Runtime policy commands must include wordpress.rest-request.",
    recipe: true,
    handler: { kind: "playground", method: "runRestRequest" },
  },
  {
    id: "wordpress.runtime-discovery",
    description: "Discover product-neutral WordPress runtime surfaces using registered WordPress APIs and bounded summaries.",
    acceptedArgs: [
      { name: "surface", description: "Comma-separated surfaces to include. Defaults to all supported surfaces.", format: "rest,admin,database,frontend,blocks" },
    ],
    outputShape: "wp-codebox/wordpress-runtime-discovery/v1 JSON with selected REST routes, admin pages, database schema, frontend rewrite routes, and block/editor target summaries.",
    outputSchema: objectEnvelopeSchema("wp-codebox/wordpress-runtime-discovery/v1", {
      surfaces: { type: "array" },
      rest: { type: "object" },
      admin: { type: "object" },
      database: { type: "object" },
      frontend: { type: "object" },
      blocks: { type: "object" },
      diagnostics: { type: "array" },
    }),
    policyRequirement: "Runtime policy commands must include wordpress.runtime-discovery.",
    recipe: true,
    handler: { kind: "playground", method: "runRuntimeDiscovery" },
  },
  {
    id: "wordpress.bench",
    description: "Run plugin benchmark workloads and emit a versioned benchmark results envelope.",
    acceptedArgs: [
      { name: "component-id", description: "Component id for the benchmark results envelope.", format: "string" },
      { name: "plugin-slug", description: "Plugin slug containing tests/bench workloads.", required: true, format: "slug" },
      { name: "iterations", description: "Measured iterations per workload.", format: "positive integer" },
      { name: "warmup", description: "Warmup iterations before measurement.", format: "non-negative integer" },
      { name: "dependency-slugs", description: "Comma-separated plugin dependency slugs to load.", format: "comma-separated slugs" },
      { name: "env-json", description: "Benchmark environment object.", format: "JSON object" },
      { name: "bootstrap-files-json", description: "Component-relative bootstrap file fallbacks; the first existing file is loaded before workloads execute.", format: "JSON array" },
      { name: "workloads-json", description: "Explicit workload list. Configured workload steps support php, ability, wp-cli, and rest-request mechanics.", format: "JSON array" },
      { name: "scenario-ids-json", description: "Optional selected benchmark scenario ids. Filters both discovered tests/bench workloads and explicit workloads by id.", format: "JSON array" },
      { name: "lifecycle-json", description: "Generic benchmark lifecycle hooks keyed by setup, prepare, warmup, measure, or teardown. Hook entries use the same php/ability/wp-cli step format as configured workloads.", format: "JSON object" },
      { name: "reset-policy-json", description: "Explicit benchmark reset policy. Supports betweenIterations and betweenScenarios modes: none or object-cache.", format: "JSON object" },
    ],
    outputShape: "wp-codebox/bench-results/v1 JSON envelope with typed scenarios, metrics, diagnostics, artifacts, and provenance.",
    outputSchema: objectEnvelopeSchema("wp-codebox/bench-results/v1", {
      scenarios: { type: "array" },
      diagnostics: { type: "array" },
      artifacts: { type: "object" },
      provenance: { type: "object" },
    }),
    policyRequirement: "Runtime policy commands must include wordpress.bench.",
    recipe: true,
    handler: { kind: "playground", method: "runBench" },
  },
  {
    id: "wordpress.phpunit",
    description: "Run plugin PHPUnit tests with normalized diagnostics and test-result artifact capture.",
    acceptedArgs: [
      { name: "plugin-slug", description: "Plugin slug under wp-content/plugins.", format: "slug" },
      { name: "cwd", description: "Sandbox working directory for the PHPUnit process. Relative values resolve inside the mounted plugin directory; defaults to wp-content/plugins/<plugin-slug>.", format: "sandbox path" },
      { name: "code", description: "Inline override PHP runner code.", format: "PHP string" },
      { name: "code-file", description: "Path to override PHP runner code.", format: "path" },
      { name: "autoload-file", description: "PHPUnit/vendor autoload path inside the sandbox.", format: "sandbox path" },
      { name: "tests-dir", description: "WP PHPUnit tests directory inside the sandbox.", format: "sandbox path" },
      { name: "phpunit-xml", description: "phpunit.xml path inside the plugin.", format: "path" },
      { name: "test-file", description: "Single test file to run.", format: "path" },
      { name: "changed-tests-json", description: "Changed test files for diagnostics.", format: "JSON array" },
      { name: "env-json", description: "PHPUnit environment values.", format: "JSON object" },
      { name: "wp-config-defines-json", description: "wp-config.php constants for the run.", format: "JSON object" },
      { name: "dependency-mounts", description: "Comma-separated mounted dependency paths.", format: "comma-separated sandbox paths" },
      { name: "bootstrap-files-json", description: "Plugin-relative bootstrap file fallbacks loaded in managed mode after wp-phpunit fixtures.", format: "JSON array" },
      { name: "phpunit-args-json", description: "Structured PHPUnit CLI arguments such as [\"--filter\", \"MyTest::test_case\"].", format: "JSON array" },
      { name: "bootstrap-mode", description: "Bootstrap strategy: managed keeps WP Codebox-owned setup; project requires the plugin's native PHPUnit bootstrap.", format: "managed|project" },
      { name: "project-bootstrap", description: "Plugin-relative PHPUnit bootstrap path used when bootstrap-mode=project. If omitted, the phpunit.xml bootstrap attribute is used.", format: "relative path" },
      { name: "multisite", description: "Run as multisite.", format: "boolean" },
    ],
    outputShape: "Raw PHPUnit runner JSON/log output plus normalized test-results artifact when artifacts are collected.",
    policyRequirement: "Runtime policy commands must include wordpress.phpunit.",
    recipe: true,
    handler: { kind: "playground", method: "runPhpunit" },
  },
  {
    id: "wordpress.plugin-check",
    description: "Run the official WordPress Plugin Check plugin against a mounted plugin and emit normalized findings.",
    acceptedArgs: [
      { name: "plugin-slug", description: "Plugin slug under wp-content/plugins to validate.", required: true, format: "slug" },
      { name: "checks", description: "Optional comma-separated official Plugin Check slugs to run; omit to run the default suite.", format: "comma-separated check slugs" },
    ],
    outputShape: "wp-codebox/plugin-check/v1 JSON with command, target plugin, exit code/status, summary counts, and findings; raw and normalized outputs are captured in artifacts.",
    outputSchema: objectEnvelopeSchema("wp-codebox/plugin-check/v1", {
      summary: { type: "object" },
      findings: { type: "array" },
    }),
    policyRequirement: "Runtime policy commands must include wordpress.plugin-check.",
    recipe: true,
    handler: { kind: "playground", method: "runPluginCheck" },
  },
  {
    id: "wordpress.plugin-state",
    description: "Report, activate, or deactivate an installed WordPress plugin by slug, plugin file, or plugin path using WordPress plugin APIs and a structured result envelope.",
    acceptedArgs: [
      { name: "action", description: "Plugin state action. Defaults to report; status is accepted as an alias for report.", format: "report|status|activate|deactivate" },
      { name: "plugin", description: "Plugin target as slug, plugin file, wp-content/plugins-relative file, or absolute plugin path.", format: "slug|plugin-file|path" },
      { name: "slug", description: "Plugin slug target. Used when plugin is omitted.", format: "slug" },
      { name: "file", description: "Plugin file target such as akismet/akismet.php. Used when plugin and slug are omitted.", format: "plugin-file" },
      { name: "path", description: "Absolute or wp-content/plugins-relative plugin file/directory path. Used when plugin, slug, and file are omitted.", format: "path" },
      { name: "network", description: "When true, activate or deactivate network-wide on multisite runtimes. Non-multisite runtimes return a structured unsupported error.", format: "boolean" },
    ],
    outputShape: "wp-codebox/wordpress-plugin-state/v1 JSON with command, action, status, target plugin identity, before/after active plugin lists, multisite/network support note, diagnostics, errors, and artifactRefs.",
    outputSchema: objectEnvelopeSchema("wp-codebox/wordpress-plugin-state/v1", {
      action: { type: "string" },
      target: { type: "object" },
      activePluginsBefore: { type: "array" },
      activePluginsAfter: { type: "array" },
      networkActivePluginsBefore: { type: "array" },
      networkActivePluginsAfter: { type: "array" },
      multisite: { type: "object" },
      diagnostics: { type: "array" },
      errors: { type: "array" },
      artifactRefs: { type: "array" },
    }),
    policyRequirement: "Runtime policy commands must include wordpress.plugin-state.",
    recipe: true,
    handler: { kind: "playground", method: "runPluginState" },
  },
  {
    id: "wordpress.core-phpunit",
    description: "Run WordPress core PHPUnit tests with normalized diagnostics and test-result artifact capture. PRECONDITION: the mounted wordpress-develop checkout MUST already have Composer dev dependencies installed (PHPUnit + yoast/phpunit-polyfills under vendor/) before mounting, because core's tests/phpunit/includes/bootstrap.php die()s without them. Run `composer install` (or `composer update -W`) in the checkout first, or mount one that already has vendor/. When the toolchain is missing the command now fails with a clear structured error instead of crashing silently.",
    acceptedArgs: [
      { name: "core-root", description: "WordPress develop checkout root inside the sandbox. Must contain vendor/ with Composer dev dependencies (PHPUnit + yoast/phpunit-polyfills) installed before mounting.", format: "sandbox path" },
      { name: "tests-dir", description: "Core tests directory inside the sandbox (expects includes/bootstrap.php under it).", format: "sandbox path" },
      { name: "phpunit-xml", description: "phpunit.xml path.", format: "path" },
      { name: "test-file", description: "Single test file to run.", format: "path" },
      { name: "changed-tests-json", description: "Changed test files for diagnostics.", format: "JSON array" },
      { name: "autoload-file", description: "Autoload path inside the sandbox (typically <core-root>/vendor/autoload.php from a completed composer install).", format: "sandbox path" },
      { name: "wp-config-defines-json", description: "wp-config.php constants for the run.", format: "JSON object" },
      { name: "multisite", description: "Run as multisite.", format: "boolean" },
    ],
    outputShape: "Raw PHPUnit runner JSON/log output plus normalized test-results artifact when artifacts are collected.",
    policyRequirement: "Runtime policy commands must include wordpress.core-phpunit.",
    recipe: true,
    handler: { kind: "playground", method: "runCorePhpunit" },
  },
  {
    id: "wordpress.theme-check",
    description: "Run Theme Check against a mounted WordPress theme inside the disposable Playground runtime.",
    acceptedArgs: [
      { name: "theme", description: "Theme slug under wp-content/themes.", required: true, format: "slug" },
    ],
    outputShape: "Normalized Theme Check JSON plus files/theme-check raw and normalized artifacts.",
    policyRequirement: "Runtime policy commands must include wordpress.theme-check.",
    recipe: true,
    handler: { kind: "playground", method: "runThemeCheck" },
  },
  {
    id: "wordpress.browser-probe",
    description: "Open the live Playground preview in Playwright and capture generic browser replay/audit evidence artifacts.",
    acceptedArgs: BROWSER_PROBE_ACCEPTED_ARGS,
    outputShape: "JSON summary with requested/effective browser context details plus assertion results and files/browser/console.jsonl, errors.jsonl, network.jsonl, performance.json, memory.json, checkpoints.jsonl, snapshot.html, summary.json, and screenshot.png when captured.",
    policyRequirement: "Runtime policy commands must include wordpress.browser-probe.",
    validation: browserProbeValidation,
    recipe: true,
    handler: { kind: "playground", method: "runBrowserProbe" },
  },
  {
    id: "wordpress.capture-html",
    description: "Open the live Playground preview in Playwright and capture rendered HTML plus generic browser diagnostics as Codebox artifact refs.",
    acceptedArgs: [
      { name: "url", description: "Preview path or absolute URL to visit.", required: true, format: "path or URL" },
      { name: "wait-for", description: "Navigation wait condition.", format: "domcontentloaded|load|networkidle|selector:<selector>|duration" },
      { name: "duration", description: "Extra capture duration, or wait time when wait-for=duration.", format: "duration, e.g. 2s or 500ms" },
      { name: "pre-page-script", description: "Optional JavaScript installed before navigation so page scripts can observe mocked browser/payment capabilities.", format: "JavaScript source" },
      { name: "script", description: "Optional page-side JavaScript to evaluate after navigation and before final capture.", format: "JavaScript function body" },
      { name: "capture", description: "Comma-separated artifacts to capture; defaults to html,console,errors,network.", format: "console,errors,html,network,performance,memory,screenshot" },
    ],
    outputShape: "JSON summary plus files/browser/snapshot.html, console.jsonl, errors.jsonl, network.jsonl, and summary.json by default; optional screenshot/performance/memory artifacts when requested.",
    policyRequirement: "Runtime policy commands must include wordpress.capture-html.",
    recipe: true,
    handler: { kind: "playground", method: "runHtmlCapture" },
  },
  {
    id: "wordpress.editor-canvas-probe",
    description: "Open a WordPress editor URL and wait for the iframe-backed block canvas to become visible, non-loading, and populated before capturing selector diagnostics and optional canvas screenshot evidence.",
    acceptedArgs: [
      { name: "url", description: "Editor path or absolute URL to visit.", required: true, format: "path or URL" },
      { name: "iframe-selector", description: "Editor canvas iframe selector; defaults to iframe[name=\"editor-canvas\"].", format: "CSS selector" },
      { name: "layout-selector", description: "Canvas layout selector inside the editor iframe; defaults to .block-editor-block-list__layout.", format: "CSS selector" },
      { name: "block-selector", description: "Block selector inside the editor canvas layout; defaults to .block-editor-block-list__block, [data-block].", format: "CSS selector" },
      { name: "timeout-ms", description: "Readiness timeout in milliseconds; defaults to 30000.", format: "milliseconds" },
      { name: "capture", description: "Comma-separated optional artifacts to capture.", format: "screenshot" },
      { name: "selector-groups-json", description: "Optional selector summary groups evaluated inside the editor iframe. Each group supports name plus selector or selectors.", format: "JSON array" },
    ],
    outputShape: "JSON summary plus files/browser/editor-canvas-summary.json and optional files/browser/editor-canvas-screenshot.png, including readyMs, selector summary, and diagnostics for missing iframe/layout/blocks or loading state.",
    policyRequirement: "Runtime policy commands must include wordpress.editor-canvas-probe.",
    recipe: true,
    handler: { kind: "playground", method: "runEditorCanvasProbe" },
  },
  {
    id: "wordpress.browser-actions",
    description: "Drive the live Playground preview with an ordered interaction script and capture replay/audit evidence artifacts, including per-step results and machine-readable assertions.",
    acceptedArgs: [
      { name: "url", description: "Initial preview path or absolute URL to visit when the script omits an initial navigate step.", format: "path or URL" },
      { name: "steps-json", description: "Ordered interaction script: navigate, click, fill, type, press, drag, hover, select, waitFor, evaluate, expect, screenshot, and capture steps. waitFor and screenshot steps support generic painted-readiness waits: painted, frame-painted:<iframe-selector>, and frame-url-painted:<url-fragment>.", format: "JSON array (inline or @<path>)" },
      { name: "step-timeout", description: "Per-step timeout applied to each interaction step.", format: "duration, e.g. 5s or 500ms" },
      { name: "timeout", description: "Total-script timeout bounding the whole interaction run.", format: "duration, e.g. 30s or 1500ms" },
      { name: "auth", description: "Optional in-memory browser authentication mode. Use wordpress-admin to bootstrap WordPress admin cookies from PHP without writing token-bearing storage-state artifacts.", format: "wordpress-admin" },
      { name: "auth-user-id", description: "WordPress user ID used with auth=wordpress-admin; defaults to 1.", format: "positive integer" },
      { name: "storage-state", description: "Optional Playwright storageState JSON, or @<path> to JSON, imported into a fresh browser context. Summaries redact cookie/localStorage values and report only schema/kind, counts, hosts, and diagnostics.", format: "JSON object or @path" },
      { name: "capture", description: "Comma-separated artifacts to capture after interactions.", format: "steps,console,errors,html,network,screenshot,dom-snapshot" },
      { name: "max-dom-snapshot-elements", description: "Maximum visible elements captured in each screenshot sidecar DOM/style snapshot; defaults to 160.", format: "positive integer" },
    ],
    outputShape: "JSON summary plus files/browser/steps.jsonl, action-summary.json (with assertions pass/fail), named screenshots, sidecar DOM/style snapshots, and optional console/errors/network/html/screenshot artifacts.",
    policyRequirement: "Runtime policy commands must include wordpress.browser-actions. The evaluate step additionally requires wordpress.browser-actions.evaluate.",
    validation: browserActionsValidation,
    recipe: true,
    handler: { kind: "playground", method: "runBrowserActions" },
  },
  {
    id: "wordpress.browser-scenario",
    description: "Run a declarative browser evidence scenario by composing browser-probe and browser-actions artifacts behind one normalized scenario summary.",
    acceptedArgs: [
      { name: "scenario-json", description: "Declarative scenario object with url, profile, captures, observers, steps, assertions, viewport, and timeout settings. Supports inline JSON or @<path>.", format: "JSON object" },
      { name: "url", description: "Preview path or absolute URL to visit when scenario-json is omitted or does not include url.", format: "path or URL" },
      { name: "steps-json", description: "Optional browser interaction steps when scenario-json.steps is omitted.", format: "JSON array" },
      { name: "capture", description: "Comma-separated artifacts to capture.", format: "steps,console,errors,html,network,performance,memory,screenshot,dom-snapshot" },
      { name: "pre-page-script", description: "Optional JavaScript installed before probe navigation for observer setup.", format: "JavaScript source" },
      { name: "viewport", description: "Browser viewport size.", format: "<width>x<height>" },
      { name: "device", description: "Optional Playwright device profile for the probe phase.", format: "Playwright device name" },
      { name: "locale", description: "Optional browser context locale for the probe phase.", format: "BCP 47 locale" },
      { name: "auth", description: "Optional in-memory browser authentication mode. Use wordpress-admin to bootstrap WordPress admin cookies from PHP without writing token-bearing storage-state artifacts.", format: "wordpress-admin" },
      { name: "auth-user-id", description: "WordPress user ID used with auth=wordpress-admin; defaults to 1.", format: "positive integer" },
      { name: "step-timeout", description: "Per-step timeout applied to action steps.", format: "duration, e.g. 5s or 500ms" },
      { name: "timeout", description: "Total action timeout bounding the interaction run.", format: "duration, e.g. 30s or 1500ms" },
    ],
    outputShape: "JSON scenario summary with requested/effective browser metadata and files/browser/scenario-summary.json, preserving lower-level browser-probe and browser-actions summaries when used.",
    policyRequirement: "Runtime policy commands must include wordpress.browser-scenario. Scenarios using evaluate steps additionally require wordpress.browser-actions.evaluate.",
    validation: browserScenarioValidation,
    recipe: true,
    handler: { kind: "playground", method: "runBrowserScenario" },
  },
  {
    id: "wordpress.visual-compare",
    description: "Compare two browser targets or screenshot files and emit generic visual diff evidence artifacts without applying downstream parity policy.",
    acceptedArgs: [
      { name: "source-url", description: "Source browser target path or absolute URL.", format: "path or URL" },
      { name: "candidate-url", description: "Candidate browser target path or absolute URL.", format: "path or URL" },
      { name: "matrix-json", description: "Optional comparison matrix object with comparisons and optional viewports arrays; each comparison may provide source/candidate targets, labels, viewport, and wait settings.", format: "JSON object" },
      { name: "source-screenshot", description: "Existing source PNG screenshot path on the host.", format: "path" },
      { name: "candidate-screenshot", description: "Existing candidate PNG screenshot path on the host.", format: "path" },
      { name: "source-dom-snapshot", description: "Optional source DOM/style sidecar snapshot path for screenshot-backed visual explanations.", format: "path" },
      { name: "candidate-dom-snapshot", description: "Optional candidate DOM/style sidecar snapshot path for screenshot-backed visual explanations.", format: "path" },
      { name: "baseline", description: "Optional previous visual-diff.json or aggregate visual comparison artifact used to emit evidence-only deltas.", format: "path" },
      { name: "source-label", description: "Human-readable source label.", format: "string" },
      { name: "candidate-label", description: "Human-readable candidate label.", format: "string" },
      { name: "wait-for", description: "Navigation wait condition for URL targets; defaults to domcontentloaded.", format: "domcontentloaded|load|networkidle|selector:<selector>|duration" },
      { name: "duration", description: "Extra capture duration, or wait time when wait-for=duration.", format: "duration, e.g. 2s or 500ms" },
      { name: "viewport", description: "Browser viewport size for URL targets and optional crop ceiling.", format: "<width>x<height>" },
      { name: "full-page", description: "Capture full-page screenshots for URL targets; defaults to true.", format: "boolean" },
      { name: "threshold", description: "Pixelmatch color threshold; defaults to 0.1.", format: "number between 0 and 1" },
      { name: "include-aa", description: "Include anti-aliased pixels in mismatch count; defaults to false.", format: "boolean" },
      { name: "max-regions", description: "Maximum mismatch regions to report; defaults to 8.", format: "positive integer" },
    ],
    outputShape: "wp-codebox/visual-compare/v1 JSON summary plus files/browser/visual-compare/source.png, candidate.png, diff.png, visual-diff.json, visual-explanation.json when DOM/style context is available, and optional baseline delta evidence when a previous visual comparison artifact is supplied. Matrix runs emit wp-codebox/visual-compare-matrix/v1 in files/browser/visual-compare/matrix-summary.json plus per-comparison subdirectories.",
    outputSchema: objectEnvelopeSchema("wp-codebox/visual-compare/v1", {
      summary: { type: "object" },
      artifacts: { type: "object" },
    }),
    policyRequirement: "Runtime policy commands must include wordpress.visual-compare.",
    recipe: true,
    handler: { kind: "playground", method: "runVisualCompare" },
  },
  {
    id: "wordpress.editor-open",
    description: "Open a generic WordPress block editor target and capture replayable editor evidence artifacts.",
    acceptedArgs: [
      { name: "target", description: "Editor target to open; defaults to post-new.", format: "post-new|site" },
      { name: "post-id", description: "Existing post ID to open in the post editor.", format: "positive integer" },
      { name: "post-type", description: "Post type for post-new or post-id targets; defaults to post.", format: "post type slug" },
      { name: "url", description: "Explicit editor path or absolute URL to open instead of resolving a target.", format: "path or URL" },
      { name: "wait-selector", description: "Selector that marks the editor as ready; defaults to the block editor shell.", format: "CSS selector" },
      { name: "wait-timeout", description: "Timeout for navigation and editor-ready waits.", format: "duration, e.g. 15s or 500ms" },
      { name: "capture", description: "Comma-separated artifacts to capture after opening the editor.", format: "steps,console,errors,html,screenshot,editor-state" },
    ],
    outputShape: "JSON summary plus files/browser/editor-steps.jsonl, editor-summary.json, editor-state.json, and optional console/errors/html/screenshot artifacts.",
    policyRequirement: "Runtime policy commands must include wordpress.editor-open.",
    recipe: true,
    handler: { kind: "playground", method: "runEditorOpen" },
  },
  {
    id: "wordpress.editor-actions",
    description: "Open a generic WordPress block editor target, run a bounded editor action script, and capture replayable mutation evidence artifacts.",
    acceptedArgs: [
      { name: "target", description: "Editor target to open; defaults to post-new.", format: "post-new|site" },
      { name: "post-id", description: "Existing post ID to open in the post editor.", format: "positive integer" },
      { name: "post-type", description: "Post type for post-new or post-id targets; defaults to post.", format: "post type slug" },
      { name: "url", description: "Explicit editor path or absolute URL to open instead of resolving a target.", format: "path or URL" },
      { name: "steps-json", description: "Ordered editor action script: open, waitForReady, insertBlock, selectBlock, savePost, and inspectState. savePost uses Gutenberg core/editor.savePost and reports typed editorSave diagnostics.", required: true, format: "JSON array (inline or @<path>)" },
      { name: "wait-selector", description: "Selector that marks the editor as ready; defaults to the block editor shell.", format: "CSS selector" },
      { name: "wait-timeout", description: "Timeout for navigation and editor-ready waits.", format: "duration, e.g. 15s or 500ms" },
      { name: "step-timeout", description: "Per-action timeout applied to each editor action step.", format: "duration, e.g. 15s or 500ms" },
      { name: "timeout", description: "Total-script timeout bounding the whole editor action run.", format: "duration, e.g. 30s or 1500ms" },
      { name: "capture", description: "Comma-separated artifacts to capture after actions.", format: "steps,console,errors,html,screenshot,editor-state" },
    ],
    outputShape: "JSON summary plus files/browser/editor-action-steps.jsonl, editor-action-summary.json, editor-action-state.json, and optional console/errors/html/screenshot artifacts.",
    policyRequirement: "Runtime policy commands must include wordpress.editor-actions.",
    validation: editorActionsValidation,
    recipe: true,
    handler: { kind: "playground", method: "runEditorActions" },
  },
  {
    id: "wordpress.browser-actions.evaluate",
    description: "Policy capability gating arbitrary page-side JavaScript (the evaluate step) inside wordpress.browser-actions. Non-JS interaction steps do not require this capability.",
    acceptedArgs: [],
    outputShape: "Policy-only capability; not directly executable. Grant alongside wordpress.browser-actions to permit evaluate steps.",
    policyRequirement: "Runtime policy commands must include wordpress.browser-actions.evaluate to run evaluate steps.",
    recipe: false,
    handler: { kind: "recipe-alias", command: "wordpress.browser-actions" },
  },
  {
    id: "wp-codebox.agent-runtime-probe",
    description: "Recipe-only probe that boots mounted agent runtime components and verifies the stack loads.",
    acceptedArgs: [
      { name: "component", description: "Repeated generic runtime component contract: source path plus optional slug, pluginFile, loadAs. Prefer this over component-specific flags.", format: "path[,slug=<slug>,pluginFile=<slug/file.php>,loadAs=plugin|mu-plugin]" },
      { name: "provider-plugin-slugs", description: "Comma-separated provider plugin slugs already mounted by recipe inputs.", format: "comma-separated slugs" },
      { name: "provider-plugin-contracts-json", description: "Resolved provider plugin entrypoint contracts supplied by recipe builders.", format: "JSON array" },
    ],
    outputShape: "JSON probe result emitted by the sandbox PHP runner.",
    policyRequirement: "Recipe policy maps this helper to wordpress.run-php.",
    requiresPolicyCommands: ["wordpress.run-php"],
    recipe: true,
    handler: { kind: "recipe-alias", command: "wordpress.run-php" },
  },
  {
    id: "wp-codebox.agent-sandbox-run",
    description: "Recipe-only helper that runs one natural-language task through the sandboxed agent stack.",
    acceptedArgs: [
      { name: "task", description: "Task prompt for the sandbox agent.", required: true, format: "string" },
      { name: "agent", description: "Agent slug.", format: "string" },
      { name: "mode", description: "Agent mode.", format: "string" },
      { name: "provider", description: "AI provider id.", format: "string" },
      { name: "model", description: "Model id.", format: "string" },
      { name: "session-id", description: "Conversation session id.", format: "string" },
      { name: "max-turns", description: "Maximum agent loop turns.", format: "positive integer" },
      { name: "timeout-seconds", description: "Maximum wall-clock seconds for the sandbox agent PHP task.", format: "positive integer" },
      { name: "component", description: "Repeated generic runtime component contract: source path plus optional slug, pluginFile, loadAs. Prefer this over component-specific flags.", format: "path[,slug=<slug>,pluginFile=<slug/file.php>,loadAs=plugin|mu-plugin]" },
      { name: "provider-plugin-slugs", description: "Comma-separated provider plugin slugs already mounted by recipe inputs.", format: "comma-separated slugs" },
      { name: "provider-plugin-contracts-json", description: "Resolved provider plugin entrypoint contracts supplied by recipe builders.", format: "JSON array" },
      { name: "code", description: "Inline PHP runner override for operator/debug use.", format: "PHP string" },
      { name: "code-file", description: "Path to PHP runner override for operator/debug use.", format: "path" },
    ],
    outputShape: "JSON agent run result emitted by the sandbox PHP runner.",
    policyRequirement: "Recipe policy maps this helper to wordpress.run-php and wordpress.wp-cli.",
    requiresPolicyCommands: ["wordpress.run-php", "wordpress.wp-cli"],
    recipe: true,
    handler: { kind: "recipe-alias", command: "wordpress.run-php" },
  },
  {
    id: "wp-codebox.agent-fanout",
    description: "Recipe-only helper that persists a generic browser fanout phase envelope, worker result refs, lifecycle events, and aggregate output refs.",
    acceptedArgs: [
      { name: "request-json", description: "Inline wp-codebox/agent-fanout-request/v1 envelope.", format: "JSON object" },
      { name: "request-file", description: "Recipe-relative path to a wp-codebox/agent-fanout-request/v1 envelope.", format: "path" },
    ],
    outputShape: "JSON wp-codebox/agent-fanout-result/v1 envelope plus fanout/plan.json, fanout/events.jsonl, worker result refs, and aggregate/final refs in runtime evidence artifacts.",
    outputSchema: objectEnvelopeSchema("wp-codebox/agent-fanout-result/v1", {
      fanout: { type: "object" },
      workers: { type: "array" },
      aggregate: { type: "object" },
    }),
    policyRequirement: "Host-side recipe helper; it writes generic Codebox artifact envelopes and does not expose caller-specific internals.",
    recipe: true,
    handler: { kind: "recipe-alias", command: "wp-codebox.agent-fanout" },
  },
] as const satisfies readonly CommandDefinition[]

export type CommandId = typeof commandRegistry[number]["id"]
export type PlaygroundRuntimeCommandDefinition = Extract<typeof commandRegistry[number], { handler: { kind: "playground" } }>
export type PlaygroundRuntimeCommandId = PlaygroundRuntimeCommandDefinition["id"]

export function getCommandDefinition(command: string): CommandDefinition | undefined {
  return commandRegistry.find((definition) => definition.id === command)
}

export function commandValidationDescriptorFor(command: string): CommandValidationDescriptor | undefined {
  return getCommandDefinition(command)?.validation
}

export function effectivePolicyCommands(command: string, definitions: readonly CommandDefinition[] = commandRegistry): string[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]))
  const commands: string[] = []
  const visiting = new Set<string>()

  const collect = (id: string): void => {
    if (visiting.has(id)) return
    visiting.add(id)

    const definition = byId.get(id)
    const requirements = definition?.requiresPolicyCommands
    if (requirements) {
      for (const requiredCommand of requirements) {
        collect(requiredCommand)
      }
    } else if (!commands.includes(id)) {
      commands.push(id)
    }

    visiting.delete(id)
  }

  collect(command)
  return commands
}

export function effectivePolicyCommandsFor(commands: readonly string[], definitions: readonly CommandDefinition[] = commandRegistry): string[] {
  return [...new Set(commands.flatMap((command) => effectivePolicyCommands(command, definitions)))]
}

export function runtimeCommandDefinitions(): CommandDefinition[] {
  return commandRegistry.filter((definition) => definition.handler.kind === "playground")
}

export function recipeCommandDefinitions(): CommandDefinition[] {
  return commandRegistry.filter((definition) => definition.recipe)
}
