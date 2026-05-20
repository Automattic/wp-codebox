import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const component = resolve(root, "examples/bench-plugin")
const artifacts = resolve(root, "artifacts/bench-command-smoke")

const result = spawnSync(process.execPath, [
  cli,
  "bench-run",
  "--component",
  component,
  "--component-id",
  "bench-plugin",
  "--iterations",
  "2",
  "--warmup",
  "0",
  "--env-json",
  JSON.stringify({ BENCH_FIXTURE_ENV: "13" }),
  "--wp-config-defines-json",
  JSON.stringify({ BENCH_FIXTURE_DEFINE: "defined-value" }),
  "--workloads-json",
  JSON.stringify([
    {
      id: "configured-env",
      type: "php",
      artifacts: { report: { path: "workloads/report.json", kind: "json" } },
      code: "return array('metrics' => array('env_value' => (int) getenv('BENCH_FIXTURE_ENV'), 'define_visible' => defined('BENCH_FIXTURE_DEFINE') && BENCH_FIXTURE_DEFINE === 'defined-value' ? 1 : 0), 'metadata' => array('kind' => 'configured'));",
    },
  ]),
  "--artifacts",
  artifacts,
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(result.status, 0, result.stderr || result.stdout)

const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.equal(output.schema, "wp-codebox/bench-run/v1")
assert.equal(output.execution.command, "wordpress.bench")
assert.equal(output.benchResults.component_id, "bench-plugin")
assert.equal(output.benchResults.iterations, 2)
assert.equal(output.benchResults.warmup_iterations, 0)
assert.equal(output.benchResults.scenarios.length, 2)

const scenario = output.benchResults.scenarios[0]
assert.equal(scenario.id, "noop")
assert.equal(scenario.file, "tests/bench/noop.php")
assert.equal(scenario.iterations, 2)
assert.equal(scenario.metrics.fixture_value_mean, 7)
assert.equal(scenario.metadata.fixture, "bench-plugin")
const configured = output.benchResults.scenarios[1]
assert.equal(configured.id, "configured-env")
assert.equal(configured.source, "config")
assert.equal(configured.metrics.env_value_mean, 13)
assert.equal(configured.metrics.define_visible_mean, 1)
assert.equal(configured.metadata.kind, "configured")
assert.equal(configured.artifacts.report.path, "workloads/report.json")
assert.ok(output.artifacts?.directory)

console.log("bench command smoke passed")
