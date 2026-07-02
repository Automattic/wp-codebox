import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCli } from "../packages/cli/src/cli-entry.js"

process.env.WP_CODEBOX_NO_JSPI_RESPAWN = "1"

const help = await captureStdout(async () => {
  assert.equal(await runCli(["run-fuzz-suite", "--help"]), 0)
  assert.equal(await runCli(["fuzz", "descriptor", "--help"]), 0)
  assert.equal(await runCli(["fuzz", "readiness", "--help"]), 0)
  assert.equal(await runCli(["run-wordpress-workload", "--help"]), 0)
})
assert.match(help, /run-fuzz-suite/)
assert.match(help, /fuzz descriptor/)
assert.match(help, /fuzz readiness/)
assert.match(help, /run-wordpress-workload/)
assert.match(help, /--input-file/)
assert.match(help, /--runner-mode=simple\|runtime-backed/)

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

  const descriptorOutput = await captureStdout(async () => {
    assert.equal(await runCli(["fuzz", "descriptor", "--format=json"]), 0)
  })
  const descriptorJson = JSON.parse(descriptorOutput)
  assert.equal(descriptorJson.schema, "wp-codebox/wordpress-fuzz-runtime-contract/v1")
  assert.equal(descriptorJson.publicSurfaces.nodeCli, "wp-codebox fuzz descriptor --format=json")
  assert.equal(descriptorJson.publicSurfaces.wpCli, "wp codebox wordpress-fuzz-runtime-contract")
  assert.equal(descriptorJson.actionFamilies.some((family: { commands: string[] }) => family.commands.includes("wordpress.rest-request")), true)
  assert.deepEqual(descriptorJson.destructiveModeRequirements.requiredSandboxBoundary, { disposable: true, destructivePermission: true, teardown: "discard" })
  assert.deepEqual(descriptorJson.destructiveModeRequirements.optionalResetModes, ["checkpoint-per-case", "restore-snapshot"])
  assert.equal(descriptorJson.destructiveModeRequirements.rawDeleteCapability, null)
  assert.equal(descriptorJson.unsupportedCapabilities.some((capability: { id: string }) => capability.id === "private-runtime-probing"), true)
  assert.equal(descriptorJson.hbex.schemaIds.deleteBoundaryArtifact, "wp-codebox/delete-boundary-artifact/v1")

  const readinessOutput = await captureStdout(async () => {
    assert.equal(await runCli(["fuzz", "readiness", "--format=json"]), 0)
  })
  const readinessJson = JSON.parse(readinessOutput)
  assert.equal(readinessJson.schema, "wp-codebox/fuzz-runner-readiness/v1")
  assert.equal(readinessJson.status, "ready")
  assert.equal(readinessJson.mode, "runtime-backed")
  assert.equal(readinessJson.entrypoint, "run-fuzz-suite --runner-mode=runtime-backed")
  assert.deepEqual(readinessJson.operationKinds, ["read", "crud", "mutation-isolation", "delete-boundary"])
  assert.equal(readinessJson.capabilities.capabilities.includes("delete"), false)
  assert.equal(readinessJson.capabilities.capabilities.includes("delete-boundary-artifact"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("disposable-runtime"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("runtime-isolation"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("disposable-sandbox-boundary"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("destructive-permission"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("sandbox-isolation-proof"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("external-side-effect-guardrail"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("artifact-export"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("rest-mutation:post:mutation-isolation-artifact"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("rest-mutation:put:mutation-isolation-artifact"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("rest-mutation:patch:mutation-isolation-artifact"), true)
  assert.equal(readinessJson.capabilities.capabilities.includes("rest-mutation:delete:delete-boundary-artifact"), true)
  assert.equal(readinessJson.capabilities.commands.includes("wordpress.rest-request"), true)
  assert.equal(readinessJson.capabilities.commands.includes("wordpress.fuzz-admin-pages"), true)
  assert.equal(readinessJson.capabilities.commands.includes("wordpress.fuzz-plugin-module-state"), true)
  assert.equal(readinessJson.capabilities.commands.includes("wordpress.inventory-plugin-module-options-tables"), true)
  assert.equal(readinessJson.capabilities.commands.includes("wordpress.collect-workload-result"), true)
  assert.equal(readinessJson.capabilities.runtimeActionTypes.includes("editor_insert_save"), false)
  assert.equal(readinessJson.disposable, true)
  assert.deepEqual(readinessJson.isolation, { runtime_backed: true, disposable: true, sandboxed: true })
  assert.deepEqual(readinessJson.guardrails, { external_side_effect_guardrail: true, external_http_guardrail: true })
  assert.deepEqual(readinessJson.artifacts, { artifact_export: true })
  assert.deepEqual(readinessJson.destructiveModeRequirements.requiredSandboxBoundary, { disposable: true, destructivePermission: true, teardown: "discard" })

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
        extra_plugins: [{ slug: "sample-plugin", source: samplePluginSource, path: samplePluginSource, loadAs: "plugin", activate: true }],
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
  assert.equal(runtimeFuzzJson.cases[0].metadata.execution.result.json.plan.workflow.steps[0].command, "wordpress.bench")
  const typedWorkloadsJson = runtimeFuzzJson.cases[0].metadata.execution.result.json.plan.workflow.steps[0].args.find((arg: string) => arg.startsWith("workloads-json="))
  assert.ok(typedWorkloadsJson)
  const typedWorkloads = JSON.parse(typedWorkloadsJson.replace(/^workloads-json=/, ""))
  assert.deepEqual(typedWorkloads[0].run, [{ type: "php", code: "return array('ok' => true);" }])

  const runtimeCommandFuzzInput = join(directory, "runtime-command-fuzz.json")
  await writeFile(runtimeCommandFuzzInput, JSON.stringify({
    schema: "wp-codebox/fuzz-suite/v1",
    id: "public-cli-runtime-command-suite",
    cases: [{
      id: "rest-route-inventory",
      target: { kind: "runtime", id: "wordpress.inventory-rest-routes", entrypoint: "wordpress.inventory-rest-routes" },
      input: { args: [] },
    }],
  }), "utf8")
  const runtimeCommandFuzzOutput = await captureStdout(async () => {
    assert.equal(await runCli(["run-fuzz-suite", "--input-file", runtimeCommandFuzzInput, "--format=json", "--dry-run"]), 0)
  })
  const runtimeCommandFuzzJson = JSON.parse(runtimeCommandFuzzOutput)
  assert.equal(runtimeCommandFuzzJson.schema, "wp-codebox/fuzz-suite-result/v1")
  assert.equal(runtimeCommandFuzzJson.status, "passed")
  assert.equal(runtimeCommandFuzzJson.cases[0].status, "passed")
  assert.notEqual(runtimeCommandFuzzJson.cases[0].skipReason, "fuzz_suite_executor_unavailable")
  assert.equal(runtimeCommandFuzzJson.cases[0].metadata.adapter.adapterKind, "runtime")
  assert.equal(runtimeCommandFuzzJson.cases[0].metadata.execution.result.json.schema, "wp-codebox/recipe-run-dry-run/v1")
  assert.equal(runtimeCommandFuzzJson.cases[0].metadata.execution.result.json.plan.workflow.steps[0].command, "wordpress.inventory-rest-routes")

  const phpRuntimeFuzzInput = join(directory, "runtime-php-workload-fuzz.json")
  await writeFile(phpRuntimeFuzzInput, JSON.stringify({
    schema: "wp-codebox/fuzz-suite/v1",
    id: "public-cli-runtime-php-workload-suite",
    metadata: {
      runtime_package_descriptor: { source: samplePluginSource },
      requiredRunnerCapabilities: { targetKinds: ["runtime"], commands: ["wordpress.run-workload"] },
      runtime_requirements: {
        extra_plugins: [{ slug: "sample-plugin", source: samplePluginSource, path: samplePluginSource, loadAs: "plugin", activate: true }],
        bench_env: { WC_REST_BATCH_IMPORT_ITEMS: "2" },
        settings: { fixtureMode: "small" },
      },
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
  const nestedPhpCode = phpRuntimeFuzzJson.cases[0].metadata.execution.result.json.plan.workflow.steps[0].args[0]
  assert.match(nestedPhpCode, /^code=/)
  assert.match(nestedPhpCode, /function wp_codebox_bench_run_external_http_guardrail_step/)
  const nestedPhpInput = decodeFirstWrapperJson(nestedPhpCode)
  assert.deepEqual(nestedPhpInput.bench_env, { WC_REST_BATCH_IMPORT_ITEMS: "2" })
  assert.deepEqual(nestedPhpInput.settings, { fixtureMode: "small" })
  assert.equal(phpRuntimeFuzzJson.cases[0].metadata.execution.result.json.plan.stagedFiles[0].target.includes("/tmp/wp-codebox-workloads/"), true)
  assert.equal(phpRuntimeFuzzJson.cases[0].metadata.execution.result.json.plan.stagedFiles[0].source.endsWith("bench/rest-product-batch-import.php"), true)

  const adminPhaseFuzzInput = join(directory, "runtime-admin-phase-workload-fuzz.json")
  await writeFile(adminPhaseFuzzInput, JSON.stringify({
    schema: "wp-codebox/fuzz-suite/v1",
    id: "public-cli-admin-phase-workload-suite",
    cases: [{
      id: "admin-phase-workload",
      target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
      phases: {
        setup: [{ command: "wordpress.ensure-plugin-active", args: ["plugin=sample-plugin/sample-plugin.php"] }],
        action: [{ command: "wordpress.fuzz-admin-pages", args: ["safe_methods=GET"] }],
        assert: [{ command: "wordpress.collect-workload-result", args: ["artifact=admin_page_coverage"] }],
      },
    }],
  }), "utf8")
  const adminPhaseFuzzOutput = await captureStdout(async () => {
    assert.equal(await runCli(["run-fuzz-suite", "--input-file", adminPhaseFuzzInput, "--format=json", "--dry-run"]), 0)
  })
  const adminPhaseFuzzJson = JSON.parse(adminPhaseFuzzOutput)
  assert.equal(adminPhaseFuzzJson.schema, "wp-codebox/fuzz-suite-result/v1")
  assert.equal(adminPhaseFuzzJson.status, "passed")
  assert.equal(adminPhaseFuzzJson.cases[0].status, "passed")
  assert.equal(adminPhaseFuzzJson.cases[0].metadata.adapter.adapterKind, "runtime-workload")
  assert.deepEqual(adminPhaseFuzzJson.cases[0].metadata.execution.result.json.plan.workflow.steps.map((step: { command: string }) => step.command), ["wordpress.ensure-plugin-active", "wordpress.fuzz-admin-pages", "wordpress.collect-workload-result"])

  const modulePhaseFuzzInput = join(directory, "runtime-module-phase-workload-fuzz.json")
  await writeFile(modulePhaseFuzzInput, JSON.stringify({
    schema: "wp-codebox/fuzz-suite/v1",
    id: "public-cli-module-phase-workload-suite",
    cases: [{
      id: "module-phase-workload",
      target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
      phases: {
        setup: [{ command: "wordpress.ensure-plugin-active", args: ["plugin=sample-plugin/sample-plugin.php"] }],
        action: [{ command: "wordpress.fuzz-plugin-module-state", args: ["execute_mutations=false", "mutation_mode=declared_plan"] }],
        assert: [{ command: "wordpress.collect-workload-result", args: ["artifact=module_state_matrix"] }],
      },
    }],
  }), "utf8")
  const modulePhaseFuzzOutput = await captureStdout(async () => {
    assert.equal(await runCli(["run-fuzz-suite", "--input-file", modulePhaseFuzzInput, "--format=json", "--dry-run"]), 0)
  })
  const modulePhaseFuzzJson = JSON.parse(modulePhaseFuzzOutput)
  assert.equal(modulePhaseFuzzJson.schema, "wp-codebox/fuzz-suite-result/v1")
  assert.equal(modulePhaseFuzzJson.status, "passed")
  assert.equal(modulePhaseFuzzJson.cases[0].status, "passed")
  assert.deepEqual(modulePhaseFuzzJson.cases[0].metadata.execution.result.json.plan.workflow.steps.map((step: { command: string }) => step.command), ["wordpress.ensure-plugin-active", "wordpress.fuzz-plugin-module-state", "wordpress.collect-workload-result"])

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

function decodeFirstWrapperJson(codeArg: string): Record<string, unknown> {
  const match = codeArg.match(/base64_decode\('([^']+)'\)/)
  assert.ok(match)
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"))
}

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
