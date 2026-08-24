import assert from "node:assert/strict"
import { createRuntime, type RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"
import { bootstrapPhpCode } from "../packages/runtime-playground/src/php-bootstrap.js"
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

const emptyStructuredFatal = new Error("PHP.run() failed with exit code 255") as Error & {
  httpStatusCode?: number
  exitCode?: number
  stdout?: string
  stderr?: string
  response?: { headers?: Record<string, string> }
}

emptyStructuredFatal.httpStatusCode = 500
emptyStructuredFatal.exitCode = 255
emptyStructuredFatal.stdout = ""
emptyStructuredFatal.stderr = ""
emptyStructuredFatal.response = {
  headers: {
    "content-type": "text/html; charset=UTF-8",
    "x-powered-by": "PHP/8.4.21",
    "set-cookie": "wordpress_test_cookie=secret",
  },
}

const emptyStructuredFatalMessage = new PlaygroundCommandCrashError("wordpress.run-php", emptyStructuredFatal).message

assert.match(emptyStructuredFatalMessage, /wordpress\.run-php crashed before producing a structured response/)
assert.match(emptyStructuredFatalMessage, /PHP\.run\(\) failed with exit code 255/)
assert.match(emptyStructuredFatalMessage, /httpStatusCode=500/)
assert.match(emptyStructuredFatalMessage, /exitCode=255/)
assert.match(emptyStructuredFatalMessage, /--- Playground response headers ---/)
assert.match(emptyStructuredFatalMessage, /x-powered-by: PHP\/8\.4\.21/)
assert.match(emptyStructuredFatalMessage, /No Playground stdout, stderr, or response body was captured\./)
assert.doesNotMatch(emptyStructuredFatalMessage, /wordpress_test_cookie/)

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

const emptyPhpExecutionFailureMessage = new PlaygroundCommandError("wordpress.run-php", {
  originalErrorClassName: "PHPExecutionFailureError",
  httpStatusCode: 500,
  exitCode: 255,
  bytes: {},
  errors: "",
  text: "",
  cause: { message: "Comlink method call failed" },
}).message

assert.match(emptyPhpExecutionFailureMessage, /wordpress\.run-php failed with exit code 255/)
assert.match(emptyPhpExecutionFailureMessage, /originalErrorClassName=PHPExecutionFailureError/)
assert.match(emptyPhpExecutionFailureMessage, /httpStatusCode=500/)
assert.match(emptyPhpExecutionFailureMessage, /exitCode=255/)
assert.match(emptyPhpExecutionFailureMessage, /cause=Comlink method call failed/)
assert.match(emptyPhpExecutionFailureMessage, /No Playground response bytes, errors, or text were captured\./)
assert.match(emptyPhpExecutionFailureMessage, /PHP fatal payload was absent from the wordpress\.run-php response/)
assert.doesNotMatch(emptyPhpExecutionFailureMessage, /--- Playground response bytes ---/)

const wpCodeboxFatalDiagnostic = 'WP_CODEBOX_PHP_FATAL_DIAGNOSTIC:{"schema":"wp-codebox/php-fatal-diagnostic/v1","message":"Uncaught RuntimeException: Local wp-admin auth fixture user could not be loaded.","file":"/wordpress/wp-content/plugins/auth-fixture/auth-fixture.php","line":17,"type":1}'
const wpCodeboxFatalMessage = new PlaygroundCommandError("wordpress.run-php", {
  exitCode: 255,
  bytes: Object.fromEntries(Array.from(Buffer.from(wpCodeboxFatalDiagnostic, "utf8")).map((byte, index) => [String(index), byte])),
  text: "",
}).message

assert.match(wpCodeboxFatalMessage, /PHP fatal: Uncaught RuntimeException: Local wp-admin auth fixture user could not be loaded\./)
assert.match(wpCodeboxFatalMessage, /Location: \/wordpress\/wp-content\/plugins\/auth-fixture\/auth-fixture\.php:17/)
assert.doesNotMatch(wpCodeboxFatalMessage, /WP_CODEBOX_PHP_FATAL_DIAGNOSTIC/)

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

const phpunitFailureCliModule: PlaygroundCliModule = {
  runCLI: async () => ({
    serverUrl: "http://127.0.0.1:9401",
    playground: {
      run: async () => ({
        exitCode: 1,
        errors: "PHP Fatal error: PHPUnit bootstrap fixture failed in /wordpress/wp-content/plugins/demo/tests/bootstrap.php on line 12",
        text: "PHPUnit bootstrap fixture output",
      }),
    },
    [Symbol.asyncDispose]: async () => undefined,
  }),
}

const phpunitFailureRuntime = await createRuntime({
  backend: "wordpress-playground",
  environment: { kind: "wordpress", name: "phpunit-bootstrap-failure", version: "7.0", blueprint: { steps: [] } },
  policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.phpunit"], secrets: "none", approvals: "never" },
}, createPlaygroundRuntimeBackend({ cliModule: phpunitFailureCliModule }))

await assert.rejects(
  () => phpunitFailureRuntime.execute({ command: "wordpress.phpunit", args: ["plugin-slug=demo"] }),
  (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /failureClassification=runtime-command-failure/)
    assert.match(error.message, /PHP fatal: PHPUnit bootstrap fixture failed/)
    assert.match(error.message, /PHPUnit bootstrap fixture output/)
    return true
  },
)
await phpunitFailureRuntime.destroy()

const comlinkFailure = new Error("Comlink method call failed")
comlinkFailure.name = "ComlinkMethodError"
comlinkFailure.stack = "ComlinkMethodError: Comlink method call failed\n    at worker.run (worker.js:42:7) token=worker-secret"
const workerFailureCliModule: PlaygroundCliModule = {
  runCLI: async () => ({
    serverUrl: "http://127.0.0.1:9402",
    playground: {
      run: async () => { throw comlinkFailure },
      readFileAsText: async () => "STAGE_FATAL:project_bootstrap:PHPUnit bootstrap fixture failed at /wordpress/wp-content/plugins/demo/tests/bootstrap.php:12\n",
    },
    [Symbol.asyncDispose]: async () => undefined,
  }),
}

const workerFailureRuntime = await createRuntime({
  backend: "wordpress-playground",
  environment: { kind: "wordpress", name: "phpunit-worker-failure", version: "7.0", blueprint: { steps: [] } },
  policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.phpunit"], secrets: "none", approvals: "never" },
}, createPlaygroundRuntimeBackend({ cliModule: workerFailureCliModule }))

await assert.rejects(
  () => workerFailureRuntime.execute({ command: "wordpress.phpunit", args: ["plugin-slug=demo"] }),
  (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /failureClassification=runtime-worker-failure/)
    assert.match(error.message, /name=ComlinkMethodError/)
    assert.match(error.message, /message=Comlink method call failed/)
    assert.match(error.message, /worker\.run/)
    assert.match(error.message, /operation=code/)
    assert.match(error.message, /runtimeUrl=http:\/\/127\.0\.0\.1:\d+/)
    assert.match(error.message, /wordpress\.phpunit structured diagnostics/)
    assert.match(error.message, /PHPUnit bootstrap fixture failed/)
    assert.doesNotMatch(error.message, /worker-secret/)
    return true
  },
)
await workerFailureRuntime.destroy()

const fatalDiagnosticRuntimeSpec: RuntimeCreateSpec = {
  backend: "wordpress-playground",
  environment: {
    kind: "wordpress",
    name: "fatal-diagnostic",
    version: "7.0",
    blueprint: { steps: [] },
  },
  policy: {
    network: "deny",
    filesystem: "sandbox",
    commands: ["wordpress.run-php"],
    secrets: "none",
    approvals: "never",
  },
}

assert.deepEqual(fatalDiagnosticRuntimeSpec, {
  backend: "wordpress-playground",
  environment: {
    kind: "wordpress",
    name: "fatal-diagnostic",
    version: "7.0",
    blueprint: { steps: [] },
  },
  policy: {
    network: "deny",
    filesystem: "sandbox",
    commands: ["wordpress.run-php"],
    secrets: "none",
    approvals: "never",
  },
})

const bootstrappedRunPhp = bootstrapPhpCode(fatalDiagnosticRuntimeSpec, "throw new RuntimeException('boom');", [])
assert.match(bootstrappedRunPhp, /register_shutdown_function/)
assert.match(bootstrappedRunPhp, /WP_CODEBOX_PHP_FATAL_DIAGNOSTIC/)
assert.match(bootstrappedRunPhp, /wp-codebox\/php-fatal-diagnostic\/v1/)

console.log("playground command errors smoke passed")
