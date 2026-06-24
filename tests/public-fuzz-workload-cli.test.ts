import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
