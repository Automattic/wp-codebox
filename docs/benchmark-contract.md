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
- **Browser:** `wordpress.browser-probe` captures generic browser performance and memory artifacts. When a recipe runs browser probes before `wordpress.bench`, selected numeric `browser_*` metrics are promoted into each benchmark scenario while raw browser artifacts remain in the bundle.

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

## Non-Responsibilities

WP Codebox benchmark helpers do not define or store:

- Product benchmark suites.
- Rewards or graders.
- Pass/fail scoring policies.
- Model-eval metadata.
- Competitor comparisons.
- Historical regression decisions.
- Publishing or PR/report workflows.

Those belong to callers such as wp-gym, Studio Web, Homeboy rigs, or other eval
harnesses that project WP Codebox evidence into their own product schemas.
