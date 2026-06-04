import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const component = resolve(root, "examples/bench-plugin")
const dependency = resolve(root, "examples/bench-dependency")
const artifacts = resolve(root, "artifacts/recipe-run-php-plugin-load-smoke")
const recipePath = resolve(artifacts, "recipe.json")

mkdirSync(artifacts, { recursive: true })
writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "recipe-run-php-plugin-load-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  inputs: {
    extraPlugins: [
      {
        source: component,
        slug: "bench-plugin",
        pluginFile: "bench-plugin/bench-plugin.php",
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
        command: "wordpress.run-php",
        args: [
          "code=if (!function_exists('wp_codebox_bench_plugin_value')) { throw new RuntimeException('component plugin function missing'); } if (!class_exists('WP_Codebox_Bench_Dependency_Fixture')) { throw new RuntimeException('extra plugin class missing'); } if (!function_exists('wp_codebox_bench_dependency_value')) { throw new RuntimeException('extra plugin function missing'); } echo wp_json_encode(array('componentValue' => wp_codebox_bench_plugin_value(), 'dependencyValue' => wp_codebox_bench_dependency_value(), 'componentActive' => is_plugin_active('bench-plugin/bench-plugin.php'), 'dependencyActive' => is_plugin_active('bench-dependency/dependency-main.php'), 'dependencyActiveAtInclude' => $GLOBALS['wp_codebox_bench_dependency_boot']['active_at_include'] ?? 0));",
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

const workflowExecution = output.executions.find((execution: { command: string; recipePhase?: string }) => execution.command === "wordpress.run-php" && execution.recipePhase === "steps")
assert.ok(workflowExecution)

const workflowResult = JSON.parse(workflowExecution.stdout)
assert.equal(workflowResult.componentValue, 7)
assert.equal(workflowResult.dependencyValue, 11)
assert.equal(workflowResult.componentActive, true)
assert.equal(workflowResult.dependencyActive, true)
assert.equal(workflowResult.dependencyActiveAtInclude, 1)

console.log("recipe run-php plugin load smoke passed")
