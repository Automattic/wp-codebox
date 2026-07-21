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
          return `STAGE_FATAL:bootstrap:Bootstrap failed with token: ${secret} ${"x".repeat(25_000)}`
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

const encodedBootstrap = submittedCode.match(/base64_decode\("([A-Za-z0-9+/=]+)"\)/)?.[1]
assert.ok(encodedBootstrap, "PHPUnit payload must execute inside the bootstrap diagnostic wrapper")
const decodedBootstrap = Buffer.from(encodedBootstrap, "base64").toString("utf8")
const preBootstrapRecorder = decodedBootstrap.indexOf("STAGE_FATAL:bootstrap:")
const wordpressBootstrap = decodedBootstrap.indexOf("require_once '/wordpress/wp-load.php';")
assert.ok(preBootstrapRecorder >= 0 && preBootstrapRecorder < wordpressBootstrap, "fatal diagnostics must be recorded before the WordPress bootstrap boundary")

console.log("phpunit runtime failure diagnostics ok")
