import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const component = resolve(root, "examples/bench-plugin")
const dependency = resolve(root, "examples/bench-dependency")
const artifacts = resolve(root, "artifacts/recipe-bench-smoke")
const recipePath = resolve(artifacts, "recipe.json")

mkdirSync(artifacts, { recursive: true })
writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    wp: "7.0",
    blueprint: {
      steps: [
        {
          step: "defineWpConfigConsts",
          consts: { BENCH_FIXTURE_DEFINE: "defined-value" },
        },
      ],
    },
  },
  inputs: {
    extraPlugins: [
      {
        source: component,
        slug: "bench-plugin",
      },
      {
        source: dependency,
        slug: "bench-dependency",
        pluginFile: "bench-dependency/dependency-main.php",
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.bench",
        args: [
          "component-id=bench-plugin",
          "plugin-slug=bench-plugin",
          "dependency-slugs=bench-dependency",
          "iterations=2",
          "warmup=0",
          `env-json=${JSON.stringify({ BENCH_FIXTURE_ENV: "13" })}`,
          `workloads-json=${JSON.stringify([
            {
              id: "configured-env",
              run: [
                { type: "wp-cli", command: "wp option update wp_codebox_bench_wp_cli yes", parse: "json" },
                {
                  type: "php",
                  code: "return array('metrics' => array('env_value' => (int) getenv('BENCH_FIXTURE_ENV'), 'define_visible' => defined('BENCH_FIXTURE_DEFINE') && BENCH_FIXTURE_DEFINE === 'defined-value' ? 1 : 0, 'wp_cli_option_visible' => get_option('wp_codebox_bench_wp_cli') === 'yes' ? 1 : 0), 'metadata' => array('kind' => 'configured'));",
                },
              ],
              artifacts: { report: { path: "workloads/report.json", kind: "json" } },
            },
          ])}`,
        ],
      },
    ],
  },
}, null, 2)}\n`)

const result = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  artifacts,
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(result.status, 0, result.stderr || result.stdout)

const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.equal(output.schema, "wp-codebox/recipe-run/v1")
assert.equal(output.executions.at(-1).command, "wordpress.bench")
assert.equal(output.benchResults.component_id, "bench-plugin")
assert.equal(output.benchResults.iterations, 2)
assert.equal(output.benchResults.warmup_iterations, 0)
assert.equal(output.benchResults.scenarios.length, 2)

const scenario = output.benchResults.scenarios[0]
assert.equal(scenario.id, "noop")
assert.equal(scenario.file, "tests/bench/noop.php")
assert.equal(scenario.iterations, 2)
assert.equal(scenario.metrics.fixture_value_mean, 7)
assert.equal(scenario.metrics.rest_route_visible_mean, 1)
assert.equal(scenario.metrics.included_before_plugins_loaded_mean, 1)
assert.equal(scenario.metrics.included_before_init_mean, 1)
assert.equal(scenario.metrics.plugins_loaded_callback_count_mean, 1)
assert.equal(scenario.metrics.init_callback_count_mean, 1)
assert.equal(scenario.metrics.dependency_value_mean, 11)
assert.equal(scenario.metrics.dependency_class_visible_mean, 1)
assert.equal(scenario.metrics.dependency_active_mean, 1)
assert.equal(scenario.metrics.dependency_active_at_include_mean, 1)
assert.equal(scenario.metrics.dependency_plugins_loaded_callback_count_mean, 1)
assert.equal(scenario.metrics.dependency_init_callback_count_mean, 1)
assert.equal(scenario.metadata.fixture, "bench-plugin")
const configured = output.benchResults.scenarios[1]
assert.equal(configured.id, "configured-env")
assert.equal(configured.source, "config")
assert.equal(configured.metrics.env_value_mean, 13)
assert.equal(configured.metrics.define_visible_mean, 1)
assert.equal(configured.metrics.wp_cli_option_visible_mean, 1)
assert.equal(configured.metadata.kind, "configured")
assert.equal(configured.artifacts.report.path, "workloads/report.json")
assert.ok(configured.artifactRefs.some((ref: { path: string; source: string }) => ref.path === "workloads/report.json" && ref.source === "scenario-artifact"))
assert.ok(configured.artifactRefs.some((ref: { path: string; source: string; metric?: string }) => ref.path === "files/bench-results.json" && ref.source === "metric-source" && ref.metric === "env_value_mean"))
assert.ok(output.artifacts?.directory)

const benchmarkArtifact = JSON.parse(readFileSync(join(output.artifacts.directory, "files", "bench-results.json"), "utf8"))
assert.equal(benchmarkArtifact.schema, "wp-codebox/benchmark-artifacts/v1")
assert.equal(benchmarkArtifact.scenarios.find((entry: { scenarioId: string }) => entry.scenarioId === "configured-env").artifactRefs.length, configured.artifactRefs.length)

const benchmarkArtifacts = spawnSync(process.execPath, [
  cli,
  "artifacts",
  "benchmark",
  "--bundle",
  output.artifacts.directory,
  "--scenario-id",
  "configured-env",
  "--json",
], { cwd: root, encoding: "utf8" })
assert.equal(benchmarkArtifacts.status, 0, benchmarkArtifacts.stderr || benchmarkArtifacts.stdout)
const benchmarkArtifactsOutput = JSON.parse(benchmarkArtifacts.stdout)
assert.equal(benchmarkArtifactsOutput.schema, "wp-codebox/benchmark-artifacts/v1")
assert.equal(benchmarkArtifactsOutput.scenarioId, "configured-env")
assert.equal(benchmarkArtifactsOutput.scenarios.length, 1)
assert.ok(benchmarkArtifactsOutput.artifactRefs.some((ref: { path: string }) => ref.path === "workloads/report.json"))

console.log("recipe bench smoke passed")
