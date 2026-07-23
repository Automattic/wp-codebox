import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PLUGIN_PHPUNIT_RESULT_FILE } from "../packages/runtime-playground/src/phpunit-command-handlers.js"
import { hasSuccessfulPhpunitSummary, runPhpunitCommand } from "../packages/runtime-playground/src/wordpress-command-runners.js"

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-phpunit-runtime-diagnostics-"))
const secret = "sk-abcdefghijklmnopqrstuvwxyz"
let submittedCode = ""

await assert.rejects(
  () => runPhpunitCommand({
    artifactRoot,
    mounts: [],
    runPlaygroundCommand: async (_command, _server, input) => {
      submittedCode = input.code
      return { exitCode: 0, errors: "", text: "" }
    },
    runtimeSpec: { environment: { kind: "wordpress", name: "test", version: "latest" }, policy: { commands: ["wordpress.phpunit"] } } as never,
    server: {
      playground: {
        readFileAsText: async (path: string) => {
          assert.equal(path, PLUGIN_PHPUNIT_RESULT_FILE)
          return `STAGE_FATAL:bootstrap:Bootstrap failed with token: ${secret} ${"x".repeat(25_000)}`
        },
      },
    } as never,
    spec: { command: "wordpress.phpunit", args: ["plugin-slug=demo-plugin"] },
  }),
  (error: Error) => {
    assert.match(error.message, /wordpress\.phpunit terminated before completing bootstrap/)
    assert.match(error.message, /wordpress\.phpunit structured diagnostics/)
    assert.match(error.message, /Bootstrap failed with token: \[redacted\]/)
    assert.match(error.message, /\[diagnostic truncated\]/)
    assert.doesNotMatch(error.message, new RegExp(secret))
    return true
  },
)

const captured = await readFile(join(artifactRoot, "files", "phpunit", ".pg-test-result.txt"), "utf8")
assert.match(captured, /Bootstrap failed with token: \[redacted\]/)
assert.doesNotMatch(captured, new RegExp(secret))

const encodedBootstrap = submittedCode.match(/base64_decode\("([A-Za-z0-9+/=]+)"\)/)?.[1]
assert.ok(encodedBootstrap, "PHPUnit payload must execute inside the bootstrap diagnostic wrapper")
const decodedBootstrap = Buffer.from(encodedBootstrap, "base64").toString("utf8")
const preBootstrapRecorder = decodedBootstrap.indexOf("STAGE_FATAL:bootstrap:")
const wordpressBootstrap = decodedBootstrap.indexOf("require_once '/wordpress/wp-load.php';")
assert.ok(preBootstrapRecorder >= 0 && preBootstrapRecorder < wordpressBootstrap, "fatal diagnostics must be recorded before the WordPress bootstrap boundary")

const emptySuccessArtifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-phpunit-empty-success-"))
const successfulResponseSecret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
assert.equal(hasSuccessfulPhpunitSummary("OK (1 test, 1 assertion)"), true)
assert.equal(hasSuccessfulPhpunitSummary("OK, but incomplete, skipped, or risky tests!\nTests: 21, Assertions: 27398, Skipped: 1."), true)
assert.equal(hasSuccessfulPhpunitSummary("##teamcity[testSuiteStarted name='example']\n##teamcity[testStarted name='works']\n##teamcity[testFinished name='works']\n##teamcity[testSuiteFinished name='example']"), true)
assert.equal(hasSuccessfulPhpunitSummary("##teamcity[testSuiteStarted name='example']\n##teamcity[testSuiteFinished name='example']"), false)
assert.equal(hasSuccessfulPhpunitSummary("Tests: 21, Assertions: 27398, Failures: 1."), false)
await assert.rejects(
  () => runPhpunitCommand({
    artifactRoot: emptySuccessArtifactRoot,
    mounts: [],
    runPlaygroundCommand: async () => ({
      exitCode: 0,
      errors: `PHPUnit stderr token=${successfulResponseSecret}\n${"e".repeat(25_000)}`,
      text: `WPCOM Codebox PHPUnit shutdown: mysql_port=unset\n${"x".repeat(25_000)}`,
    }),
    runtimeSpec: { environment: { kind: "wordpress", name: "test", version: "latest" }, policy: { commands: ["wordpress.phpunit"] } } as never,
    server: { playground: { readFileAsText: async () => { throw new Error("missing") } } } as never,
    spec: { command: "wordpress.phpunit", args: ["plugin-slug=demo-plugin"] },
  }),
  (error: Error) => {
    assert.match(error.message, /exited successfully without a non-zero PHPUnit test summary/)
    assert.match(error.message, /wordpress\.phpunit successful response diagnostics/)
    assert.match(error.message, /--- stderr ---/)
    assert.match(error.message, /--- stdout ---/)
    assert.match(error.message, /WPCOM Codebox \[redacted\] shutdown: mysql_port=unset/)
    assert.match(error.message, /PHPUnit stderr token=\[redacted\]/)
    assert.match(error.message, /\[stream truncated\]/)
    assert.doesNotMatch(error.message, new RegExp(successfulResponseSecret))
    assert.ok(error.message.length < 19_000, "successful response diagnostics must remain bounded")
    return true
  },
)

console.log("phpunit runtime failure diagnostics ok")
