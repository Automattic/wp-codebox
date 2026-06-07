export type CommandHandlerBinding =
  | { kind: "playground"; method: string }
  | { kind: "recipe-alias"; command: string }

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
  policyRequirement: string
  recipe: boolean
  handler: CommandHandlerBinding
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
    id: "wordpress.run-php",
    description: "Run PHP against WordPress, bootstrapping wp-load.php unless bootstrap=none is supplied.",
    acceptedArgs: [
      { name: "code", description: "Inline PHP code to run.", format: "PHP string" },
      { name: "code-file", description: "Path to a PHP file whose contents should run.", format: "path" },
      { name: "bootstrap", description: "Use bootstrap=none to skip wp-load.php.", format: "wordpress|none" },
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
    id: "wordpress.ability",
    description: "Execute a registered WordPress Ability in the sandbox.",
    acceptedArgs: [
      { name: "name", description: "Ability name to execute.", required: true, format: "string" },
      { name: "input", description: "Ability input payload.", format: "JSON object" },
    ],
    outputShape: "JSON object with command, name, input, and result fields.",
    policyRequirement: "Runtime policy commands must include wordpress.ability.",
    recipe: true,
    handler: { kind: "playground", method: "runAbility" },
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
    ],
    outputShape: "JSON object with command, method, path, route, status, headers, body/data, timing, and diagnostics.",
    policyRequirement: "Runtime policy commands must include wordpress.rest-request.",
    recipe: true,
    handler: { kind: "playground", method: "runRestRequest" },
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
      { name: "lifecycle-json", description: "Generic benchmark lifecycle hooks keyed by setup, prepare, warmup, measure, or teardown. Hook entries use the same php/ability/wp-cli step format as configured workloads.", format: "JSON object" },
      { name: "reset-policy-json", description: "Explicit benchmark reset policy. Supports betweenIterations and betweenScenarios modes: none or object-cache.", format: "JSON object" },
    ],
    outputShape: "wp-codebox/bench-results/v1 JSON envelope with typed scenarios, metrics, diagnostics, artifacts, and provenance.",
    policyRequirement: "Runtime policy commands must include wordpress.bench.",
    recipe: true,
    handler: { kind: "playground", method: "runBench" },
  },
  {
    id: "wordpress.phpunit",
    description: "Run plugin PHPUnit tests with normalized diagnostics and test-result artifact capture.",
    acceptedArgs: [
      { name: "plugin-slug", description: "Plugin slug under wp-content/plugins.", format: "slug" },
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
    policyRequirement: "Runtime policy commands must include wordpress.plugin-check.",
    recipe: true,
    handler: { kind: "playground", method: "runPluginCheck" },
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
    acceptedArgs: [
      { name: "url", description: "Preview path or absolute URL to visit.", required: true, format: "path or URL" },
      { name: "wait-for", description: "Navigation wait condition.", format: "domcontentloaded|load|networkidle|selector:<selector>|duration" },
      { name: "duration", description: "Extra capture duration, or wait time when wait-for=duration.", format: "duration, e.g. 2s or 500ms" },
      { name: "device", description: "Optional built-in Playwright device profile to use for the browser context.", format: "Playwright device name, e.g. iPhone 13" },
      { name: "locale", description: "Optional browser context locale.", format: "BCP 47 locale, e.g. en-US" },
      { name: "auth", description: "Optional in-memory browser authentication mode. Use wordpress-admin to bootstrap WordPress admin cookies from PHP without writing token-bearing storage-state artifacts.", format: "wordpress-admin" },
      { name: "auth-user-id", description: "WordPress user ID used with auth=wordpress-admin; defaults to 1.", format: "positive integer" },
      { name: "pre-page-script", description: "Optional JavaScript installed before navigation so page scripts can observe mocked browser/payment capabilities.", format: "JavaScript source" },
      { name: "script", description: "Optional page-side JavaScript to evaluate after navigation and before final capture.", format: "JavaScript function body" },
      { name: "assert", description: "Repeatable DOM/browser assertion. Supports advisory:<assertion>, exists:<selector>, not-exists:<selector>, visible:<selector>, hidden:<selector>, count:<selector><op><number>, text:<selector> contains <text>, attr:<selector>[name][=value], no-console-errors, no-page-errors, and no-errors.", repeatable: true, format: "browser assertion" },
      { name: "capture", description: "Comma-separated artifacts to capture.", format: "console,errors,html,network,performance,memory,screenshot" },
      { name: "repeat", description: "Optional repeated probe iterations for leak-oriented recipes.", format: "positive integer" },
      { name: "reset-between", description: "Requested reset mode between repeated probe iterations.", format: "none|reload|new-page" },
    ],
    outputShape: "JSON summary with requested/effective browser context details plus assertion results and files/browser/console.jsonl, errors.jsonl, network.jsonl, performance.json, memory.json, checkpoints.jsonl, snapshot.html, summary.json, and screenshot.png when captured.",
    policyRequirement: "Runtime policy commands must include wordpress.browser-probe.",
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
      { name: "screenshot", description: "Boolean alias for capture=screenshot.", format: "boolean" },
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
      { name: "steps-json", description: "Ordered interaction script: navigate, click, fill, type, press, drag, hover, select, waitFor, evaluate, expect, screenshot, and capture steps.", format: "JSON array (inline or @<path>)" },
      { name: "actions-json", description: "Back-compat alias for steps-json accepting the legacy navigate/click/fill/press/wait/capture action shape.", format: "JSON array" },
      { name: "step-timeout", description: "Per-step timeout applied to each interaction step.", format: "duration, e.g. 5s or 500ms" },
      { name: "timeout", description: "Total-script timeout bounding the whole interaction run.", format: "duration, e.g. 30s or 1500ms" },
      { name: "auth", description: "Optional in-memory browser authentication mode. Use wordpress-admin to bootstrap WordPress admin cookies from PHP without writing token-bearing storage-state artifacts.", format: "wordpress-admin" },
      { name: "auth-user-id", description: "WordPress user ID used with auth=wordpress-admin; defaults to 1.", format: "positive integer" },
      { name: "capture", description: "Comma-separated artifacts to capture after interactions.", format: "steps,console,errors,html,network,screenshot" },
    ],
    outputShape: "JSON summary plus files/browser/steps.jsonl, action-summary.json (with assertions pass/fail), named screenshots, and optional console/errors/network/html/screenshot artifacts.",
    policyRequirement: "Runtime policy commands must include wordpress.browser-actions. The evaluate step additionally requires wordpress.browser-actions.evaluate.",
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
      { name: "capture", description: "Comma-separated artifacts to capture.", format: "steps,console,errors,html,network,performance,memory,screenshot" },
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
    recipe: true,
    handler: { kind: "playground", method: "runBrowserScenario" },
  },
  {
    id: "wordpress.visual-compare",
    description: "Compare two browser targets or screenshot files and emit generic visual diff evidence artifacts without applying downstream parity policy.",
    acceptedArgs: [
      { name: "source-url", description: "Source browser target path or absolute URL.", format: "path or URL" },
      { name: "candidate-url", description: "Candidate browser target path or absolute URL.", format: "path or URL" },
      { name: "source-screenshot", description: "Existing source PNG screenshot path on the host.", format: "path" },
      { name: "candidate-screenshot", description: "Existing candidate PNG screenshot path on the host.", format: "path" },
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
    outputShape: "wp-codebox/visual-compare/v1 JSON summary plus files/browser/visual-compare/source.png, candidate.png, diff.png, and visual-diff.json when comparison succeeds.",
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
      { name: "steps-json", description: "Ordered editor action script: open, insertBlock, selectBlock, and inspectState.", required: true, format: "JSON array (inline or @<path>)" },
      { name: "wait-selector", description: "Selector that marks the editor as ready; defaults to the block editor shell.", format: "CSS selector" },
      { name: "wait-timeout", description: "Timeout for navigation and editor-ready waits.", format: "duration, e.g. 15s or 500ms" },
      { name: "step-timeout", description: "Per-action timeout applied to each editor action step.", format: "duration, e.g. 15s or 500ms" },
      { name: "timeout", description: "Total-script timeout bounding the whole editor action run.", format: "duration, e.g. 30s or 1500ms" },
      { name: "capture", description: "Comma-separated artifacts to capture after actions.", format: "steps,console,errors,html,screenshot,editor-state" },
    ],
    outputShape: "JSON summary plus files/browser/editor-action-steps.jsonl, editor-action-summary.json, editor-action-state.json, and optional console/errors/html/screenshot artifacts.",
    policyRequirement: "Runtime policy commands must include wordpress.editor-actions.",
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
    description: "Recipe-only probe that boots Agents API, Data Machine, and Data Machine Code and verifies the stack loads.",
    acceptedArgs: [
      { name: "provider-plugin-slugs", description: "Comma-separated provider plugin slugs already mounted by recipe inputs.", format: "comma-separated slugs" },
    ],
    outputShape: "JSON probe result emitted by the sandbox PHP runner.",
    policyRequirement: "Recipe policy maps this helper to wordpress.run-php.",
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
      { name: "provider-plugin-slugs", description: "Comma-separated provider plugin slugs already mounted by recipe inputs.", format: "comma-separated slugs" },
      { name: "code", description: "Inline PHP runner override for operator/debug use.", format: "PHP string" },
      { name: "code-file", description: "Path to PHP runner override for operator/debug use.", format: "path" },
    ],
    outputShape: "JSON agent run result emitted by the sandbox PHP runner.",
    policyRequirement: "Recipe policy maps this helper to wordpress.run-php.",
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
    policyRequirement: "Host-side recipe helper; it writes generic Codebox artifact envelopes and does not expose product or Data Machine internals.",
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

export function runtimeCommandDefinitions(): CommandDefinition[] {
  return commandRegistry.filter((definition) => definition.handler.kind === "playground")
}

export function recipeCommandDefinitions(): CommandDefinition[] {
  return commandRegistry.filter((definition) => definition.recipe)
}
