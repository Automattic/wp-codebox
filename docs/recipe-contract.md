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
