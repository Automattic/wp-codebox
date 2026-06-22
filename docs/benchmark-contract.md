# Benchmark Contract

WP Codebox provides a generic benchmark substrate for disposable WordPress
runtimes. It owns workload execution, normalized metric envelopes, runtime
evidence, and artifact extraction helpers. Callers own product semantics such as
scenario catalogs, scoring, grading, model comparison, reward policy, retry
policy, and reports.

```text
caller benchmark suite
  -> writes a WP Codebox recipe
  -> runs recipe-run in an isolated WordPress runtime
  -> receives recipe output plus artifact bundle
  -> extracts generic benchmark results
  -> applies caller-owned scoring/reporting outside WP Codebox
```

## WP Codebox Responsibilities

- Execute declared recipe steps in a disposable WordPress runtime.
- Register generic benchmark commands such as `wordpress.bench`.
- Capture runtime artifacts, command logs, browser evidence, and provenance.
- Emit `benchResults` and `benchResultsList` in `wp-codebox/recipe-run/v1` JSON output when `wordpress.bench` steps succeed.
- Provide CLI helpers that extract benchmark envelopes from saved `recipe-run` output or artifact bundles.
- Provide CLI/API helpers that compare compatible baseline/candidate benchmark envelopes and emit generic deltas plus diagnostics.
- Keep helper output stable, JSON-friendly, and free of product-specific scoring fields.

## Caller Responsibilities

- Define the suite, scenario ids, task taxonomy, expected behavior, and run matrix.
- Decide which metrics matter and how to compare them.
- Score, grade, rank, retry, regress, or publish benchmark reports.
- Store durable benchmark history and model/product metadata.
- Interpret browser metrics or runtime artifacts in a product-specific context.

## Workloads

`wordpress.bench` currently supports plugin workloads discovered from
`tests/bench/*.php` plus explicit `workloads-json` entries. Workloads can run PHP
code and, through configured workload steps, WP-CLI commands. Each workload
returns numeric metrics directly or an object with `metrics` and `metadata`.

The command contract is intentionally broad enough for future workload types:

- **PHP:** direct workload callables and inline configured workload steps.
- **WP-CLI:** configured workload steps that execute in the same sandbox.
- **Ability:** future ability-backed workload steps should still return generic numeric metrics and metadata.
- **REST:** configured `rest-request` steps call `rest_do_request()` in-process. A configured workload may declare `route_matrix` as a compact list of REST routes; WP Codebox expands each route into the existing `rest-request` step type.
- **REST DB query profile:** configured `rest-db-query-profiler` steps run one or more REST request cases, bracket each request with `$wpdb->queries`, and emit bounded, redacted query-profile metrics and artifacts.
- **Database inventory:** configured `db-inventory` steps collect table, row, column, index, and byte-count inventory through the benchmark artifact path.
- **Browser:** `wordpress.browser-probe` captures generic browser performance and memory artifacts. When a recipe runs browser probes before `wordpress.bench`, selected numeric `browser_*` metrics are promoted into each benchmark scenario while raw browser artifacts remain in the bundle.

## REST DB Query Profiler

`rest-db-query-profiler` is a configured workload step for API/database profiling
suites that need per-request query evidence without caller-owned PHP glue. It
accepts `rest_request_cases` or `request_cases`; when neither is supplied, the
step itself is treated as a single REST request case. Each case uses the same
REST request fields as `rest-request`: `id`, `case_id`, `method`, `path` or
`route`, `params`, `headers`, `body`, `body-json`, `capture-response`,
`metric-prefix`, and `metadata`.

The profiler enables `$wpdb->save_queries` for the duration of the step, records
only queries captured after each `rest_do_request()` call starts, then restores
the previous `$wpdb->save_queries` value. Query samples are bounded by
`sampleLimit` and redacted/truncated by `queryLengthLimit` before being included
in the inline `rest-db-query-profile` artifact.

```json
{
  "id": "rest-db-profile",
  "source": "config",
  "run": [
    {
      "type": "rest-db-query-profiler",
      "rest_request_cases": [
        {
          "id": "items-search",
          "method": "GET",
          "path": "/example/v1/items",
          "params": { "search": "hat" }
        }
      ],
      "sampleLimit": 25,
      "queryLengthLimit": 500
    }
  ]
}
```

The step emits numeric metrics using the selected metric prefix, including
`<prefix>_cases_count`, `<prefix>_queries_count`, and
`<prefix>_query_time_ms`. Its inline artifact uses
`wp-codebox/wordpress-rest-db-query-profile/v1` with summary counts, per-case
query summaries, operation breakdowns, and redacted SQL/caller samples. When
artifact collection is enabled, WP Codebox materializes this into
`files/bench/<component-id>/<scenario-id>-rest-db-query-profile.json` as
`wp-codebox/benchmark-rest-db-query-profile/v1` and adds a typed
`benchmark-rest-db-query-profile` artifact reference named
`rest-db-query-profile`.

## REST Route Matrices

Route-matrix workloads are for API profiling suites that want one benchmark
scenario to cover a bounded set of REST routes without writing PHP glue. Each
entry maps directly to a `rest-request` workload step and supports `method`,
`path` or `route`, `params`, `headers`, `body`, `body-json`, `capture-response`,
`metric-prefix`, and `metadata`. When `metric-prefix` is omitted and `id` is
present, WP Codebox derives a `rest_<id>` prefix and then applies the normal
metric-prefix sanitization.

`capture-response` captures response metadata for benchmark evidence. WP Codebox
records the UTF-8 byte length and a bounded JSON shape summary rather than the
response body.

```json
{
  "id": "rest-catalog",
  "source": "config",
  "route_matrix": [
    {
      "id": "items-list",
      "method": "GET",
      "path": "/example/v1/items",
      "params": { "per_page": 10 },
      "capture-response": true
    },
    {
      "id": "item-detail",
      "method": "GET",
      "route": "/example/v1/items/123"
    }
  ],
  "artifacts": {
    "route-summary": {
      "path": "bench/rest-route-summary.json",
      "kind": "json",
      "source": "scenario-artifact"
    }
  }
}
```

The route-matrix contract is generic: callers decide which routes represent a
product suite, how fixtures are installed, whether captured responses are safe to
persist, and how route-level metrics are scored. WP Codebox only executes the
requests, records numeric timing/status metrics, carries declared scenario
artifacts, and exposes the results through the normal benchmark summary and
artifact extraction commands.

When artifact collection is enabled, WP Codebox also materializes a bounded
scenario artifact for route-matrix workloads at
`files/bench/<component-id>/<scenario-id>-route-matrix-summary.json`. The artifact
uses `wp-codebox/benchmark-route-matrix-summary/v1` and records one entry per
route step with generic fields: route index/id, method, path/route,
status, duration, and a redacted response summary. Captured response bodies are
not persisted in this artifact; they are replaced with UTF-8 byte counts and a
bounded JSON shape summary. The scenario receives a typed
`benchmark-route-matrix-summary` artifact reference named `route-matrix-summary`.

## Result Shape

The benchmark envelope is a JSON object with generic fields:

```json
{
  "component_id": "bench-plugin",
  "iterations": 3,
  "warmup_iterations": 1,
  "scenarios": [
    {
      "id": "noop",
      "source": "file",
      "iterations": 3,
      "metrics": {
        "duration_ms_mean": 1.23,
        "peak_memory_bytes_mean": 123456
      },
      "metadata": {},
      "artifacts": {}
    }
  ]
}
```

Metrics are numeric and named by the workload/runtime surface. WP Codebox records
them; it does not decide whether a value is good, bad, passing, failing, or
regressed.

## Running Benchmarks

Use a recipe workflow step with `wordpress.bench`:

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/bench-plugin.json \
  --artifacts ./artifacts/bench-plugin \
  --json > ./artifacts/bench-plugin/recipe-run.json
```

The `recipe-run` JSON output includes `benchResults` when exactly one successful
`wordpress.bench` step ran, and `benchResultsList` when one or more benchmark
steps ran.

## Extracting Results

Summarize saved `recipe-run` JSON:

```bash
npm run wp-codebox -- bench summarize \
  --input ./artifacts/bench-plugin/recipe-run.json \
  --json
```

Summarize an artifact bundle by reading its command log:

```bash
npm run wp-codebox -- artifacts bench-results \
  --bundle ./artifacts/bench-plugin \
  --json
```

Both commands emit `wp-codebox/benchmark-summary/v1` with the raw benchmark
envelopes plus a flattened scenario summary for automation:

```json
{
  "schema": "wp-codebox/benchmark-summary/v1",
  "source": { "type": "recipe-run-output", "path": "/abs/recipe-run.json" },
  "hasBenchResults": true,
  "benchmarkCount": 1,
  "scenarioCount": 1,
  "benchmarks": [],
  "scenarios": [
    {
      "componentId": "bench-plugin",
      "id": "noop",
      "source": "file",
      "iterations": 3,
      "metricCount": 2,
      "metrics": {},
      "artifacts": {}
    }
  ]
}
```

Omit `--json` for a compact human-readable table. The human form is for quick
inspection; automation should consume the JSON envelope.

## Matrix Execution

`bench matrix` runs the same benchmark recipe across an opaque cartesian product
of mechanical dimensions. Dimensions are generic; callers decide whether they
represent WordPress versions, environment maps, blueprint fragments, seeds,
mounts, viewport settings, cache modes, or other runtime knobs.

```bash
npm run wp-codebox -- bench matrix \
  --matrix ./benchmarks/matrix.json \
  --json > ./artifacts/benchmark-matrix.json
```

Matrix definitions point at a base recipe and declare dimension values. When a
value includes `value.recipe`, WP Codebox deep-merges that partial recipe into
the base recipe for the generated cell recipe. Arrays are replaced, not merged.

```json
{
  "schema": "wp-codebox/benchmark-recipe-matrix/v1",
  "recipe": "./bench-plugin.recipe.json",
  "artifacts": { "directory": "./artifacts/bench-plugin-matrix" },
  "dimensions": [
    {
      "id": "wp",
      "values": [
        { "id": "6.9", "value": { "recipe": { "runtime": { "wp": "6.9" } } } },
        { "id": "7.0", "value": { "recipe": { "runtime": { "wp": "7.0" } } } }
      ]
    },
    {
      "id": "cache",
      "values": [
        { "id": "cold", "provenance": { "cache": "cold" } },
        { "id": "warm", "provenance": { "cache": "warm" } }
      ]
    }
  ]
}
```

Each cell gets its own generated recipe, `recipe-run.json`, and artifact bundle
directory. The JSON output uses `wp-codebox/benchmark-matrix-run/v1` and groups
benchmark envelopes by cell:

```json
{
  "schema": "wp-codebox/benchmark-matrix-run/v1",
  "matrix": { "schema": "wp-codebox/benchmark-matrix/v1", "cells": [], "diagnostics": [] },
  "cells": [],
  "benchResults": [
    { "cellId": "wp:6.9__cache:cold", "cell": {}, "results": [] }
  ],
  "diagnostics": []
}
```

Failed cells remain isolated as `cell-failed` diagnostics. A failed cell does not
prevent later cells from running, and WP Codebox still does not score, grade,
rank, retry, or publish benchmark results.

## Comparing Results

Compare two saved `recipe-run` JSON outputs:

```bash
npm run wp-codebox -- bench compare \
  --baseline ./artifacts/baseline/recipe-run.json \
  --candidate ./artifacts/candidate/recipe-run.json \
  --json
```

Compare two artifact bundles by reading each bundle's command log:

```bash
npm run wp-codebox -- artifacts bench-compare \
  --baseline-bundle ./artifacts/baseline \
  --candidate-bundle ./artifacts/candidate \
  --json
```

Both commands emit `wp-codebox/benchmark-comparison/v1`. The comparison surface
is mechanical: it matches scenario ids and metric ids, compares numeric values or
`samples.mean` from metric records, emits absolute and percent deltas, carries
sample counts and stability metadata, and reports missing scenarios or metrics as
diagnostics. It does not decide whether a delta is a regression, improvement,
pass, or failure.

When a source contains multiple benchmark envelopes, select an envelope with
`--baseline-index` or `--candidate-index`.

## Non-Responsibilities

WP Codebox benchmark helpers do not define or store:

- Product benchmark suites.
- Rewards or graders.
- Pass/fail scoring policies.
- Model-eval metadata.
- Competitor comparisons.
- Historical regression decisions.
- Publishing or PR/report workflows.

Those belong to callers such as eval harnesses, product hosts, or CI systems
that project WP Codebox evidence into their own product schemas.
