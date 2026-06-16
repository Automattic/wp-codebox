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

const emptyWpcomFatal = new Error("PHP.run() failed with exit code 255") as Error & {
  httpStatusCode?: number
  exitCode?: number
  stdout?: string
  stderr?: string
  response?: { headers?: Record<string, string> }
}

emptyWpcomFatal.httpStatusCode = 500
emptyWpcomFatal.exitCode = 255
emptyWpcomFatal.stdout = ""
emptyWpcomFatal.stderr = ""
emptyWpcomFatal.response = {
  headers: {
    "content-type": "text/html; charset=UTF-8",
    "x-powered-by": "PHP/8.4.21",
    "set-cookie": "wordpress_test_cookie=secret",
  },
}

const emptyWpcomFatalMessage = new PlaygroundCommandCrashError("wordpress.run-php", emptyWpcomFatal).message

assert.match(emptyWpcomFatalMessage, /wordpress\.run-php crashed before producing a structured response/)
assert.match(emptyWpcomFatalMessage, /PHP\.run\(\) failed with exit code 255/)
assert.match(emptyWpcomFatalMessage, /httpStatusCode=500/)
assert.match(emptyWpcomFatalMessage, /exitCode=255/)
assert.match(emptyWpcomFatalMessage, /--- Playground response headers ---/)
assert.match(emptyWpcomFatalMessage, /x-powered-by: PHP\/8\.4\.21/)
assert.match(emptyWpcomFatalMessage, /No Playground stdout, stderr, or response body was captured\./)
assert.doesNotMatch(emptyWpcomFatalMessage, /wordpress_test_cookie/)

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

const nonEnumerableFatal = new Error("PHP.run() failed with exit code 255")
Object.defineProperties(nonEnumerableFatal, {
  httpStatusCode: { value: 500 },
  exitCode: { value: 255 },
  response: {
    value: Object.defineProperties({}, {
      body: { value: new TextEncoder().encode("Fatal error: Uncaught Error: Call to undefined function wp_codebox_hidden_fixture()") },
      headers: { value: { "content-type": "text/html; charset=UTF-8", authorization: "secret" } },
    }),
  },
})

const nonEnumerableFatalMessage = new PlaygroundCommandCrashError("wordpress.run-php", nonEnumerableFatal).message

assert.match(nonEnumerableFatalMessage, /httpStatusCode=500/)
assert.match(nonEnumerableFatalMessage, /exitCode=255/)
assert.match(nonEnumerableFatalMessage, /--- Playground response body ---/)
assert.match(nonEnumerableFatalMessage, /wp_codebox_hidden_fixture/)
assert.doesNotMatch(nonEnumerableFatalMessage, /No Playground stdout, stderr, or response body was captured/)
assert.doesNotMatch(nonEnumerableFatalMessage, /authorization/)
assert.doesNotMatch(nonEnumerableFatalMessage, /secret/)

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
    [Symbol.asyncDispose]: async () => undefined,
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
await runtime.destroy()

console.log("playground command errors smoke passed")
