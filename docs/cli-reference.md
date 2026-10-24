# CLI Reference

Every `wp-codebox` command, with its arguments and output contract. The live
sources of truth are `wp-codebox --help`, `wp-codebox commands --json` (runtime
and recipe commands with their accepted arguments), and `wp-codebox schema
recipe --json`; this page explains how the commands behave.

## `commands`

Discover the supported runtime and recipe commands without launching Playground.

```bash
npm run wp-codebox -- commands --json
```

JSON output uses `wp-codebox/command-catalog/v1` and includes each command id, description, accepted args, known output shape, and runtime policy requirement. Human output is a concise command list.

## `schema recipe`

Print the JSON Schema for `wp-codebox/workspace-recipe/v1` without reading a recipe or launching Playground.
The canonical schema source is `createWorkspaceRecipeJsonSchema()` in `@automattic/wp-codebox-core`, next to the `WorkspaceRecipe` TypeScript contract; the CLI injects its current recipe command ids into that shared schema factory.

```bash
npm run wp-codebox -- schema recipe --json
```

The schema covers `runtime`, `inputs.mounts`, `inputs.workspaces`, `inputs.extra_plugins`, `inputs.secretEnv`, `workflow.steps`, and `artifacts`.

## `wordpress-source`

Materialize WordPress core source files on the host without booting a site. Tools that load core directly (for example PHP smoke tests that require `wp-includes/html-api/*`) get the same WordPress WP Codebox boots in Playground.

```bash
npm run wp-codebox -- wordpress-source --wp 7.1.2 --json
```

`--wp` accepts an exact version such as `7.1.2` or `latest` (the default). The query resolves through the same release resolver and validated archive cache Playground startup uses (`${version}.zip` in `WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR`, default `~/.wordpress-playground`). The archive is extracted once per version to `<archive cache>/source/<version>/wordpress`: extraction is staged in a sibling directory, verified against `wp-includes/version.php` (`$wp_version` must equal the resolved version), and renamed into place, so concurrent callers never observe a partial tree. Later calls reuse the verified tree.

Without `--json`, stdout is the source root path only. With `--json`, stdout is exactly one object:

```json
{"schema":"wp-codebox/wordpress-source/v1","version":"7.1.2","root":"/home/me/.wordpress-playground/source/7.1.2/wordpress","archive":"/home/me/.wordpress-playground/7.1.2.zip","sourceUrl":"https://wordpress.org/wordpress-7.1.2.zip"}
```

Diagnostics go to stderr. Failures (offline, unknown version, invalid archive) exit non-zero with a message on stderr and no stdout.

## `run`

Run one command in a disposable runtime.

```bash
npm run wp-codebox -- run \
  --mount <host-path>:<sandbox-path>[:readonly|readwrite] \
  --command <command> \
  --arg <key=value> \
  --preview-port <local-port> \
  --preview-bind 127.0.0.1 \
  --preview-public-url <public-tunnel-url> \
  --json
```

Frequently used runtime commands follow; `wp-codebox commands --json` lists every command with its accepted arguments, output shape, and policy requirement.

- `inspect-mounted-inputs`: list mounted input entries from inside Playground.
- `wordpress.run-php`: run PHP; accepts `code=<php>` or `code-file=<path>`. It can opt into bounded command diagnostics with `capture-diagnostics=wpdb-queries` or a recipe step `diagnostics` object; captured `$wpdb->queries` fingerprints are capped and linked as a `wp-codebox/command-diagnostics/v1` artifact from the command result.
- `wordpress.wp-cli`: run WP-CLI; accepts `command='wp option get home'` or plain args.
- `wordpress.ability`: execute a registered WordPress Ability; accepts `name=<ability>` and optional JSON `input=<object>`.
- `wordpress.plugin-setup`: install or list WordPress.org plugins inside the contained runtime; accepts `action=install|list`, `plugin=<slug>` or `slug=<slug>`, and optional `activate=true`/`network=true`. Paths, URLs, and package files are rejected.
- `wordpress.plugin-state`: report, activate, or deactivate an installed plugin inside the contained runtime; accepts `action=report|status|activate|deactivate` plus `plugin`, `slug`, `file`, or a plugin-contained `path`.
- `wordpress.ensure-plugin-active`: ensure an installed plugin is active inside the contained runtime; accepts `plugin`, `slug`, `file`, or a plugin-contained `path`, and uses the same activation contract as `wordpress.plugin-state action=activate`.
- `wordpress.theme-setup`: install, switch, or list WordPress.org themes inside the contained runtime; accepts `action=install|switch|list`, `theme=<slug>` or `slug=<slug>`, and optional `activate=true`. Paths, URLs, and package files are rejected.
- `wordpress.phpunit`: run a mounted plugin's PHPUnit suite; accepts `plugin-slug=<slug>` (or explicit `code`/`code-file`) plus `test-file`, `autoload-file`, `tests-dir`, and `phpunit-xml`.
- `wordpress.core-phpunit`: run WordPress core's PHPUnit suite against a mounted `wordpress-develop` checkout; accepts `core-root`, `tests-dir`, `phpunit-xml`, `test-file`, `autoload-file`, and `multisite`. **Precondition:** the mounted checkout must already have Composer dev dependencies installed — see below.
- `wordpress.simulated-admin-page-load` and `wordpress.simulated-frontend-page-load`: simulate admin/frontend page loads in-process.
- `wordpress.server-page-load`: load `surface=admin|frontend` plus `path=<path>` or `url=<path-or-url>` through the live preview HTTP server without a browser. Its performance observation is marked `source=server-http` and `kind=server-page-load`.
- `wordpress.browser-page-load`: load `surface=admin|frontend` plus `path=<path>` or `url=<path-or-url>` in Playwright by wrapping `wordpress.browser-probe`.
- `wordpress.browser-probe`: boot the live preview, visit `url=<path-or-url>` with Playwright, and capture generic browser replay/audit evidence under `files/browser/`.
- `wordpress.browser-actions`: boot the live preview, drive it with an ordered interaction script (`steps-json`) or bounded adaptive exploration, optionally classify accessibility/keyboard/focus failures, and capture replay/audit evidence under `files/browser/`.

`wordpress.run-php` loads `/wordpress/wp-load.php` by default. Use `--arg bootstrap=none` for raw PHP.

`wordpress.wp-cli` automatically enables Playground's `wp-cli` extra library when the command is allowed by runtime policy.

`wordpress.core-phpunit` **requires the mounted `wordpress-develop` checkout to already have its Composer dev dependencies installed** before you mount it. WordPress core's `tests/phpunit/includes/bootstrap.php` hard-requires the test toolchain (PHPUnit plus the Yoast PHPUnit Polyfills at `vendor/yoast/phpunit-polyfills/phpunitpolyfills-autoload.php`) and `die()`s if it is absent — a freshly cloned `wordpress-develop` tree has **no `vendor/`**. Run `composer install` (or `composer update -W`) inside the checkout first, or mount a checkout that already has `vendor/`. WP Codebox does **not** silently fetch these dependencies for you (sandbox network downloads remain gated behind `WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS=1`). When the toolchain is missing, the command now fails with a clear, structured error naming the missing paths instead of crashing with an opaque "crashed before producing a structured response" — the pre-flight check runs before core's bootstrap, and a mid-`require` `die()` is captured via output buffering + a shutdown handler so diagnostics always reach `files/core-phpunit/.pg-test-result.txt`.

## Bounded Host Node Heap Profiles

Memory-heavy recipes can declare a bounded V8 old-space requirement under `runtime.hostNodeHeap`:

```json
"hostNodeHeap": { "minimumMiB": 12288, "maximumMiB": 16384 }
```

`recipe-run` compares this profile with Node's effective V8 heap limit before boot. When insufficient, it prints the supported replay option. Replay through WP Codebox:

```sh
wp-codebox recipe-run --recipe recipe.json --host-node-heap-mb=12288
```

The option must remain within the profile bounds; WP Codebox never selects an unbounded heap. Runtime failure evidence distinguishes host V8 heap exhaustion from PHP.wasm memory exhaustion.

`wordpress.browser-probe` accepts `wait-for=domcontentloaded|load|networkidle|selector:<selector>|duration`, `duration=<n>s`, `viewport=<width>x<height>` (for example `viewport=390x844`), `pre-page-script=<js>`, repeated `assert=<assertion>` arguments, and `capture=console,errors,html,network,performance,memory,screenshot`. Use `pre-page-script` for controlled capability mocks that page scripts must observe during startup, such as `ApplePaySession`, `PaymentRequest`, wallet availability probes, or other browser/payment feature state. The script is installed with Playwright before navigation and before application scripts run; artifact summaries preserve only its SHA-256 and byte length, not the source. Assertions support `exists:<selector>`, `not-exists:<selector>`, `visible:<selector>`, `hidden:<selector>`, `count:<selector><op><number>`, `text:<selector> contains <text>`, `attr:<selector>[name][=value]`, `no-console-errors`, `no-page-errors`, and `no-errors`; prefix with `advisory:` to record a failing assertion without failing the probe. Assertion results are included in the command JSON and `summary.json`, and non-advisory failures fail the command after artifacts are written. It records machine-readable evidence refs such as `files/browser/console.jsonl`, `files/browser/errors.jsonl`, `files/browser/network.jsonl`, `files/browser/performance.json`, `files/browser/memory.json`, `files/browser/checkpoints.jsonl`, `files/browser/snapshot.html`, `files/browser/screenshot.png`, and `files/browser/summary.json` when those captures are enabled. The summary includes requested/final URLs, effective viewport/device metadata, optional pre-page script metadata, HTML and screenshot hashes, assertion results, network event counts, optional final/peak browser memory and performance summaries, and a generic `artifact-backed|partial|diagnostic-only` replayability classification. Performance and memory captures use generic browser/CDP data only: JS heap when available, CDP `Performance.getMetrics`, CDP DOM counters, DOM/resource counts and byte totals, and long task counts/duration. Probe scripts may call `window.__wpCodeboxProbeCheckpoint(name, metadata)` when `performance` or `memory` capture is enabled to record named generic checkpoint snapshots. WP Codebox intentionally keeps these browser evidence fields generic; consumers such as eval harnesses may interpret them without WP Codebox adding scoring, grading, or benchmark semantics.

`wordpress.layout-sweep` measures caller-supplied containers and items across a continuous width range. It is not tied to a specific block. Pass `url`, `container-selector`, and `item-selector` (`:scope` is evaluated against each container). Optional inputs are `min-width` (320), `max-width` (1920), `profile=quick|deep`, `seed`, `concurrency`, `timeout`, and `scenarios`. Core scenarios are `sweep`, `history`, `storm`, `heights`, and `drag`. Perturbations are `text-scale:<percent>`, `block-fonts`, `long-text:<ratio>`, and `dpr:<n>`. Defaults are `sweep,history,storm,heights`. A width is settled when two consecutive animation frames report identical geometry; settling does not use timers. The quick profile sweeps a 16px grid, bisects mode or finding changes to 1px, and narrows height deviations until they are 2px apart. Container mode is read from the custom property named by `mode-property` (default `--layout-mode`), so a caller can point it at a component's own breakpoint signal, such as `--canvas-viewport`.

Finding kinds are `overflow` (text glyph extents past the item, measured with Range client rects), `leak` (text past the container), `overlap` (new relative to the widest width in the same mode), `collapsed`, `tiny-text`, `distort`, `hscroll`, `jump`, `hysteresis`, `history`, `storm`, `unstable`, and `error`. Page errors and console errors are findings; 4xx assets are listed separately by URL. `accepted` is a JSON array of `{kind, container, item}` identities reported as `suppressed`. The command emits `wp-codebox/layout-sweep/v1` plus `files/browser/layout-sweep/summary.json` and `files/browser/layout-sweep/findings.json`. Each group is a `wp-codebox/layout-sweep-finding/v1` record with a stable identity of kind + container + item, with scenarios, count, width range, worst magnitude, sample, and replay args. `drag` reports CDP layout, style, and script time per step. Findings never fail the command; `status` is `failed` when any group is unsuppressed and consumers such as a fuzz gate apply pass/fail policy, as with `wordpress.visual-compare`. The same seed reproduces the same report.

`wordpress.visual-compare` URL captures default to `reduced-motion=true`, `animations=freeze`, and `block-external-requests=true`. Use `frozen-time=<timezone-bearing ISO-8601>` to make page wall-clock time deterministic. Accepted inputs use `YYYY-MM-DDTHH:mm:ss(.sss)(Z|+HH:MM)` and evidence records the canonical UTC millisecond value, such as `2020-01-01T00:00:00.000Z`. Use `capture-style=<CSS>` for a bounded 16 KiB capture-only stylesheet. The summary records the effective capture contract, actual viewport, blocked and failed request outcomes, readiness duration, and font readiness. Layout diagnostics classify an identical y-offset across at least two unchanged in-flow anchors as an `anchor-proven global origin offset`; height, gap, added/removed, and non-uniform offset changes remain reflow evidence.

For synthetic web performance investigations, enable `capture=performance` and use `profile=low-end-mobile-slow-4g` or `throttle=low-end-mobile-slow-4g` to apply a deterministic Chromium CPU/network profile before navigation. Performance artifacts include navigation timing, TTFB, FCP, LCP, resource timing, long tasks, CLS, and DOM metrics. Budget assertions may use promoted `browser_*` metric names or short web-performance aliases, for example `assert=lcp_ms<=2500`, `assert=fcp_ms<=1800`, `assert=ttfb_ms<=800`, and `assert=nav_duration_ms<=5000`.

`navigate-host=<hosts>` explicitly permits top-level navigation to the listed external hosts for `wordpress.browser-probe`, `wordpress.browser-actions`, and `wordpress.browser-scenario`. It is separate from `allow-host`: navigability does not grant access to other network requests, and redirects to unlisted external hosts remain blocked. The network-policy summary records the navigable host list. `allow-host` continues to grant network access under the network policy but does not by itself permit external top-level navigation.

`wordpress.browser-actions` drives the preview with an ordered interaction script so Codebox can prove a plugin still *works* under interaction, not just that it renders. Pass the script as `steps-json=<array>` (inline JSON, or `@<path>` to read it from a file). Each step is a thin, stable mapping over a Playwright locator action — this is not a test-runner DSL.

Action journeys and adaptive exploration can declare their browser context with `browser-environment-json=<object>` (inline or `@<path>`) or the compatible `device`, `viewport`, `device-scale-factor`, `is-mobile`, `has-touch`, `user-agent`, `permissions`, `locale`, `timezone`, and `geolocation-*` arguments. These controls are applied when the Playwright context is created, so mobile/touch emulation and granted, denied, or prompt geolocation remain active for the full journey. Action summaries keep requested configuration, provider-resolved configuration, and browser-observed state separate, with explicit unsupported and inconclusive dimensions. `wordpress.browser-scenario` accepts the same arguments or an `environment` object inside `scenario-json`; probe collection and authored actions share one owned context/page, while multi-actor scenarios create one isolated configured context per actor.

For `wordpress.browser-actions capture=video`, `video-size=<width>x<height>` sets the WebM recording dimensions without changing its format or encoding. When omitted, recordings use the CSS viewport size. Playwright's recorder captures at CSS pixels and pads any larger frame, so `video-size` can only scale a recording down; upscale with an encoder afterwards when a higher-resolution output is needed. Requested dimensions are capped at 8,294,400 pixels total with aspect ratio preserved. Video step records include `videoOffsetMs: { startMs, endMs }` relative to recording start; named `screenshot` steps and steps with a non-empty free-form `marker` label appear in the `video.markers` timeline in `action-summary.json`.

Step kinds: `navigate` (`url`, optional `waitFor=domcontentloaded|load|networkidle`), `click`/`hover` (`selector` or `text`), `fill`/`type` (`selector`, `value`), `press` (`key`, optional `selector`), `drag` (`from` selector, `to` as `{ "selector": ... }` or `{ "x": n, "y": n }`), `select` (`selector`, `value` or `values`), `scroll` (`selector`, `position=top|bottom`, or `by: {x,y}`), `waitFor` (`selector` or `waitFor=domcontentloaded|load|networkidle|duration|selector:<sel>`), `evaluate` (`expression`, optional `assert` to deep-equal the result), `expect` (`selector`, optional `state=visible|hidden|attached|detached|enabled|disabled|checked|unchecked|editable`), `annotate` (highlight, spotlight, arrow, anchored label, fixed caption, or clear), and `screenshot` (optional `name` and boolean `fullPage`; defaults to `true`, except with `capture=video` when it defaults to `false` to keep viewport-sized video frames. Set `fullPage: true` explicitly to request a full-document screenshot while recording). Every step may set its own `timeout=<n>s`; the command also accepts a global `step-timeout=<n>s` (per step) and `timeout=<n>s` (total-script budget). Both are bounded and deterministic — the run stops cleanly on the first failing step, with no silent partial success.

Annotations render in a pointer-transparent, isolated shadow overlay and do not require the `evaluate` policy grant. They follow element targets through scrolling. Use `id` to replace or later clear an annotation, `durationMs` for automatic removal, `animate` (`fade`, `draw`, or `none`), and run-level `annotation-theme-json=<object|@file>` (`accentColor`, `textColor`, `background`, `fontFamily`, `fontSize`, `strokeWidth`, `radius`) to customize appearance. Arrow `direction` identifies the side/corner from which the SVG arrow points toward its target. A full journey can sequence generic callouts and clear them when finished:

```jsonc
[
  { "kind": "navigate", "url": "/" },
  { "kind": "annotate", "id": "focus", "shape": "highlight", "selector": "button.save", "style": { "variant": "ring", "padding": 8 } },
  { "kind": "annotate", "shape": "label", "text": "Select this control to continue", "anchor": { "selector": "button.save", "placement": "top" } },
  { "kind": "annotate", "shape": "arrow", "selector": "button.save", "direction": "bottom-left", "animate": "draw" },
  { "kind": "click", "selector": "button.save" },
  { "kind": "annotate", "shape": "caption", "text": "Changes are saved", "position": "bottom", "durationMs": 1800 },
  { "kind": "annotate", "clear": ["focus"] }
]
```

Opt in to human-paced presentation with `presentation-json=<object>` (or `@<path>`). It supports `pointer: { enabled, style: "arrow"|"dot"|"touch", size, color }`, `clickFeedback: "ripple"|"pulse"`, `motion: { moveDurationMs, easing }`, and `typing: { delayMs, applyToFill }`. The pointer lives in an isolated, non-hit-testable shadow overlay and is reinstalled at document startup on navigation. Presentation actions bring targets into view and move to their center; typing is character-paced, while fills remain instant unless `applyToFill` is true. Add a `scroll` step with `selector`, `position: "top"|"bottom"`, or `by: {x,y}`, plus optional `behavior`, `durationMs`, and `block`; scrolling waits for the viewport to settle.

```json
{"steps-json":[{"kind":"scroll","selector":"#details","behavior":"smooth"},{"kind":"click","selector":"#continue"}],"presentation-json":{"pointer":{"enabled":true,"style":"dot","color":"#e11d48"},"clickFeedback":"ripple","motion":{"moveDurationMs":350},"typing":{"delayMs":45}}}
```

The arbitrary-JS `evaluate` step is policy-gated **separately** from the non-JS interaction steps: a script containing `evaluate` requires `wordpress.browser-actions.evaluate` in the runtime policy in addition to `wordpress.browser-actions`. Click/fill/drag/expect and friends never require the extra grant, so a consumer can allow UI driving while still forbidding arbitrary page JS.

It records `files/browser/steps.jsonl` (per-step index, kind, selector, ok/fail, timing, and any named screenshot), `files/browser/action-summary.json` (with a machine-readable `assertions` block of `total`/`passed`/`failed` plus each `expect`/`evaluate` result), named `files/browser/screenshot-<name>.png` captures, and optional `console`, `errors`, `network`, `html`, and `screenshot` artifacts (capture defaults to `steps,console,errors,network,html,screenshot`; `actions` is accepted as an alias for `steps`). Failures identify the failed step index/kind in `steps.jsonl`, include serialized browser errors, and still write the requested audit artifacts when possible. Existing navigate-only invocations (just `url=`, no `steps-json`) behave exactly as before.

```jsonc
// steps-json: open the editor, drive the crop modal, assert it still works, capture it
[
  { "kind": "click",      "selector": "role=button[name='Social']" },
  { "kind": "waitFor",    "selector": ".reactEasyCrop_Container" },
  { "kind": "drag",       "from": ".reactEasyCrop_CropArea", "to": { "x": 40, "y": 40 } },
  { "kind": "fill",       "selector": "#caption", "value": "smoke test" },
  { "kind": "evaluate",   "expression": "document.querySelector('.crop').isConnected", "assert": true },
  { "kind": "expect",     "selector": ".crop-confirm", "state": "visible" },
  { "kind": "screenshot", "name": "after-crop" }
]
```

WP Codebox defaults to WordPress `latest` because the agent and AI plugin stacks need the current WordPress runtime surface. Override with `--wp trunk`, `--wp nightly`, or another supported runtime version.

`--preview-port` fixes the local WP Codebox proxy port for tunnel/proxy wiring. Omit it to keep the current random-port behavior from the runtime backend. `--preview-bind` changes that fixed-port proxy bind address and requires `--preview-port`; it does not change the backend server bind. `--preview-public-url` is metadata and site-url alignment only; it does not make a loopback-only preview reachable without a tunnel/proxy or explicit proxy bind.

## `boot`

Boot a disposable contained WordPress runtime for interactive sandbox review without running a workflow step.

```bash
npm run wp-codebox -- boot \
  --mount <host-path>:<sandbox-path>[:readonly|readwrite] \
  --blueprint ./playground-blueprint.json \
  --artifacts ./artifacts \
  --preview-hold-seconds 15m \
  --preview-port 4173 \
  --preview-public-url https://example-tunnel.test/ \
  --json
```

`boot` accepts the same mount, WordPress version, policy, artifact, fixed preview port, and public preview URL setup used by the runtime commands. `--blueprint` accepts inline JSON or a path to a contained-runtime blueprint JSON file. `--preview-hold-seconds` uses the same duration syntax and operator-configurable cap as `run --preview-hold-seconds`.

The JSON output uses `wp-codebox/boot/v1` and includes runtime information plus the collected artifact bundle. The artifact bundle includes preview metadata, mounted-file capture, diffs, review metadata, and lifecycle logs, but no `execution` object and no fake command entry.

## `validate-blueprint`

Validate a raw contained-runtime blueprint through WP Codebox instead of calling a backend tool directly.

```bash
npm run wp-codebox -- validate-blueprint \
  --blueprint ./playground-blueprint.json \
  --wp 7.0 \
  --artifacts ./artifacts \
  --json
```

`--blueprint` accepts inline JSON or a path to a contained-runtime blueprint JSON file. The command boots the runtime with that blueprint, captures the normal artifact bundle, and returns `wp-codebox/blueprint-validation/v1` with runtime and artifact paths. Use it in CI when the desired contract is "this blueprint boots and produces reviewable WP Codebox artifacts" rather than a recipe workflow.

## `recipe validate`

Validate a workspace recipe without launching a runtime.

```bash
npm run wp-codebox -- recipe validate \
  --recipe ./examples/recipes/simple-plugin.json \
  --json
```

Validation checks schema, source paths, extra plugin entrypoints, workspace seeds, supported workflow commands, JSON ability inputs, and command arguments.

Use `recipe validate` when you only need a pass/fail contract for authoring or CI. It does not resolve the execution plan beyond validation summaries.

## `recipe-run`

Run a repeatable recipe.

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/simple-plugin.json \
  --preview-hold-seconds 15m \
  --preview-port 4173 \
  --preview-public-url https://example-tunnel.test/ \
  --json
```

Recipes are JSON declarations for a sandbox setup plus workflow steps. They can mount existing directories, create disposable plugin/theme workspaces, activate extra plugins, allow-list selected secret environment variable names, and capture the output as artifacts. See [recipe contract](./recipe-contract.md) for the current recipe field names and assertion syntax.

Pass `--dry-run --json` to validate the same recipe and emit the resolved plan without booting Playground, creating temp workspaces, mounting files, executing commands, or writing artifacts:

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/simple-plugin.json \
  --dry-run \
  --json
```

Dry-run output uses `wp-codebox/recipe-run-dry-run/v1` and includes resolved mounts, planned workspaces, extra plugins, workflow steps with parsed and resolved command args, allowed secret environment variable names without values, and per-step policy status. Use `recipe-run` without `--dry-run` when you want the real Playground-backed execution and artifact bundle.

`inputs.extra_plugins` accepts existing local plugin directory paths and external HTTPS zip sources. Local paths keep the existing behavior: they are resolved relative to the recipe file and mounted read-only under `/wordpress/wp-content/plugins/<slug>`.

Set `loadAs` to `mu-plugin` for runtime substrate that should load as must-use infrastructure instead of appearing as a normal user-managed plugin. WP Codebox mounts those plugins under `/wordpress/wp-content/mu-plugins/wp-codebox-runtime/<slug>` and writes a `wp-codebox-runtime-loader.php` setup loader. Use this for sandbox/runtime plumbing such as agent runtimes, coding tools, and AI provider bridges. Leave user-visible site plugins as the default `plugin` load mode. Components and extra plugins may provide an explicit `pluginFile`; when omitted, WP Codebox resolves `<slug>/<slug>.php`, `<slug>/plugin.php`, then a top-level PHP file with a WordPress plugin header.

External sources are explicit and CI-safe. WP Codebox validates URL-shaped sources before Playground boots, but it downloads them only when `WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS=1` is set. Supported first-slice forms are WordPress.org plugin zip URLs and generic HTTPS `.zip` URLs:

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
        "source": "https://example.com/acme-helper.zip",
        "slug": "acme-helper",
        "pluginFile": "acme-helper/acme-helper.php"
      },
      {
        "source": "../caller-runtime-substrate",
        "slug": "caller-runtime-substrate",
        "pluginFile": "caller-runtime-substrate/caller-runtime-substrate.php",
        "activate": false,
        "loadAs": "mu-plugin"
      }
    ]
  }
}
```

WordPress.org plugin zip URLs infer the plugin slug from the zip filename. Generic HTTPS zip sources require `slug` so the sandbox mount target is deterministic. Dry-run plans and artifact provenance record the original source reference, resolved URL, source kind, and SHA-256 digest when a download occurs; temporary download paths are reported by category rather than as durable host paths.

`inputs.siteSeeds` supports bounded sandbox setup data before workflow steps run. Local `fixture` seeds import JSON objects with scoped `posts`, `terms`, `options`, anonymized `users`, media metadata, `activePlugins`, and `activeTheme`. Every record scope must be explicit through selectors and/or `maxRecords`; option scopes require a `names` allow-list; parent-site users are anonymized; media file bytes are not replayed.

The WordPress host ability also accepts `site_seeds` entries with `type: "parent_site"`. That path is opt-in: the host exports only the requested current-site scopes into a temporary JSON fixture, invokes `recipe-run`, then deletes the fixture. This is a bounded seed substrate, not a full migration engine. It does not replay full database state, comments, revisions, arbitrary meta, uploads, secrets, or source-site filesystem state.

Reprint remains a future backend candidate for full/essential parent-site snapshots. WP Codebox does not vendor or shell out to Reprint for bounded `siteSeeds` yet because Reprint is a site-scale migration engine, while this contract needs explicit per-scope limits and privacy defaults.

Mount entries may include opaque `metadata` that is preserved in runtime observations, artifact provenance, and captured mount files. Product-specific callers can use this to map sandbox paths back to source repositories without WP Codebox knowing about the caller's deployment environment:

```json
{
  "source": "/srv/site/wp-content/plugins/example",
  "target": "/wordpress/wp-content/plugins/example",
  "mode": "readwrite",
  "metadata": {
    "kind": "component",
    "slug": "example-plugin",
    "repo": "org/example-plugin",
    "default_branch": "main",
    "repo_root_relative_to_mount": ".",
    "editable": true
  }
}
```

Example recipes:

- `examples/recipes/simple-plugin.json`: mount and probe the fixture plugin.
- `examples/recipes/wp-cli.json`: prove WP-CLI commands mutate the same runtime observed by later steps.
- `examples/recipes/seeded-plugin-workspace.json`: create a disposable plugin scaffold, mutate it, and capture diffs.
- `examples/recipes/cookbook/multisite-network.json`: convert Playground to multisite, mount a plugin under test, seed two child sites, and emit network/site/admin URLs.
- `examples/recipes/cookbook/woocommerce-store.json`: realistic WooCommerce dependency shape with seeded store pages, products, customer, and order fixtures.
- `examples/recipes/cookbook/theme-block-editor.json`: realistic theme/block-editor smoke surface with a mounted theme, seeded block page, and frontend/editor/admin URLs.
- `examples/recipes/cookbook/seeded-content.json`: realistic fixture content shape with pages, posts, categories, tags, editor/author users, and preview/admin URLs.
- `examples/recipes/cookbook/bbpress-reply-editor.json`: realistic bbPress dependency shape with a seeded forum/topic and reply form.

Supported workspace seeds:

- `plugin_scaffold`: creates `<slug>.php` and `README.md`, mounted by default at `/wordpress/wp-content/plugins/<slug>`.
- `theme_scaffold`: creates `style.css`, `index.php`, and `README.md`, mounted by default at `/wordpress/wp-content/themes/<slug>`.
- `directory`: copies `seed.source` into a disposable workspace and requires an explicit sandbox `target`.

## Bench Recipes

Run `wordpress.bench` from a recipe workflow to execute plugin `tests/bench/*.php` workloads in a disposable WP Codebox runtime and emit a normalized benchmark results envelope.

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/bench-plugin.json \
  --json
```

Each workload file returns a callable. The callable may return numeric metrics directly or a payload with `metrics` and `metadata` keys. The recipe output reports duration percentiles, custom metric aggregates, peak memory, runtime artifacts, and the parsed `benchResults` object in JSON output when a single `wordpress.bench` step runs. If earlier `wordpress.browser-probe` steps in the same recipe captured generic `performance` or `memory` artifacts, `wordpress.bench` promotes selected numeric browser values into each scenario's metrics using `browser_*` names, while the raw browser artifacts remain available under `files/browser/`.

Use `bench summarize` to extract a stable automation envelope from saved `recipe-run --json` output:

```bash
npm run wp-codebox -- bench summarize \
  --input ./artifacts/bench-plugin/recipe-run.json \
  --json
```

Use `artifacts bench-results` to extract benchmark results from an artifact bundle command log:

```bash
npm run wp-codebox -- artifacts bench-results \
  --bundle ./artifacts/bench-plugin \
  --json
```

See [benchmark contract](./benchmark-contract.md) for the generic benchmark contract, result shape, artifact/provenance expectations, and the boundary between WP Codebox responsibilities and caller-owned scoring or product semantics.

## Run Lifecycle

Recipe runs also write a registry entry under the run registry directory
(`artifacts/runs` by default, or `--run-registry <dir>`). Poll it with
`wp-codebox runs status --registry <dir> --run-id <id> --json`, inspect
artifacts with `wp-codebox runs artifacts --registry <dir> --run-id <id>
--json`, and request cancellation with `wp-codebox runs cancel --registry <dir>
--run-id <id> --reason <text> --json`. The returned record keeps the existing
flat `status` field and adds `lifecycle`, a concise machine contract for
orchestrators:

```json
{
  "status": "succeeded",
  "lifecycle": {
    "schema": "wp-codebox/run-lifecycle/v1",
    "phase": "terminal",
    "terminal": true,
    "cancellable": false,
    "cancelRequested": false,
    "successful": true,
    "failed": false,
    "cancelled": false,
    "outcome": "succeeded",
    "cleanup": {
      "status": "succeeded",
      "attempts": 1
    }
  }
}
```

Orchestrators should use `lifecycle.terminal`, `lifecycle.outcome`, and
`lifecycle.cleanup.status` instead of scraping human logs. Timeout and signal
interruptions settle as `timed_out` and `cancelled` outcomes respectively.
Cancellation requests are idempotent: repeated `runs cancel` calls preserve the
first `lifecycle.cancellation.requestedAt`/`reason`, and active recipe runs
observe the request through the registry before settling as `cancelled`.

## Previews

For interactive review, pass `--preview-hold-seconds <duration>` to keep the live preview server available briefly after artifact capture. The command emits `artifacts.preview.url` and `files/review.json` includes a matching top-level `preview` object with lifecycle and expiry details. The hold cap defaults to 3600 seconds; local operators may raise it with `WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS` up to the hard 24-hour ceiling.

```bash
npm run wp-codebox -- run \
  --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin \
  --command wordpress.run-php \
  --arg code-file=./examples/simple-plugin/probe.php \
  --artifacts ./artifacts \
  --preview-hold-seconds 15m \
  --json
```

The v1 preview is a held live contained WordPress runtime. When `--preview-hold-seconds` is omitted, the preview field still records the URL observed during capture, but the runtime is destroyed on command completion and the URL is marked `expired-on-completion`. Artifact replay from `blueprint.after.json` remains partial and is a separate future preview mode.

For tunnel-first review, reserve the local port in the tunnel command and pass that same port to WP Codebox. `--preview-port <n>` makes WP Codebox expose Playground through a fixed local proxy port instead of reporting Playground's default random port, and `--preview-public-url <url>` reports the tunnel URL in `artifacts.preview.url`, `metadata.json`, and `files/review.json`.

```bash
kimaki tunnel -- sh -c 'npm run wp-codebox -- run \
  --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin \
  --command wordpress.run-php \
  --arg code-file=./examples/simple-plugin/probe.php \
  --artifacts ./artifacts \
  --preview-hold-seconds 15m \
  --preview-port 4173 \
  --preview-public-url "$TRAFORO_URL" \
  --json'
```

When a caller exposes the local Playground through a tunnel or proxy, pass `--preview-public-url <url>` to report that public URL in `artifacts.preview.url`, `metadata.json`, and `files/review.json`. WP Codebox also passes the same URL to Playground as `site-url` and defines `WP_HOME` / `WP_SITEURL` in the sandbox config, so WordPress-generated links and canonical redirects align with the public preview URL. The local proxy URL remains recorded as `preview.localUrl`. If the fixed port is already occupied, WP Codebox fails clearly with `EADDRINUSE` and the requested `--preview-port` value.

Playground's content-addressed `custom-*.zip` WordPress archives are retained separately from stable release archives and cleaned after runtime use. The custom cache defaults to a seven-day age limit, 1 GiB, and 20 archives. Configure those bounds with `WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_AGE_MS`, `WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_BYTES`, and `WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT`. Active locks and runtimes use token-owned renewable leases; configure their duration with `WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_LEASE_MS` and crashed legacy lock recovery with `WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_STALE_LOCK_MS`. All maintenance uses `WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR` when set. The Playground runtime package exports `maintainPlaygroundCustomArchiveCache()` for deterministic `diagnose`, `dry-run`, and `apply` evidence, including filesystem protections, orphan sidecars, logical bytes removed, estimated allocated inode bytes removed, and the concurrently observed filesystem free-space delta.

Remote-host previews can opt into `--preview-bind <host>` with `--preview-port`. The flag changes the WP Codebox preview proxy bind address only; the upstream runtime server remains loopback-bound until backend bind-host control is available. The default stays `127.0.0.1`. Use `--preview-bind 0.0.0.0` only behind trusted firewall, tunnel, or reverse-proxy controls because the sandbox preview is reachable for the hold duration.
