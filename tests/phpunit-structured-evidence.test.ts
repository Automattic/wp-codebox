import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecutionResult } from "../packages/runtime-core/src/runtime-contracts.js"
import { PlaygroundCommandCrashError } from "../packages/runtime-playground/src/playground-command-errors.js"
import { PLUGIN_PHPUNIT_RESULT_FILE } from "../packages/runtime-playground/src/phpunit-command-handlers.js"
import { buildPhpunitTestResults, parsePhpunitCompletedResult } from "../packages/runtime-playground/src/phpunit-test-results.js"
import { runPhpunitCommand } from "../packages/runtime-playground/src/wordpress-command-runners.js"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

const passedLog = completedLog({ status: "passed", total: 3, passed: 3, failed: 0, skipped: 0, assertions: 3, failures: 0, errors: 0 })
const failedLog = completedLog({ status: "failed", total: 4, passed: 1, failed: 2, skipped: 1, assertions: 2, failures: 1, errors: 1 })
assert.equal(parsePhpunitCompletedResult(passedLog)?.status, "passed")
assert.equal(parsePhpunitCompletedResult(failedLog)?.failed, 2)
assert.equal(parsePhpunitCompletedResult("STAGE_FAIL:run_tests:RuntimeException: crashed"), undefined)

const passedEvidence = buildPhpunitTestResults([execution(0)], [{ path: "files/phpunit/.wp-codebox-result.txt", result: parsePhpunitCompletedResult(passedLog)! }])
assert.equal(passedEvidence.status, "passed")
assert.deepEqual(passedEvidence.summary, { total: 3, passed: 3, failed: 0, skipped: 0, unknown: 0 })

const failedEvidence = buildPhpunitTestResults([execution(1)], [{ path: "files/phpunit/.wp-codebox-result.txt", result: parsePhpunitCompletedResult(failedLog)! }])
assert.equal(failedEvidence.status, "failed")
assert.deepEqual(failedEvidence.summary, { total: 4, passed: 1, failed: 2, skipped: 1, unknown: 0 })
assert(failedEvidence.rawLogReferences.some((reference) => reference.path === "files/phpunit/.pg-test-result.txt"))

const crashEvidence = buildPhpunitTestResults([execution(1)], [])
assert.equal(crashEvidence.status, "unknown")
assert.deepEqual(crashEvidence.summary, { total: 0, passed: 0, failed: 0, skipped: 0, unknown: 0 })

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-phpunit-structured-evidence-"))
try {
  const completedCrash = new PlaygroundCommandCrashError("wordpress.phpunit", Object.assign(new Error("PHP.run() failed with exit code 2"), { exitCode: 2 }))
  await assert.rejects(
    runPhpunitWith(completedCrash, failedLog, artifactRoot),
    (error: Error) => {
      assert.match(error.message, /failed with exit code 2/)
      assert.match(error.message, /failureClassification=runtime-command-failure/)
      assert.match(error.message, /total 4; failed 2; skipped 1/)
      assert.doesNotMatch(error.message, /crashed before producing a structured response/)
      return true
    },
  )

  const workloadCrash = new PlaygroundCommandCrashError("wordpress.phpunit", new Error("worker terminated"))
  await assert.rejects(
    runPhpunitWith(workloadCrash, "STAGE_BEGIN:run_tests\nSTAGE_FAIL:run_tests:RuntimeException: worker terminated", artifactRoot),
    (error: Error) => {
      assert.match(error.message, /crashed before producing a structured response/)
      assert.match(error.message, /failureClassification=runtime-worker-failure/)
      return true
    },
  )
} finally {
  await rm(artifactRoot, { recursive: true, force: true })
}

function runPhpunitWith(error: Error, log: string, artifactRoot: string): Promise<string> {
  return runPhpunitCommand({
    artifactRoot,
    mounts: [],
    runPlaygroundCommand: async () => { throw error },
    runtimeSpec: wordpressRuntimeSpec({ commands: ["wordpress.phpunit"] }),
    server: { playground: { readFileAsText: async (path: string) => {
      assert.equal(path, PLUGIN_PHPUNIT_RESULT_FILE)
      return log
    } } } as never,
    spec: { command: "wordpress.phpunit", args: ["plugin-slug=demo-plugin"] },
  })
}

function completedLog(result: Omit<ReturnType<typeof parsePhpunitCompletedResult> & {}, "schema">): string {
  const { passed: _passed, failed: _failed, ...aggregate } = result
  return `STAGE_BEGIN:run_tests\nWP_CODEBOX_PHPUNIT_RESULT:${JSON.stringify({ schema: "wp-codebox/phpunit-result/v1", ...aggregate })}\nSTAGE_OK:run_tests\n`
}

function execution(exitCode: number): ExecutionResult {
  return { id: "command-1", command: "wordpress.phpunit", args: [], exitCode, stdout: "", stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }
}

console.log("phpunit structured evidence ok")
