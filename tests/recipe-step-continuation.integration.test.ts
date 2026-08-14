import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { withTempDir } from "../scripts/test-kit.js"

const execFileAsync = promisify(execFile)

await withTempDir("wp-codebox-recipe-continuation-integration-", async (root) => {
  const pluginDirectory = join(root, "continuation-fixture")
  const recipePath = join(root, "recipe.json")
  const timeoutRecipePath = join(root, "timeout-recipe.json")
  const artifactsPath = join(root, "artifacts")
  const timeoutArtifactsPath = join(root, "timeout-artifacts")
  await mkdir(pluginDirectory)
  await writeFile(join(pluginDirectory, "continuation-fixture.php"), `<?php
/** Plugin Name: Continuation Fixture */
add_action( 'wp_abilities_api_categories_init', static function (): void {
    wp_register_ability_category( 'example', array(
        'label' => 'Example',
        'description' => 'Abilities used by WP Codebox integration tests.',
    ) );
} );
add_action( 'wp_abilities_api_init', static function (): void {
    wp_register_ability( 'example/continue', array(
        'label' => 'Continue',
        'description' => 'Deterministic continuation fixture.',
        'category' => 'example',
        'input_schema' => array( 'type' => 'object' ),
        'output_schema' => array( 'type' => 'object' ),
        'permission_callback' => '__return_true',
        'execute_callback' => static function ( array $input ): array {
            $receipt = (string) ( $input['receipt'] ?? '' );
            if ( ! empty( $input['delay'] ) && 'opaque-1' === $receipt ) {
                usleep( 5000000 );
            }
            $next = array( 'initial' => 'opaque-1', 'opaque-1' => 'opaque-2', 'opaque-2' => 'terminal' );
            if ( ! isset( $next[ $receipt ] ) ) {
                return array( 'more' => false, 'receipt' => 'invalid', 'path' => array( $receipt ) );
            }
            return array( 'more' => 'opaque-2' !== $receipt, 'receipt' => $next[ $receipt ], 'path' => array( $receipt, $next[ $receipt ] ) );
        },
    ) );
} );
`)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "latest", blueprint: { steps: [] } },
    inputs: { extra_plugins: [{ source: pluginDirectory, slug: "continuation-fixture", activate: true }] },
    workflow: {
      steps: [{
        command: "wordpress.ability",
        args: ["name=example/continue", "input={\"receipt\":\"initial\"}"],
        continuation: {
          maxIterations: 3,
          while: { pointer: "/result/more", equals: true },
          inputMappings: [{ from: "/result/receipt", to: { arg: "input", pointer: "/receipt" } }],
        },
      }],
    },
  })}\n`)

  const command = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--json"], {
    cwd: process.cwd(),
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const output = JSON.parse(command.stdout)
  assert.equal(output.success, true, command.stdout)
  const execution = output.executions.find((candidate: { command?: string }) => candidate.command === "wordpress.ability")
  assert.equal(execution.continuationEvidence.status, "completed")
  assert.equal(execution.continuationEvidence.iterations, 3)
  assert.deepEqual(execution.continuationEvidence.executions.map((iteration: { result: { result: { receipt: string } } }) => iteration.result.result.receipt), ["opaque-1", "opaque-2", "terminal"])

  const commands = (await readFile(output.artifacts.commandsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  const abilityCalls = commands.filter((candidate) => candidate.command === "wordpress.ability")
  assert.equal(abilityCalls.length, 3)

  await writeFile(timeoutRecipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "latest", blueprint: { steps: [] } },
    inputs: { extra_plugins: [{ source: pluginDirectory, slug: "continuation-fixture", activate: true }] },
    workflow: {
      steps: [{
        command: "wordpress.ability",
        args: ["name=example/continue", "input={\"receipt\":\"initial\",\"delay\":true}"],
        timeoutMs: 2500,
        continuation: {
          maxIterations: 3,
          while: { pointer: "/result/more", equals: true },
          inputMappings: [{ from: "/result/receipt", to: { arg: "input", pointer: "/receipt" } }],
        },
      }],
    },
  })}\n`)

  let timeoutOutput: Record<string, any> | undefined
  try {
    await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", timeoutRecipePath, "--artifacts", timeoutArtifactsPath, "--json"], {
      cwd: process.cwd(),
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    assert.fail("Expected continuation recipe to time out")
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    assert.equal(typeof stdout, "string")
    timeoutOutput = JSON.parse(stdout!)
  }
  assert.equal(timeoutOutput.success, false)
  assert.equal(timeoutOutput.stepFailures[0].classification, "timeout")
  assert.equal(timeoutOutput.stepFailures[0].continuationEvidence.status, "failed")
  assert.equal(timeoutOutput.stepFailures[0].continuationEvidence.iterations, 1)
  assert.equal(timeoutOutput.stepFailures[0].continuationEvidence.diagnostics.code, "step-timeout")
})

console.log("recipe step continuation integration passed")
