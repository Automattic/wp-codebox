# Recipe Contract

WP Codebox recipes use the `wp-codebox/workspace-recipe/v1` schema. A recipe is
a declarative sandbox setup plus ordered workflow steps. The CLI validates the
recipe before booting WordPress Playground, then returns a structured artifact
bundle after execution.

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
    "backend": "wordpress-playground",
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

## Stable Field Names

Recipe field names are case-sensitive. The current recipe schema accepts these
top-level fields:

- `schema`
- `distribution`
- `runtime`
- `inputs`
- `workflow`
- `artifacts`
- `probes`

`inputs` accepts these fields:

- `mounts`
- `workspaces`
- `extra_plugins`
- `secretEnv`
- `pluginRuntime`
- `fixtureDatabases`
- `siteSeeds`
- `stagedFiles`
- `agent_bundles`
- `inherit`
- `inheritance`

Use `inputs.extra_plugins`, not `inputs.extraPlugins`. The camelCase form is an
old docs/example drift and is not part of `wp-codebox/workspace-recipe/v1`.

Use `inputs.agent_bundles`, not `inputs.agentBundles`, for runtime agent bundle
imports.

## Extra Plugins

`inputs.extra_plugins` mounts additional WordPress plugins before workflow steps
run. Each entry requires `source` and may include `slug`, `pluginFile`,
`activate`, `loadAs`, and `sha256`.

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
        "source": "../agents-api",
        "slug": "agents-api",
        "pluginFile": "agents-api/agents-api.php",
        "activate": false,
        "loadAs": "mu-plugin"
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

```json
{
  "command": "wordpress.browser-actions",
  "args": ["url=/", "steps-json=[...]"],
  "advisory": true
}
```

## Recipe Output Evidence

`recipe-run --json` returns `wp-codebox/recipe-run/v1`. Browser command sidecars
are promoted into `browserEvidence` so callers can discover stable evidence
without hardcoding artifact paths or parsing command stdout.

Each `browserEvidence` entry includes the workflow phase/index, command,
summary file, artifact file refs, summary payload, and `scriptResult` when the
browser command produced one. The same browser evidence is mirrored into
`latest-runtime.json` under the run artifact pointer.

`--preview-hold <duration>` records held-preview lifecycle metadata in the
artifact bundle and returns after recipe work finishes. Use
`--preview-hold-blocking` only for operator workflows that need the CLI process
to keep a live preview server open for the hold duration.

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
```

Both builders return `wp-codebox/workspace-recipe/v1` recipes. The generated
recipes should still be validated with `wp-codebox recipe validate` or
`wp-codebox recipe-run --dry-run` before execution in CI.

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
