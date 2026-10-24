# WP Codebox

**Disposable WordPress, on demand.** WP Codebox boots a real WordPress, backed by
[WordPress Playground](https://wordpress.github.io/wordpress-playground/), runs
your code, a test suite, a browser, or an agent against it, and hands back a
verifiable artifact bundle. Then the runtime is gone. No Docker, no database to
provision, and nothing reaches the caller except through declared mounts.

```text
Any host: CLI, CI job, Node service, WordPress plugin, GitHub Action
  -> WP Codebox
    -> disposable WordPress runtime
      <- mounted plugins, themes, workspaces, and agent stacks
      -> commands, recipes, browser sessions, or an agent task
    -> artifact bundle: changed files, patch, test results, browser evidence, preview
  -> review, replay, apply, or discard, outside the sandbox
```

WP Codebox is the runtime boundary. Agents, model providers, review UIs, and
deploys belong to the products that call it.

## Quick Start

Requires Node.js 22 or later.

```bash
git clone https://github.com/Automattic/wp-codebox.git && cd wp-codebox
npm install
npm run build
```

Run PHP against a mounted plugin:

```bash
npm run wp-codebox -- run \
  --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin \
  --command wordpress.run-php \
  --arg code-file=./examples/simple-plugin/probe.php \
  --artifacts ./artifacts \
  --json
```

The result reports `success`, the command's `execution` with its exit code, and
an `artifacts` object pointing at the bundle under `./artifacts/runtime-*`.

Measure the front page on a throttled low-end phone and hold it to a budget:

```bash
npm run wp-codebox -- run \
  --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin \
  --command wordpress.browser-probe \
  --arg url=/ \
  --arg capture=performance \
  --arg profile=low-end-mobile-slow-4g \
  --arg 'assert=fcp_ms<=1800' \
  --artifacts ./artifacts \
  --json
```

Navigation timing, TTFB, FCP, LCP, CLS, long tasks, and resource totals land in
`files/browser/performance.json`; a failed budget fails the command.

To install a release instead of building from source, see
[Distribution](docs/distribution.md).

## Discover The Live Contract

The CLI describes itself. These outputs are generated from code; the docs explain
them.

| Command | What it returns |
| --- | --- |
| `wp-codebox --help` | Every CLI command and option. |
| `wp-codebox commands --json` | Every runtime and recipe command, with its accepted arguments, output shape, and policy requirement. |
| `wp-codebox schema recipe --json` | The JSON Schema for `wp-codebox/workspace-recipe/v1`. |
| `wp-codebox runtime descriptor --json` | The runtime's readiness, capabilities, services, and abilities. |
| `wp-codebox doctor --json` | Host readiness, caches, and stale runs (`--fix` or `cleanup` to reclaim). |
| `wp codebox --help` | The WP-CLI mirror of the WordPress plugin's abilities. |

## What It Runs

Runtime commands run inside the sandbox, one at a time with `run`, or as steps in
a recipe. They cover:

- **PHP and WP-CLI:** `wordpress.run-php`, `wordpress.wp-cli`, hooks, cron
  events, abilities, and REST requests.
- **Tests and checks:** plugin and core PHPUnit, Plugin Check, Theme Check, block
  rendering and block validation, and `tests/bench/*.php` benchmarks.
- **Browsers:** Playwright probes with performance budgets, scripted interaction
  journeys, multi-actor scenarios, visual comparison, layout sweeps across
  widths, editor actions, and accessibility checks.
- **Performance and scale:** server and browser page loads, `$wpdb` query
  observation, REST performance, and object-cache churn.
- **Inventory and fuzzing:** admin pages, admin actions, REST routes, frontend
  URLs, and database inventories, plus fuzzing of admin pages and plugin state.
- **Setup and state:** WordPress.org plugin and theme install, activation, site
  seeds, state bundles, and replay packages.

`wp-codebox commands --json` is the complete list.

## Ways To Drive It

| Surface | Use it for | Docs |
| --- | --- | --- |
| `run` and `boot` | One command, or a held runtime with a live preview. | [CLI reference](docs/cli-reference.md) |
| `recipe-run` | Repeatable JSON recipes: mounts, workspaces, seeds, steps, assertions, artifacts. `--dry-run` resolves the plan without booting. | [Recipe contract](docs/recipe-contract.md) |
| `bench` and `artifacts bench-*` | Benchmark matrices and baseline-versus-candidate comparison. | [Benchmark contract](docs/benchmark-contract.md) |
| `agent-task-run` | One natural-language task through a mounted agent stack, returning a patch and preview. | [Agent runtime contract](docs/agent-runtime-contract.md) |
| `run-wordpress-workload`, `run-fuzz-suite`, `adversarial` | Workloads, fuzz suites, and adversarial campaigns with replay. | [Adversarial runtime](docs/adversarial-runtime.md) |
| `artifacts`, `runs` | Verify, inspect, and recover bundles; poll or cancel recipe runs. | [Artifact bundles](docs/artifact-bundles.md) |
| TypeScript packages | Embed the runtime: `wp-codebox-workspace/core`, `/playground`, `/cli`, and friends. | [Public API contract](docs/public-api-contract.md) |
| WordPress plugin | Abilities and `wp codebox` commands for a parent site, plus the browser SDK. | [Plugin README](packages/wordpress-plugin/README.md), [WordPress plugin](docs/wordpress-plugin.md) |

## Artifact Bundles

Every run writes a content-addressed bundle: `manifest.json` with a SHA-256 for
every file, `metadata.json` with runtime and mount provenance, the changed-files
manifest and combined `patch.diff` for readwrite mounts, normalized
`test-results.json`, a renderable `review.json`, event and command logs, browser
evidence under `files/browser/`, and `blueprint.after.json` to replay the final
state. `wp-codebox artifacts verify --bundle <dir>` recomputes every hash before
you trust it. See [Artifact bundles](docs/artifact-bundles.md).

## Runtime Policy

Each run carries a `RuntimePolicy`:

```ts
const policy = {
  network: "deny", // "allow", "deny", or { allowHosts: [...] }
  filesystem: "readwrite-mounts",
  commands: ["wordpress.run-php"],
  secrets: "none",
  approvals: "never",
}
```

`commands` is enforced before every execution, and `network` gates the host HTTP
transport, PHP bridges, and external services. Recipe runs record how each field
was enforced in `files/runtime-evidence/run-attestation.json`. Secret values never
enter recipes, requests, or artifacts; callers pass environment variable names.

## Repository

| Path | Contents |
| --- | --- |
| `packages/runtime-core` | Backend-neutral contracts, schemas, policy, and artifact verification. |
| `packages/runtime-playground` | The Playground backend and its command handlers. |
| `packages/cli` | The `wp-codebox` CLI. |
| `packages/wordpress-plugin` | The parent-site plugin: abilities, WP-CLI, and the browser runtime. |
| `packages/runtime-cloudflare` | An experimental Cloudflare Workers runtime with its own package lane. |
| `examples/` | The fixture plugin, recipes, and the cookbook (multisite, WooCommerce, block themes, seeded content). |
| `docs/` | Contracts and guides, indexed in [docs/README.md](docs/README.md). |

## Development

```bash
npm run check             # build, types, and contract tests
npm run test:integration  # Playground and Docker coverage
npm run test:browser      # serial Chromium coverage
npm run test:all          # every lane, as release gates run it
npm run smoke -- --list   # focused smoke groups
```

Keep the runtime consumer-neutral: product names, scoring, and policy belong to
callers. Runtime commands are declared in
`packages/runtime-core/src/command-registry.ts` and routed to their Playground
handlers in `packages/runtime-playground/src/command-router.ts`; `commands --json`
reads the same registry. Commits follow conventional
commits; merges to `main` release automatically.

## License

MIT. See [LICENSE](LICENSE).
