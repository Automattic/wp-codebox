import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { executeBenchmarkMatrix } from "../packages/runtime-core/src/benchmark-substrate.js"
import { benchRunCode } from "../packages/runtime-playground/src/bench-command-handlers.js"

const execFileAsync = promisify(execFile)

async function withTempDir<T>(prefix: string, callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runPhpFileJson<T>(path: string): Promise<T> {
  const { stdout } = await execFileAsync("php", [path])
  return JSON.parse(stdout) as T
}

const benchResult = await withTempDir("wp-codebox-bench-skips-", async (directory) => {
  const wordpressDirectory = join(directory, "wordpress")
  const pluginDirectory = join(directory, "plugins", "component")
  await mkdir(join(wordpressDirectory, "wp-admin", "includes"), { recursive: true })
  await mkdir(join(pluginDirectory, "tests", "bench"), { recursive: true })
  await writeFile(join(wordpressDirectory, "wp-admin", "includes", "plugin.php"), "<?php\n")
  await writeFile(join(pluginDirectory, "component.php"), "<?php\n/* Plugin Name: Component */\n")
  await writeFile(join(pluginDirectory, "tests", "bench", "passed.php"), "<?php\nreturn static fn() => array('metrics' => array('work_count' => 1));\n")
  await writeFile(join(pluginDirectory, "tests", "bench", "skipped.php"), "<?php\nreturn static fn() => array('skipped' => 'missing_bench_boot_phase', 'metrics' => array('work_count' => 99));\n")

  const phpTestFile = join(directory, "bench-skips.php")
  await writeFile(
    phpTestFile,
    `<?php
define('ABSPATH', ${JSON.stringify(`${wordpressDirectory}/`)});
define('WP_PLUGIN_DIR', ${JSON.stringify(join(directory, "plugins"))});
$wp_filter = array();
function wp_json_encode($value, $flags = 0) { return json_encode($value, $flags); }
function sanitize_key($value) { return strtolower(preg_replace('/[^a-z0-9_-]/', '', $value)); }
function is_plugin_active($plugin) { return false; }
function activate_plugin($plugin) { return null; }
function is_wp_error($value) { return false; }
function get_option($name, $default = false) { return $default; }
function update_option($name, $value) { return true; }
function get_bloginfo($name) { return 'test'; }
function did_action($hook) { return false; }
${benchRunCode({ componentId: "component", pluginSlug: "component", iterations: 2, warmupIterations: 0, dependencySlugs: [], env: {}, bootstrapFiles: [], workloads: [], lifecycle: {}, resetPolicy: {} })}
`,
  )
  return runPhpFileJson<{
    completeness: { status: string; required: { total: number; passed: number; skipped: number } }
    scenarios: Array<{ id: string; status: string; skip_reason?: string; iterations: number; metrics: Record<string, unknown> }>
  }>(phpTestFile)
})

assert.deepEqual(benchResult.completeness, { status: "incomplete", required: { total: 2, passed: 1, skipped: 1 } })
const passed = benchResult.scenarios.find((scenario) => scenario.id === "passed")
const skipped = benchResult.scenarios.find((scenario) => scenario.id === "skipped")
assert.equal(passed?.status, "passed")
assert.equal(passed?.iterations, 2)
assert.ok("duration" in (passed?.metrics ?? {}))
assert.equal(skipped?.status, "skipped")
assert.equal(skipped?.skip_reason, "missing_bench_boot_phase")
assert.equal(skipped?.iterations, 0)
assert.deepEqual(skipped?.metrics, {})

const matrix = await executeBenchmarkMatrix(
  [{ id: "outcome", values: [{ id: "passed" }, { id: "skipped" }, { id: "failed" }] }],
  async (cell) => {
    const outcome = cell.dimensions.outcome?.id
    if (outcome === "failed") throw new Error("callable failed")
    return {
      scenarios: [],
      completeness: outcome === "skipped"
        ? { status: "incomplete", required: { total: 1, passed: 0, skipped: 1 } }
        : { status: "complete", required: { total: 1, passed: 1, skipped: 0 } },
    }
  },
)

assert.deepEqual(matrix.cells.map((cell) => cell.status), ["succeeded", "incomplete", "failed"])
assert.equal(matrix.benchResults.length, 2)
assert.deepEqual(matrix.diagnostics.map((diagnostic) => diagnostic.type), ["cell-incomplete", "cell-failed"])

console.log("bench skip results ok")
