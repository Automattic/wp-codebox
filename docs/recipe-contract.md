# Recipe Contract

WP Codebox recipes use the `wp-codebox/workspace-recipe/v1` schema. A recipe is
a declarative sandbox setup plus ordered workflow steps. The CLI validates the
recipe before booting the selected WordPress runtime, then returns a structured
artifact bundle after execution.

Use the generated schema and command catalog as the source of truth:

```bash
npm run wp-codebox -- schema recipe --json
npm run wp-codebox -- commands --json
```

Validate recipes before using them in CI or documentation examples:

```bash
npm run wp-codebox -- recipe validate --recipe ./path/to/recipe.json --json
npm run wp-codebox -- recipe-run --recipe ./path/to/recipe.json --dry-run --json
```

## Minimal Shape

```json
{
  "schema": "wp-codebox/workspace-recipe/v1",
  "runtime": {
    "backend": "wordpress",
    "wp": "latest"
  },
  "inputs": {
    "mounts": [
      {
        "source": "../my-plugin",
        "target": "/wordpress/wp-content/plugins/my-plugin",
        "mode": "readonly"
      }
    ]
  },
  "workflow": {
    "steps": [
      {
        "command": "wordpress.run-php",
        "args": ["code=echo get_bloginfo( 'name' );"]
      }
    ]
  }
}
```

`runtime.backend` may be omitted. When present, `wordpress` is the neutral
WordPress runtime name and currently resolves to the WordPress Playground backend.
Existing recipes that specify `wordpress-playground` continue to work as a
compatibility spelling.

Raw Playground-oriented fields such as `runtime.blueprint`, `runtime.phpVersion`,
`runtime.wordpressInstallMode`, and Playground backend packages are advanced
compatibility fields. Prefer the neutral `wordpress` backend and recipe inputs
for new runtime setup where possible.

## Stable Field Names

Recipe field names are case-sensitive. The current recipe schema accepts these
top-level fields:

- `schema`
- `distribution`
- `runtime`
- `inputs`
- `workflow`
- `fuzzRun`
- `artifacts`
- `probes`
- `metadata`

`inputs` accepts these fields:

- `mounts`
- `workspaces`
- `workspace_preloads`
- `extra_plugins`
- `component_manifest`
- `dependency_overlays`
- `runtimeEnv`
- `secretEnv`
- `externalServices`
- `pluginRuntime`
- `fixtureDatabases`
- `fixtureUsers`
- `userSessions`
- `siteSeeds`
- `stagedFiles`
- `sourcePackages`
- `agent_bundles`
- `inherit`
- `inheritance`

Use `inputs.extra_plugins`, not `inputs.extraPlugins`. The camelCase form is an
old docs/example drift and is not part of `wp-codebox/workspace-recipe/v1`.

Use `inputs.agent_bundles`, not `inputs.agentBundles`, for runtime agent bundle
imports.

Use `inputs.workspace_preloads` for generic `agent-runtime/workspace-preload`
artifact contracts. WP Codebox materializes declared repositories as sandbox
workspace mounts; callers own the policy that decides which artifacts to pass.

## External Service Boundaries

Use `inputs.externalServices` to declare reviewer-safe boundaries for services a
recipe may observe while collecting browser or runtime evidence. The primitive is
product-neutral: it names the boundary, classifies the environment, declares host
sets, records the write policy, and lists secret environment variable names
without serializing secret values.

```json
{
  "inputs": {
    "externalServices": [
      {
        "id": "checkout-staging",
        "label": "Checkout staging API",
        "environment": "staging",
        "allowedHosts": ["api.example.test"],
        "blockedHosts": ["api.example.com"],
        "writes": "record-only",
        "secretEnv": ["CHECKOUT_API_TOKEN"],
        "redaction": {
          "policy": "redact-fields",
          "fields": ["authorization", "set-cookie"]
        }
      }
    ]
  }
}
```

Supported `environment` values are `local`, `fixture`, `staging`, `production`,
and `external`. Supported `writes` values are `forbidden`, `record-only`, and
`allowed-with-approval`. Supported redaction policies are `metadata-only`,
`redact-fields`, and `omit`.

Dry-run plans, run attestations, failure diagnostics, and browser evidence expose
only the declared boundary metadata and secret env names. When browser evidence
contains network-policy host observations, WP Codebox adds a safe correlation
summary from observed hosts to declared boundary ids where host names match
`allowedHosts` or `blockedHosts`.

## Extra Plugins

`inputs.extra_plugins` mounts additional WordPress plugins before workflow steps
run. Each entry requires `source` or `sourcePath` and may include `sourceSubdir`,
`mountSlug`, `pluginFile`, `activate`, `loadAs`, and `sha256`. `sourcePath` is
the source root, `sourceSubdir` is an optional plugin directory below that root,
`mountSlug` is the WordPress plugin directory, and `pluginFile` is relative to
the mounted plugin slug.

```json
{
  "inputs": {
    "extra_plugins": [
      {
        "source": "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
        "pluginFile": "bbpress/bbpress.php",
        "activate": false
      },
      {
        "source": "../caller-runtime-substrate",
        "slug": "caller-runtime-substrate",
        "pluginFile": "caller-runtime-substrate/caller-runtime-substrate.php",
        "activate": false,
        "loadAs": "mu-plugin"
      },
      {
        "sourcePath": "../monorepo",
        "sourceSubdir": "plugins/example-plugin",
        "mountSlug": "example-plugin",
        "pluginFile": "example-plugin/example-plugin.php"
      }
    ]
  }
}
```

Supported `loadAs` values:

- `plugin`: mount below `/wordpress/wp-content/plugins/<slug>` and activate when
  `activate` is not `false`.
- `mu-plugin`: mount below
  `/wordpress/wp-content/mu-plugins/wp-codebox-runtime/<slug>` and load through
  WP Codebox's generated MU-plugin loader. Use this for sandbox runtime
  substrate, not user-visible plugins.

External HTTPS zip downloads are gated by `WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS=1`.
Local paths are resolved relative to the recipe file.

## Source Packages

`inputs.sourcePackages` materializes local recipe source directories below the
sandbox workspace. It is directory-only; use `inputs.stagedFiles` for single-file
staging. Each package declares a stable `name`, local `source`,
workspace-relative `target`, optional `allow`/`deny` path filters, and optional
provenance artifact registration.

```json
{
  "inputs": {
    "sourcePackages": [
      {
        "name": "fixture-plugin",
        "source": "./fixtures/plugin",
        "target": "packages/fixture-plugin",
        "allow": ["src*", "composer.json"],
        "deny": ["src/secrets*"],
        "artifact": true
      }
    ]
  }
}
```

Targets are normalized under `/workspace` when they are not already absolute
workspace paths. Materialization uses WP Codebox prepared-source exclusions,
applies `deny` before `allow`, hashes the copied package, and writes
`.wp-codebox-source-package.json` into the staged package root with source,
filter, target, digest, and timestamp provenance. Validation emits blockers for
unsafe names, paths, and filters before runtime setup.

`recipe build template` compiles declarative source package input into generated
artifact declarations while preserving `inputs.sourcePackages`, so callers use
the same validation and run path as hand-written recipes without duplicate
mounts.

```bash
npm run wp-codebox -- recipe build template --options ./template-options.json --output ./recipe.json
```

## Workflow Steps

Workflow steps are ordered command invocations:

```json
{
  "command": "wordpress.wp-cli",
  "args": ["command=option get home"]
}
```

Each `args` entry is a string. Command-specific argument names and repeatability
come from the command catalog:

```bash
npm run wp-codebox -- commands --json
```

Use `allowFailure: true` or `advisory: true` for evidence-only workflow steps.
Failed advisory steps are reported in `advisoryFailures` and do not make an
otherwise successful recipe return `success: false`.

## Fuzz Case Runs

Recipes may declare a bounded, deterministic fuzz case skeleton with
`fuzzRun.schema: "wp-codebox/fuzz-run/v1"`. This primitive does not generate
inputs or implement a fuzzing strategy. It gives callers a generic way to name
cases, attach input/hash/replay metadata, and run setup/action/assert/teardown
phases through the same command machinery as normal workflow steps.

Each case requires a stable `case_id` and at least one `action` step:

```json
{
  "schema": "wp-codebox/workspace-recipe/v1",
  "workflow": {
    "steps": [{ "command": "inspect-mounted-inputs" }]
  },
  "fuzzRun": {
    "schema": "wp-codebox/fuzz-run/v1",
    "cases": [
      {
        "case_id": "case-001",
        "input": { "path": "/example" },
        "inputHash": { "algorithm": "sha256", "value": "abc123" },
        "phases": {
          "setup": [{ "command": "wordpress.run-php", "args": ["code=update_option('case','case-001');"] }],
          "action": [{ "command": "wordpress.wp-cli", "args": ["command=option get case"] }],
          "assert": [{ "command": "wordpress.run-php", "args": ["code=if (get_option('case') !== 'case-001') { exit(1); }"] }],
          "teardown": [{ "command": "wordpress.run-php", "args": ["code=delete_option('case');"] }]
        },
        "artifacts": [{ "name": "case-log", "path": "/tmp/wp-codebox/fuzz/case-001.json" }],
        "replay": { "seed": "seed-001", "inputRef": "fixtures/cases/case-001.json" }
      }
    ]
  }
}
```

The runtime output includes `fuzzRun.schema: "wp-codebox/fuzz-run-result/v1"`
with per-case status, timing, command references/results, declared artifact
references, diagnostics, and replay metadata placeholders. Fuzz case phase steps
are ordinary recipe commands, so command permissions and validation come from the
existing command catalog.

### Plugin State

Use `wordpress.plugin-setup` for bounded plugin installation and inventory in a
contained runtime. It accepts WordPress.org slugs only; paths, URLs, and package
files are rejected so callers cannot mutate or read parent-site paths.

```json
{
  "command": "wordpress.plugin-setup",
  "args": ["action=install", "plugin=my-plugin", "activate=true"]
}
```

Use `wordpress.plugin-state` when a recipe or runtime caller needs structured
WordPress plugin state instead of shelling out to `wp plugin` directly. The
command accepts a plugin slug, plugin file, or plugin path and can report,
activate, or deactivate the resolved plugin with WordPress plugin APIs.

```json
{
  "command": "wordpress.plugin-state",
  "args": ["action=activate", "plugin=my-plugin"]
}
```

The result uses the `wp-codebox/wordpress-plugin-state/v1` schema and includes
the requested action, resolved target identity, before/after active plugin
lists, network-active plugin lists where multisite is available, multisite
support notes, diagnostics, errors, and `artifactRefs`.

Recipes and runtime-backed fuzz workloads may use `wordpress.ensure-plugin-active`
as the public ensure-active form. It accepts the same plugin target arguments and
executes the `wordpress.plugin-state` activation contract.

Use `wordpress.theme-setup` for bounded theme installation, switching, and
inventory in a contained runtime:

```json
{
  "command": "wordpress.theme-setup",
  "args": ["action=switch", "theme=twentytwentysix"]
}
```

The plugin/theme setup result schemas include the requested action, target slug,
current inventory, operation diagnostics, errors, and `artifactRefs`.

## Runtime Checkpoints

Recipes can create named checkpoints and restore them later in the same run.
Checkpoints are generic runtime isolation primitives for bounded mutation loops;
they are not a high-volume fuzz runner.

```json
{
  "workflow": {
    "steps": [
      { "command": "wp-codebox.checkpoint-create", "args": ["name=baseline"] },
      { "command": "wordpress.run-php", "args": ["code=update_option( 'example_flag', 'mutated' );"] },
      { "command": "wp-codebox.checkpoint-restore", "args": ["name=baseline"] },
      { "command": "wp-codebox.checkpoint-list" }
    ]
  }
}
```

Supported commands:

- `wp-codebox.checkpoint-create` captures the current runtime state under `name`.
- `wp-codebox.checkpoint-restore` restores a previously created `name`.
- `wp-codebox.checkpoint-list` emits metadata for checkpoints created in the run.

Checkpoint create accepts the same snapshot scoping arguments as
`wordpress.capture-state-bundle`, plus optional `metadata-json`. Unsupported
runtime backends fail closed with a structured
`wp-codebox/runtime-checkpoint-failure/v1` diagnostic and exit code `1`.

## REST Benchmark Workloads

Recipes can pass REST profiling workloads to `wordpress.bench` with
`workloads-json`. A workload may use `route_matrix` to declare a bounded set of
REST requests; the runtime expands each route into the existing `rest-request`
step and returns normal benchmark scenarios/artifacts.

Workloads may also use a configured `rest-db-query-profiler` step to run one or
more `rest_request_cases`, bracket each REST request with `$wpdb->queries`, and
return bounded, redacted query-profile metrics plus the typed
`rest-db-query-profile` benchmark artifact.

## Command Diagnostics

Recipe steps may opt into bounded per-command diagnostics with a `diagnostics`
object. Capture is disabled by default. The first supported capture kind is
`wpdb-queries` on `wordpress.run-php`, which records redacted SQL fingerprints
from `$wpdb->queries` around the command and links a structured
`wp-codebox/command-diagnostics/v1` artifact from the execution result.

```json
{
  "command": "wordpress.run-php",
  "args": ["code=$wpdb->get_results('SELECT * FROM wp_posts WHERE ID = 123');"],
  "diagnostics": {
    "capture": ["wpdb-queries"],
    "maxItems": 25,
    "maxBytes": 32768
  }
}
```

The same command also accepts `capture-diagnostics=wpdb-queries`,
`diagnostics-max-items=<n>`, and `diagnostics-max-bytes=<n>` args for direct
runtime callers. Limits are capped at 500 records and 524288 serialized bytes.

```json
{
  "command": "wordpress.bench",
  "args": [
    "plugin-slug=woocommerce",
    "iterations=3",
    "warmup-iterations=1",
    "workloads-json=[{\"id\":\"rest-catalog\",\"source\":\"config\",\"route_matrix\":[{\"id\":\"products-list\",\"method\":\"GET\",\"path\":\"/wc/v3/products\",\"params\":{\"per_page\":10}}],\"run\":[{\"type\":\"rest-db-query-profiler\",\"rest_request_cases\":[{\"id\":\"products-list\",\"method\":\"GET\",\"path\":\"/wc/v3/products\",\"params\":{\"per_page\":10}}]}],\"artifacts\":{\"route-summary\":{\"path\":\"bench/rest-route-summary.json\",\"kind\":\"json\",\"source\":\"scenario-artifact\"}}}]"
  ]
}
```

Use site seeds, fixture databases, or staged files for product-specific data
setup. Use `artifacts` on the workload for declared per-scenario outputs that
downstream lab tooling should extract from `benchResults` or an artifact bundle.

## Fixture Imports And Bootstrap Declarations

`inputs.siteSeeds` is the generic fixture import primitive. JSON fixture seeds
import through WordPress APIs for posts, options, terms, users, media, active
plugins, and active theme declarations. Those APIs can make semantic identifiers
stable, such as post slugs, term slugs, option names, user logins, plugin files,
and theme stylesheets. They cannot guarantee numeric primary keys.

Use `deterministicIds` to make that boundary explicit:

```json
{
  "inputs": {
    "siteSeeds": [
      {
        "type": "fixture",
        "name": "demo-content",
        "source": "fixtures/content.json",
        "format": "json",
        "deterministicIds": {
          "strategy": "platform-identifiers",
          "onUnsupported": "block"
        },
        "scopes": {
          "posts": { "slugs": ["home"] },
          "options": { "names": ["blogname"] }
        }
      }
    ]
  }
}
```

When `onUnsupported` is `block`, WP Codebox reports a validation/runtime blocker
if the generic importer sees numeric `id`/`ID` fixture fields or a recipe requests
the `numeric` strategy. Custom importers may add format-specific support later,
but the generic contract stays honest about what platform APIs can guarantee.

Recipes may also attach reusable bootstrap declarations to a site seed:

```json
{
  "bootstrap": {
    "multisite": {
      "enabled": true,
      "install": "subdomain",
      "sites": [{ "domain": "example.test", "path": "/", "title": "Example" }]
    },
    "domains": [{ "domain": "example.test", "path": "/", "primary": true }]
  }
}
```

These are generic declarations for orchestrators and future runtime setup
support. The current built-in fixture importer treats multisite/domain bootstrap
as declared metadata and blocks executable fixture imports that require runtime
setup not yet provided by WP Codebox.

## Fixture Users And User Sessions

Recipes can declare named WordPress fixture users in `inputs.fixtureUsers` and
named command execution sessions in `inputs.userSessions`. A fixture user is a
generic WordPress user contract: `name`, optional `userId`, `username`, `email`,
`role`, `displayName`, and `password`. Commands that support user/session
resolution can accept `user=<name>` or `session=<name>`.

`userSessions` reference a fixture user by name. Session artifacts such as
browser storage state, cookie jars, or tokens are metadata only and must be
declared with `redactionRequired: true`; command output reports only safe
structured metadata such as schema, selected user name/role, artifact kind/path,
and the redaction flag.

```json
{
  "inputs": {
    "fixtureUsers": [
      { "name": "admin", "username": "fixture-admin", "role": "administrator" }
    ],
    "userSessions": [
      {
        "name": "admin-browser",
        "user": "admin",
        "artifacts": [
          { "kind": "browser-storage-state", "path": "files/browser-storage-state/storage-state.json", "redactionRequired": true }
        ]
      }
    ]
  },
  "workflow": {
    "steps": [
      { "command": "wordpress.rest-request", "args": ["path=/wp/v2/users/me", "session=admin-browser"] }
    ]
  }
}
```

```json
{
  "command": "wordpress.browser-actions",
  "args": ["url=/", "steps-json=[...]"],
  "advisory": true
}
```

Browser interaction scripts support a generic `callTool` verifier step shape for
caller-owned external checks:

```json
{
  "kind": "callTool",
  "tool": "client/check_status",
  "input": { "url": "https://example.test/status", "expected": "ready" }
}
```

`tool` is the exact caller-provided host tool command name and must be allowed by
runtime policy using that same command name. `input` must be JSON-serializable.
WP Codebox treats this as transport and evidence only; callers own the tool and
any external system behavior. The Playground browser-actions runtime validates
and policy-checks `callTool`; when the caller provides a matching host tool via
`RuntimeCreateSpec.hostTools`, Codebox executes it through the generic host-tool
transport and records the `wp-codebox/host-tool-result/v1` result inside a
redaction-required `wp-codebox/browser-tool-verifier-result/v1` artifact. When no
host-tool registry or matching tool is available, or runtime policy does not
allow the exact tool command, Codebox records stable `unsupported` verifier
evidence instead of executing the step. Raw input values and secrets are not
serialized into unsupported verifier artifacts. Polling fields are intentionally
not part of this narrow primitive yet; callers should model repeated checks
outside the browser script.

## Fixture Browser Auth Storage State

Hosts that need an authenticated browser session for a disposable WordPress
sandbox can use Codebox fixture auth storage-state helpers instead of baking
product-specific site identifiers into recipes. The helper contract is generic:
resolve or create a named WordPress fixture user inside the sandbox, mint
short-lived WordPress admin cookies for declared browser origins, and return a
Playwright-compatible `storageState` envelope.

The emitted PHP returns `wp-codebox/browser-auth-storage-state/v1`:

```json
{
  "schema": "wp-codebox/browser-auth-storage-state/v1",
  "kind": "wordpress-fixture-user-admin-auth",
  "user": {
    "id": 1,
    "username": "wp-codebox-fixture-admin",
    "email": "wp-codebox-fixture-admin@example.test",
    "role": "administrator",
    "created": true
  },
  "storageState": {
    "cookies": [],
    "origins": []
  }
}
```

Recipes can export that state as an artifact with the generic command:

```json
{
  "command": "wordpress.export-browser-storage-state",
  "args": [
    "browser-urls=http://127.0.0.1:9400,https://preview.example.test",
    "user-json={\"username\":\"fixture-admin\",\"role\":\"administrator\"}"
  ]
}
```

The command also accepts caller-produced state with `storage-state=<json>` or
`storage-state=@./state.json`. That value may be a raw Playwright
`storageState` object or the `wp-codebox/browser-auth-storage-state/v1` envelope
shown above, so product-specific PHP bootstrap code can stay outside WP Codebox
and hand the resulting generic browser state to the exporter.

The command returns `wp-codebox/browser-storage-state-export/v1` with
`artifacts.storageState` and `artifacts.summary`. The storage-state artifact is
the token-bearing Playwright JSON and is marked `redactionRequired` in
`artifactRefs`; the summary artifact and command output contain only
reviewer-safe metadata: schema/kind, user id/name/email/role/created flag,
cookie counts by host, origin count, and diagnostics. Product policy,
production identifiers, and cross-site account mapping stay outside WP Codebox.

`wordpress.browser-probe` and `wordpress.browser-actions` can import a reusable
storage state with `storage-state=<json>` or `storage-state=@./state.json`. The
value may be a raw Playwright `storageState` object or the
`wp-codebox/browser-auth-storage-state/v1` envelope shown above. WP Codebox passes
the state directly to a fresh Playwright context and records only redacted
provenance in browser summaries: source type, optional schema/kind, cookie count,
cookie hosts, origin count, and diagnostics. Cookie values and localStorage values
are never written to browser evidence artifacts.

Use one browser authentication source per command. `auth=wordpress-admin` creates
short-lived in-memory cookies from the disposable WordPress sandbox; `storage-state`
imports caller-provided reusable state. Supplying both is rejected with structured
storage-state diagnostics rather than silently preferring one source.

Browser commands accept `capture=websocket` to write a generic
`browser-websocket` artifact. The artifact records safe connection metadata only:
redacted websocket URLs, open/close/error timestamps, frame counts, and aggregate
sent/received byte counts. Frame payloads are not written.

## Recipe Output Evidence

`recipe-run --json` returns `wp-codebox/recipe-run/v1`. Browser command sidecars
are promoted into `browserEvidence` so callers can discover stable evidence
without hardcoding artifact paths or parsing command stdout.

The same output includes `result`, a normalized
`wp-codebox/recipe-run-summary/v1` envelope for portable callers. It groups
common artifact refs, command stdout/stderr tails, run/runtime metadata, failure
phase and summary, and held-preview reviewer access. Consumers should prefer
`result` before scraping `latest-runtime.json`, `commands.jsonl`, command stdout,
or preview internals from the artifact bundle.

Each `browserEvidence` entry includes the workflow phase/index, command,
summary file, artifact file refs, summary payload, and `scriptResult` when the
browser command produced one. The same browser evidence is mirrored into
`latest-runtime.json` under the run artifact pointer.

When a browser command captures network evidence, WP Codebox writes the raw
`network.jsonl` stream and a derived `waterfall.json` artifact using the stable
`wp-codebox/browser-waterfall/v1` schema. The waterfall is HAR-style JSON with
redacted URLs, request/response status, resource type, sizes, and timing fields;
both files are registered as redaction-required browser artifacts and surfaced
through `browserEvidence.files`.

`--preview-hold-seconds <duration>` records held-preview lifecycle metadata in the
artifact bundle and returns after recipe work finishes. The cap defaults to 3600
seconds and can be raised by an operator with `WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS`
up to the hard 24-hour ceiling. Use
`--preview-hold-blocking` only for operator workflows that need the CLI process
to keep a live preview server open for the hold duration.

## Generic Host Command Primitive

Hosts that expose recipe/task runner commands through WP Codebox should use the
core `executeHostCommand()` primitive instead of hand-rolled process wrappers. It
runs one command without shell expansion, enforces allowed working-directory and
environment policy, times out long-running work, terminates the spawned process
group, samples process-tree RSS, and returns a structured result with:

- `failureClassification`: `none`, `timeout`, `non_zero_exit`, or `signal`.
- `commandSummary`: a compact command line for human diagnostics.
- Bounded `stdout` and `stderr` fields plus `outputTruncated`.
- `memorySamples` and `peakRssBytes` for runner watchdog evidence.
- Optional `artifacts.stdout`, `artifacts.stderr`, and `artifacts.summary` refs
  when `artifactsDirectory` is provided.

The summary artifact uses `wp-codebox/host-command-summary/v1`. Product-specific
orchestrators can wrap this primitive, but should keep WPCOM, CI-provider, and
deployment semantics outside the generic runner layer.

## WordPress PHPUnit Runtime

`wordpress.phpunit` is the lightweight WP Codebox equivalent of plugin PHPUnit
commands commonly run through `wp-env run ... vendor/bin/phpunit`. It boots a
disposable WordPress Playground runtime, mounts the tested plugin at
`/wordpress/wp-content/plugins/<plugin-slug>`, prepares the WordPress PHPUnit
contract, and captures command output in the artifact bundle.

The runtime provides:

- `WP_TESTS_DIR` pointing at the configured WordPress tests library.
- `WP_TESTS_CONFIG_FILE_PATH` and `WP_PHPUNIT__TESTS_CONFIG` pointing at the
  generated `wp-tests-config.php`.
- An isolated SQLite test database via `DB_NAME=':memory:'`.
- A plugin working directory via `cwd=<sandbox path>`, matching the practical
  role of `wp-env run --env-cwd`.
- Structured diagnostics in the recipe artifact bundle, including the raw test
  result log collected from `/tmp/wp-codebox-phpunit-result.txt`.

Use `recipe build phpunit` when generating recipes for plugin CI or offloaded lab
runners:

```json
{
  "pluginSlug": "woocommerce",
  "pluginSource": "../woocommerce/plugins/woocommerce",
  "cwd": "/wordpress/wp-content/plugins/woocommerce",
  "autoloadFile": "/wp-codebox-vendor/autoload.php",
  "testsDir": "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  "bootstrapMode": "project",
  "projectBootstrap": "tests/legacy/bootstrap.php",
  "phpunitArgs": ["--filter", "WC_Checkout_Test::test_checkout"]
}
```

```bash
npm run wp-codebox -- recipe build phpunit --options ./phpunit-options.json --output ./phpunit.recipe.json
npm run wp-codebox -- recipe-run --recipe ./phpunit.recipe.json --artifacts ./artifacts/phpunit --json
```

## Stable Recipe-Builder API

Tools that need to generate WordPress bench or PHPUnit recipes without shelling
out to the CLI may import the supported recipe-builder module:

```js
import {
  buildWordPressBenchRecipe,
  buildWordPressPhpunitRecipe,
} from "@automattic/wp-codebox-core/recipe-builders"
```

The same subpath is exported by the root release package as
`wp-codebox-workspace/recipe-builders`, so callers can use one documented module
name for npm package installs and release-tarball installs without probing
`packages/runtime-core/dist/index.js` or other internal build paths. Local
checkout consumers should run `npm run build` first, then import the same
workspace package subpath through normal Node package resolution.

The CLI surface remains the stable process boundary for hosts that prefer JSON
over an in-process import:

```bash
wp-codebox recipe build phpunit --options ./phpunit-options.json --output ./phpunit.recipe.json
wp-codebox recipe build bench --options ./bench-options.json --output ./bench.recipe.json
wp-codebox recipe build generic-ability-runtime-run --options ./ability-runtime-options.json --output ./ability-runtime.recipe.json
```

All builders return `wp-codebox/workspace-recipe/v1` recipes. The generated
recipes should still be validated with `wp-codebox recipe validate` or
`wp-codebox recipe-run --dry-run` before execution in CI.

`generic-ability-runtime-run` is the stable preset for callers that need to run a
WordPress Ability in a disposable runtime with generic component/provider
contracts. The options JSON maps to `buildGenericAbilityRuntimeRunRecipe` and
accepts `abilityId`, optional `abilityInput`, `components`, `providerPlugins`,
`providerPluginPaths`, `runtimeOverlays`, `runtimeEnv`, `secretEnv`,
`toolPolicy`, `expectedResultSchema`, `mounts`, `runtimeStackMounts`,
`stagedFiles`, and `verifySteps`. The generated workflow invokes
`wordpress.ability` with runtime invocation metadata and, when
`expectedResultSchema` is supplied, `recipe-run --json` records the canonical
`wp-codebox/generic-ability-runtime-run-result/v1` command output with the
ability result and discovered `evidenceEnvelope`.

For monorepos such as WooCommerce, set `pluginSource` to the directory that
should appear as `wp-content/plugins/<plugin-slug>` and set `cwd` to the same
sandbox directory a `wp-env --env-cwd` command would use. Relative `cwd` values
resolve inside the mounted plugin directory.

## Browser Assertions

`wordpress.browser-probe` accepts repeated `assert=<assertion>` arguments.
Supported assertion forms are the current command contract:

- `exists:<selector>`
- `not-exists:<selector>`
- `visible:<selector>`
- `hidden:<selector>`
- `count:<selector><op><number>`
- `text:<selector> contains <text>`
- `attr:<selector>[name][=value]`
- `no-console-errors`
- `no-page-errors`
- `no-errors`
- `request-count-by-host:<host><op><number>`
- `request-count-by-type:<type><op><number>`
- `total-transfer-size<op><number>`
- metric budgets such as `lcp_ms<=2500`, `fcp_ms<=1800`,
  `ttfb_ms<=800`, and `nav_duration_ms<=5000`

Prefix an assertion with `advisory:` to record a failing assertion without
failing the command.

`wordpress.browser-actions` can assert over observations captured by prior action
steps with an `assertObservation` step. Supported observation assertions are:

- `no-console-errors`
- `no-page-errors`
- `request-count-by-host:<host><op><number>`
- `request-count-by-type:<type><op><number>`

Failed `assertObservation` steps are recorded in the action step records and
assertion summary, and they fail the browser-actions command.

```json
{
  "command": "wordpress.browser-actions",
  "args": [
    "url=/",
    "steps-json=[{\"kind\":\"waitFor\",\"waitFor\":\"networkidle\"},{\"kind\":\"assertObservation\",\"assertion\":\"request-count-by-host:example.test<=2\"},{\"kind\":\"assertObservation\",\"assertion\":\"no-console-errors\"}]"
  ]
}
```

Do not use `assert=script:passed equals true`. That syntax is not supported by
the current WP Codebox browser assertion contract. Use `wordpress.browser-actions`
with an `evaluate` step and `assert` value when a page script must prove state:

```json
{
  "command": "wordpress.browser-actions",
  "args": [
    "url=/wp-admin/tools.php?page=my-plugin",
    "steps-json=[{\"kind\":\"evaluate\",\"expression\":\"window.myPluginReady === true\",\"assert\":true}]"
  ]
}
```

Recipes that use a browser-actions `evaluate` step require the runtime policy to
allow `wordpress.browser-actions.evaluate` in addition to
`wordpress.browser-actions`.

## Keeping Examples Current

When editing docs or example recipes:

- Prefer generated schema output over hand-written field lists.
- Run `recipe validate` against every recipe changed.
- Run `recipe-run --dry-run --json` when changing mounts, workspaces,
  `extra_plugins`, secrets, or workflow args.
- Keep product-specific orchestration, scoring, PR creation, and deployment out
  of recipes. Parent control planes own those behaviors.
