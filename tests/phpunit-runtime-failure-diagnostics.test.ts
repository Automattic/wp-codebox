import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PLUGIN_PHPUNIT_RESULT_FILE } from "../packages/runtime-playground/src/phpunit-command-handlers.js"
import { runPhpunitCommand } from "../packages/runtime-playground/src/wordpress-command-runners.js"

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-phpunit-runtime-diagnostics-"))
const secret = "sk-abcdefghijklmnopqrstuvwxyz"
let submittedCode = ""

await assert.rejects(
  () => runPhpunitCommand({
    artifactRoot,
    mounts: [],
    runPlaygroundCommand: async (_command, _server, input) => {
      submittedCode = input.code
      return { exitCode: 1, errors: "", text: "" }
    },
    runtimeSpec: { environment: { kind: "wordpress", name: "test", version: "latest" }, policy: { commands: ["wordpress.phpunit"] } } as never,
    server: {
      playground: {
        readFileAsText: async (path: string) => {
          assert.equal(path, PLUGIN_PHPUNIT_RESULT_FILE)
          return `STAGE_FATAL:install:Bootstrap failed with token: ${secret} ${"x".repeat(25_000)}`
        },
      },
    } as never,
    spec: { command: "wordpress.phpunit", args: ["plugin-slug=demo-plugin"] },
  }),
  (error: Error) => {
    assert.match(error.message, /wordpress\.phpunit failed with exit code 1/)
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

assert.doesNotMatch(submittedCode, /eval\('\?>' \. base64_decode\(/, "runtime-only PHPUnit must not duplicate the outer bootstrap wrapper")
assert.match(submittedCode, /'schema' => 'wp-codebox\/php-fatal-diagnostic\/v1'/)
const diagnosticRegistration = submittedCode.indexOf("pg_install_diagnostics_handlers();")
const installStage = submittedCode.lastIndexOf("pg_run_install_stage(array(")
assert.ok(diagnosticRegistration >= 0 && diagnosticRegistration < installStage, "managed PHPUnit diagnostics must be installed before the runtime-owned WordPress bootstrap stage")
assert.match(submittedCode, /pg_log\('STAGE_DIE:' \. \$current_stage \. ':' \. \$buffered\)/)
assert.match(submittedCode, /pg_log\('STAGE_FATAL:' \. \$current_stage/)

console.log("phpunit runtime failure diagnostics ok")
