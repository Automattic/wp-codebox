import assert from "node:assert/strict"
import { createRuntime } from "../packages/runtime-core/src/index.js"
import { PlaygroundCommandCrashError, PlaygroundCommandError } from "../packages/runtime-playground/src/playground-command-errors.js"
import { createPlaygroundRuntimeBackend, type PlaygroundCliModule } from "../packages/runtime-playground/src/index.js"

const hiddenFatal = new Error("PHP.run() failed with exit code 255") as Error & {
  httpStatusCode?: number
  exitCode?: number
  stdout?: string
  stderr?: string
  response?: { body?: string; headers?: Record<string, string> }
}

hiddenFatal.httpStatusCode = 500
hiddenFatal.exitCode = 255
hiddenFatal.stdout = ""
hiddenFatal.stderr = ""
hiddenFatal.response = {
  body: "Fatal error: Uncaught RuntimeException: Local wp-admin auth fixture user could not be loaded.",
  headers: { "content-type": "text/html; charset=UTF-8" },
}

const hiddenFatalMessage = new PlaygroundCommandCrashError("wordpress.run-php", hiddenFatal).message

assert.match(hiddenFatalMessage, /wordpress\.run-php crashed before producing a structured response/)
assert.match(hiddenFatalMessage, /PHP\.run\(\) failed with exit code 255/)
assert.match(hiddenFatalMessage, /httpStatusCode=500/)
assert.match(hiddenFatalMessage, /exitCode=255/)
assert.match(hiddenFatalMessage, /--- Playground response body ---/)
assert.match(hiddenFatalMessage, /Local wp-admin auth fixture user could not be loaded/)
assert.doesNotMatch(hiddenFatalMessage, /--- Playground stdout ---\n\s*---/)
assert.doesNotMatch(hiddenFatalMessage, /--- Playground stderr ---\n\s*---/)

const nestedResponseError = new Error("Playground request failed") as Error & {
  response?: { status?: number; text?: string }
}
nestedResponseError.response = {
  status: 500,
  text: "Uncaught Error: Call to undefined function wp_codebox_missing_fixture()",
}

const nestedResponseMessage = new PlaygroundCommandCrashError("wordpress.run-php", nestedResponseError).message

assert.match(nestedResponseMessage, /status=500/)
assert.match(nestedResponseMessage, /--- Playground response text ---/)
assert.match(nestedResponseMessage, /wp_codebox_missing_fixture/)

const htmlFatal = "<br />\n<b>Fatal error</b>:  Uncaught Error: Call to a member function is_sandbox() on null in <b>/wordpress/wp-content/plugins/woocommerce-square/includes/Gateway/Cash_App_Pay_Gateway.php</b>:283\nStack trace:\n#0 {main}\n  thrown in <b>/wordpress/wp-content/plugins/woocommerce-square/includes/Gateway/Cash_App_Pay_Gateway.php</b> on line <b>283</b><br />"
const byteMap = Object.fromEntries(Array.from(Buffer.from(htmlFatal, "utf8")).map((byte, index) => [String(index), byte]))
const byteMapMessage = new PlaygroundCommandError("wordpress.bench", {
  exitCode: 255,
  text: JSON.stringify({ bytes: byteMap }),
}).message

assert.match(byteMapMessage, /wordpress\.bench failed with exit code 255/)
assert.match(byteMapMessage, /PHP fatal: Uncaught Error: Call to a member function is_sandbox\(\) on null/)
assert.match(byteMapMessage, /Location: \/wordpress\/wp-content\/plugins\/woocommerce-square\/includes\/Gateway\/Cash_App_Pay_Gateway\.php:283/)
assert.match(byteMapMessage, /Raw Playground output omitted/)
assert.doesNotMatch(byteMapMessage, /"bytes"/)
assert.doesNotMatch(byteMapMessage, /"0":\s*60/)

let receivedRunPhpCode = ""
const fakeCliModule: PlaygroundCliModule = {
  runCLI: async () => ({
    serverUrl: "http://127.0.0.1:9400",
    playground: {
      run: async (options: { code?: string }) => {
        receivedRunPhpCode = options.code ?? ""
        throw hiddenFatal
      },
    },
    close: async () => undefined,
  }),
}

const runtime = await createRuntime({
  backend: "wordpress-playground",
  environment: { kind: "wordpress", name: "hidden-fatal-smoke", version: "7.0", blueprint: { steps: [] } },
  policy: {
    network: "deny",
    filesystem: "sandbox",
    commands: ["wordpress.run-php"],
    secrets: "none",
    approvals: "never",
  },
}, createPlaygroundRuntimeBackend({ cliModule: fakeCliModule }))

await assert.rejects(
  () => runtime.execute({
    command: "wordpress.run-php",
    args: ["code=throw new RuntimeException('Local wp-admin auth fixture user could not be loaded.');"],
  }),
  (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /wordpress\.run-php crashed before producing a structured response/)
    assert.match(error.message, /httpStatusCode=500/)
    assert.match(error.message, /exitCode=255/)
    assert.match(error.message, /--- Playground response body ---/)
    assert.match(error.message, /Local wp-admin auth fixture user could not be loaded/)
    return true
  },
)

assert.match(receivedRunPhpCode, /RuntimeException/)

console.log("playground command errors smoke passed")
