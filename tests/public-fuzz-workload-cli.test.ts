import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCli } from "../packages/cli/src/cli-entry.js"

process.env.WP_CODEBOX_NO_JSPI_RESPAWN = "1"

const help = await captureStdout(async () => {
  assert.equal(await runCli(["run-fuzz-suite", "--help"]), 0)
  assert.equal(await runCli(["run-wordpress-workload", "--help"]), 0)
})
assert.match(help, /run-fuzz-suite/)
assert.match(help, /run-wordpress-workload/)
assert.match(help, /--input-file/)

const directory = await mkdtemp(join(tmpdir(), "wp-codebox-public-cli-test-"))
try {
  const samplePluginSource = join(directory, "sample-plugin")
  await mkdir(samplePluginSource)
  await writeFile(join(samplePluginSource, "sample-plugin.php"), "<?php\n/* Plugin Name: Sample Plugin */\n", "utf8")
  await mkdir(join(samplePluginSource, "bench"))
  await writeFile(join(samplePluginSource, "bench", "rest-product-batch-import.php"), `<?php
return static function ( array $input, array $args ): array {
    return array(
        'status' => 'passed',
        'observation' => array(
            'input_schema' => $input['schema'] ?? '',
            'arg_type' => $args['type'] ?? '',
        ),
        'artifactRefs' => array(
            array( 'name' => 'php-report', 'path' => 'workloads/php-report.json' ),
        ),
    );
};
`, "utf8")

  const fuzzInput = join(directory, "fuzz.json")
  await writeFile(fuzzInput, JSON.stringify({
    schema: "wp-codebox/fuzz-suite/v1",
    id: "public-cli-suite",
    cases: [{ id: "case-1", target: { kind: "command", id: "noop" }, input: {} }],
  }), "utf8")
  const fuzzOutput = await captureStdout(async () => {
    assert.equal(await runCli(["run-fuzz-suite", "--input-file", fuzzInput, "--format=json", "--dry-run"]), 0)
  })
  const fuzzJson = JSON.parse(fuzzOutput)
  assert.equal(fuzzJson.schema, "wp-codebox/fuzz-suite-result/v1")
  assert.equal(fuzzJson.metadata.public_cli_command, "run-fuzz-suite")

  const runtimeFuzzInput = join(directory, "runtime-fuzz.json")
  await writeFile(runtimeFuzzInput, JSON.stringify({
    schema: "wp-codebox/fuzz-suite/v1",
    id: "public-cli-runtime-suite",
    metadata: {
      runtime_requirements: {
        extra_plugins: [{ slug: "sample-plugin", source: samplePluginSource, path: samplePluginSource, loadAs: "plugin", source_subpath: "sample-plugin", activate: true }],
        component_contracts: [{ slug: "sample-plugin", path: samplePluginSource, loadAs: "plugin" }],
        runtime_env: { SAMPLE_ENV: "1" },
      },
    },
    cases: [{
      id: "workload",
      target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
      input: {
        schema: "wp-codebox/wordpress-workload-run/v1",
        id: "typed-workload",
        steps: [{ type: "php", code: "return array('ok' => true);" }],
      },
    }],
  }), "utf8")
  const runtimeFuzzOutput = await captureStdout(async () => {
    assert.equal(await runCli(["run-fuzz-suite", "--input-file", runtimeFuzzInput, "--format=json", "--dry-run"]), 0)
  })
  const runtimeFuzzJson = JSON.parse(runtimeFuzzOutput)
  assert.equal(runtimeFuzzJson.schema, "wp-codebox/fuzz-suite-result/v1")
  assert.equal(runtimeFuzzJson.status, "passed")
  assert.equal(runtimeFuzzJson.cases[0].status, "passed")
  assert.notEqual(runtimeFuzzJson.cases[0].skipReason, "fuzz_suite_executor_unavailable")
  assert.equal(runtimeFuzzJson.cases[0].metadata.adapter.adapterKind, "runtime-workload")
  assert.equal(runtimeFuzzJson.metadata.runnerCapabilities.mode, "runtime-backed")

  const phpRuntimeFuzzInput = join(directory, "runtime-php-workload-fuzz.json")
  await writeFile(phpRuntimeFuzzInput, JSON.stringify({
    schema: "wp-codebox/fuzz-suite/v1",
    id: "public-cli-runtime-php-workload-suite",
    metadata: {
      runtime_package_descriptor: { source: samplePluginSource },
      requiredRunnerCapabilities: { targetKinds: ["runtime"], commands: ["wordpress.run-workload"] },
    },
    cases: [{
      id: "php-workload",
      target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
      input: {
        schema: "wp-codebox/wordpress-workload-run/v1",
        steps: [{ command: "wordpress.run-workload", args: ["path=${package.root}/bench/rest-product-batch-import.php", "type=php"] }],
        staged_files: [],
      },
    }],
  }), "utf8")
  const phpRuntimeFuzzOutput = await captureStdout(async () => {
    assert.equal(await runCli(["run-fuzz-suite", "--input-file", phpRuntimeFuzzInput, "--format=json", "--dry-run"]), 0)
  })
  const phpRuntimeFuzzJson = JSON.parse(phpRuntimeFuzzOutput)
  assert.equal(phpRuntimeFuzzJson.schema, "wp-codebox/fuzz-suite-result/v1")
  assert.equal(phpRuntimeFuzzJson.status, "passed")
  assert.equal(phpRuntimeFuzzJson.cases[0].status, "passed")
  assert.equal(phpRuntimeFuzzJson.cases[0].metadata.adapter.adapterKind, "runtime-workload")
  assert.equal(phpRuntimeFuzzJson.cases[0].metadata.execution.result.json.schema, "wp-codebox/recipe-run-dry-run/v1")
  assert.equal(phpRuntimeFuzzJson.cases[0].metadata.execution.result.json.plan.workflow.steps[0].command, "wordpress.run-php")
  assert.match(phpRuntimeFuzzJson.cases[0].metadata.execution.result.json.plan.workflow.steps[0].args[0], /^code=/)
  assert.equal(phpRuntimeFuzzJson.cases[0].metadata.execution.result.json.plan.stagedFiles[0].target.includes("/tmp/wp-codebox-workloads/"), true)
  assert.equal(phpRuntimeFuzzJson.cases[0].metadata.execution.result.json.plan.stagedFiles[0].source.endsWith("bench/rest-product-batch-import.php"), true)

  const workloadInput = join(directory, "workload.json")
  await writeFile(workloadInput, JSON.stringify({
    schema: "wp-codebox/wordpress-workload-run/v1",
    capture: { queries: true },
    steps: [{ command: "wordpress.run-php", args: ["code=<?php echo 'ok';"] }],
  }), "utf8")
  const workloadOutput = await captureStdout(async () => {
    assert.equal(await runCli(["run-wordpress-workload", "--input-file", workloadInput, "--format=json", "--dry-run"]), 0)
  })
  const workloadJson = JSON.parse(workloadOutput)
  assert.equal(workloadJson.schema, "wp-codebox/recipe-run-dry-run/v1")
  assert.equal(workloadJson.dryRun, true)
  assert.deepEqual(workloadJson.plan.metadata.capture, { queries: true })
  assert.equal(workloadJson.plan.workflow.steps[0].command, "wordpress.run-php")
  const forbiddenBoundaryPattern = new RegExp(`${["home", "boy"].join("")}\\/|${["HOME", "BOY_"].join("")}|${["fuzz", "observation", "set"].join("-")}`, "i")
  assert.doesNotMatch(JSON.stringify(workloadJson), forbiddenBoundaryPattern)
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log("public fuzz/workload CLI contract passed")

async function captureStdout(callback: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  ;(process.stdout.write as typeof process.stdout.write) = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString()
    if (typeof encodingOrCallback === "function") {
      encodingOrCallback()
    } else if (callback) {
      callback()
    }
    return true
  }) as typeof process.stdout.write
  try {
    await callback()
    return stdout
  } finally {
    process.stdout.write = originalWrite
  }
}
