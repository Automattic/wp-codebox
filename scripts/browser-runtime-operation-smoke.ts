import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import { resolve } from "node:path"
import { TextDecoder, TextEncoder } from "node:util"

const repoRoot = resolve(import.meta.dirname, "..")
const runtimePath = resolve(repoRoot, "packages/wordpress-plugin/assets/browser-runtime.js")
const runtimeSource = await readFile(runtimePath, "utf8")

const context = {
	TextEncoder,
	TextDecoder,
  window: {} as { wpCodeboxBrowser?: any },
  CustomEvent: class CustomEvent {
    type: string
    detail: unknown
    constructor(type: string, init: { detail?: unknown } = {}) {
      this.type = type
      this.detail = init.detail
    }
  },
  btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
}
context.window.dispatchEvent = () => true

vm.runInNewContext(runtimeSource, context)

const runtime = context.window.wpCodeboxBrowser
assert.ok(runtime, "browser runtime should attach window.wpCodeboxBrowser")
assert.equal(typeof runtime.runPhpRequest, "function")
assert.equal(typeof runtime.runRecipe, "function")
assert.equal(typeof runtime.runBrowserSessionRecipe, "function")
assert.equal(typeof runtime.runBrowserRuntimeContractProbe, "function")
assert.equal(typeof runtime.browserSessionRecipe, "function")
assert.equal(typeof runtime.runWordPressOperation, "function")
assert.equal(typeof runtime.ensureDirectory, "function")
assert.equal(typeof runtime.writeFile, "function")
assert.equal(typeof runtime.setFrontendAdminBarVisible, "function")
assert.equal(typeof runtime.writeReviewFile, "function")
assert.equal(typeof runtime.installTheme, "function")
assert.equal(typeof runtime.activateTheme, "function")

const parsed = await runtime.parseJsonResponse("notice before {\"success\":true,\"data\":{\"ok\":true}} warning after")
assert.deepEqual(sameRealm(parsed), { success: true, data: { ok: true } })

const parsedBytes = await runtime.parseJsonResponse({ bytes: new TextEncoder().encode("prefix {\"success\":true,\"data\":{\"bytes\":true}} suffix") })
assert.deepEqual(sameRealm(parsedBytes), { success: true, data: { bytes: true } })

const runClient = createClient("unused", true)
runClient.runResponse = { text: "prefix {\"success\":true,\"data\":{\"runner\":\"direct\"},\"error\":null} suffix" }
const directRunResult = await runtime.runPhpRequest(runClient, { code: "<?php echo 'ok';", expectJson: true })
assert.deepEqual(sameRealm(directRunResult), { success: true, data: { runner: "direct" }, error: null })
assert.equal(runClient.runs[0]?.code, "<?php echo 'ok';")
assert.equal(runClient.files.length, 0)
assert.equal(runClient.requests.length, 0)

assert.deepEqual(sameRealm(runtime.normalizeOperationResult({ success: true, data: { path: "/tmp/example" } })), {
  success: true,
  data: { path: "/tmp/example" },
})

assert.deepEqual(sameRealm(runtime.normalizeOperationResult({ success: false, error: { message: "Nope" } })), {
  success: false,
  error: {
    code: "operation_failed",
    message: "Nope",
    data: null,
  },
})

const successClient = createClient("prefix {\"success\":true,\"data\":{\"path\":\"/wordpress/wp-content/uploads/example\",\"exists\":true},\"error\":null} suffix")
const directoryResult = await runtime.ensureDirectory(successClient, { path: "wp-content/uploads/example" })
assert.deepEqual(sameRealm(directoryResult), {
  success: true,
  data: {
    path: "/wordpress/wp-content/uploads/example",
    exists: true,
  },
})
assert.equal(successClient.mkdirs[0], "/wordpress/wp-content/uploads/wp-codebox/runner")
assert.match(successClient.files[0]?.path ?? "", /\/wordpress\/wp-content\/uploads\/wp-codebox\/runner\/codebox-ensuredirectory-/)
assert.match(successClient.files[0]?.contents ?? "", /\/wordpress\/wp-load\.php/)
assert.match(successClient.files[0]?.contents ?? "", /wp-load\.php/)
assert.match(successClient.files[0]?.contents ?? "", /case 'ensureDirectory':/)
assert.match(successClient.requests[0]?.url ?? "", /\/wp-content\/uploads\/wp-codebox\/runner\/codebox-ensuredirectory-/)

const dualTransportClient = createClient("prefix {\"success\":true,\"data\":{\"runner\":\"client\"},\"error\":null} suffix", false, true)
const dualTransportResult = await runtime.runPhpRequest(dualTransportClient, { code: "<?php echo 'ok';", expectJson: true })
assert.deepEqual(sameRealm(dualTransportResult), { success: true, data: { runner: "client" }, error: null })
assert.equal(dualTransportClient.requests.length, 1)
assert.equal(dualTransportClient.handlerRequests.length, 0)
assert.match(dualTransportClient.requests[0]?.url ?? "", /\/wp-content\/uploads\/wp-codebox\/runner\/task-/)

const handlerClient = createClient("prefix {\"success\":true,\"data\":{\"runner\":\"handler\"},\"error\":null} suffix", false, true)
delete (handlerClient as { request?: unknown }).request
const handlerResult = await runtime.runPhpRequest(handlerClient, { code: "<?php echo 'ok';", expectJson: true })
assert.deepEqual(sameRealm(handlerResult), { success: true, data: { runner: "handler" }, error: null })
assert.equal(handlerClient.handlerRequests.length, 1)
assert.equal(handlerClient.requests.length, 0)
assert.match(handlerClient.handlerRequests[0]?.url ?? "", /\/wp-content\/uploads\/wp-codebox\/runner\/task-/)

const workerEndpointClient = createClient("prefix {\"success\":true,\"data\":{\"runner\":\"worker-endpoint\"},\"error\":null} suffix", false, true)
delete (workerEndpointClient as { request?: unknown }).request
workerEndpointClient.requestHandler = {
  request: async (body: { request?: { method: string; url: string } }) => {
    if (!body.request) {
      throw new TypeError("Cannot read properties of undefined (reading 'request')")
    }
    workerEndpointClient.handlerRequests.push(body.request)
    return "prefix {\"success\":true,\"data\":{\"runner\":\"worker-endpoint\"},\"error\":null} suffix"
  },
}
const workerEndpointResult = await runtime.runPhpRequest(workerEndpointClient, { code: "<?php echo 'ok';", expectJson: true })
assert.deepEqual(sameRealm(workerEndpointResult), { success: true, data: { runner: "worker-endpoint" }, error: null })
assert.equal(workerEndpointClient.handlerRequests.length, 1)

const failingRequestClient = createClient("", false, true)
delete (failingRequestClient as { request?: unknown }).request
failingRequestClient.requestHandler = {
  request: async () => {
    throw new Error("Playground worker rejected request")
  },
}
const failedRequestError = await runtime.runPhpRequest(failingRequestClient, { code: "<?php echo 'ok';", expectJson: true }).catch((error: unknown) => error)
assert.equal(failedRequestError.code, "playground_request_failed")
assert.equal(failedRequestError.phase, "request")
assert.deepEqual(
  sameRealm(failedRequestError.data?.attempts?.map((attempt: { label?: string; shape?: string; error?: { message?: string } }) => ({
    label: attempt.label,
    shape: attempt.shape,
    message: attempt.error?.message,
  }))),
  [
    {
      label: "request-handler-envelope",
      shape: "request-handler",
      message: "Playground worker rejected request",
    },
    {
      label: "request-handler-plain",
      shape: "request-handler",
      message: "Playground worker rejected request",
    },
  ]
)

const objectShapeFileClient = createClient("prefix {\"success\":true,\"data\":{\"runner\":\"object-file\"},\"error\":null} suffix")
objectShapeFileClient.writeFile = async function writeFile(body: string | { path?: string; data?: string }) {
  if (typeof body === "string") {
    throw new TypeError("writeFile expects object shape")
  }
  this.files.push({ path: body.path ?? "", contents: body.data ?? "" })
}
const objectShapeFileResult = await runtime.runPhpRequest(objectShapeFileClient, { code: "<?php echo 'ok';", expectJson: true })
assert.deepEqual(sameRealm(objectShapeFileResult), { success: true, data: { runner: "object-file" }, error: null })
assert.match(objectShapeFileClient.files[0]?.path ?? "", /\/wordpress\/wp-content\/uploads\/wp-codebox\/runner\/task-/)

const writeClient = createClient("{\"success\":true,\"data\":{\"path\":\"/wordpress/wp-content/example.txt\",\"bytes\":11},\"error\":null}")
const writeResult = await runtime.writeFile(writeClient, { path: "/wordpress/wp-content/example.txt", content: "hello world" })
assert.deepEqual(sameRealm(writeResult), {
  success: true,
  data: {
    path: "/wordpress/wp-content/example.txt",
    bytes: 11,
  },
})
assert.match(writeClient.files[0]?.contents ?? "", /case 'writeFile':/)

const adminBarClient = createClient('{"success":true,"data":{"target":"frontendAdminBar","key":"show_admin_bar_front","userId":1,"visible":false,"value":"false"},"error":null}')
const adminBarResult = await runtime.setFrontendAdminBarVisible(adminBarClient, { visible: false })
assert.deepEqual(sameRealm(adminBarResult), {
  operation: "setFrontendAdminBarVisible",
  success: true,
  status: "ok",
  target: "frontendAdminBar",
  key: "show_admin_bar_front",
  data: {
    target: "frontendAdminBar",
    key: "show_admin_bar_front",
    userId: 1,
    visible: false,
    value: "false",
  },
  errors: [],
})
assert.match(adminBarClient.files[0]?.contents ?? "", /case 'setFrontendAdminBarVisible':/)

const invalidAdminBarResult = await runtime.setFrontendAdminBarVisible(createClient("{}"), { visible: "false" })
assert.deepEqual(sameRealm(invalidAdminBarResult), {
  operation: "setFrontendAdminBarVisible",
  success: false,
  status: "error",
  target: "frontendAdminBar",
  key: "show_admin_bar_front",
  data: null,
  errors: [
    {
      code: "invalid_args",
      message: "Admin bar visibility must be a boolean.",
      data: null,
    },
  ],
})

const invalidAdminBarArgsResult = await runtime.setFrontendAdminBarVisible(createClient("{}"), null)
assert.deepEqual(sameRealm(invalidAdminBarArgsResult), {
  operation: "setFrontendAdminBarVisible",
  success: false,
  status: "error",
  target: "frontendAdminBar",
  key: "show_admin_bar_front",
  data: null,
  errors: [
    {
      code: "invalid_args",
      message: "Admin bar operation args must be an object.",
      data: null,
    },
  ],
})

const reviewFileClient = createClient('{"success":true,"data":{"target":"reviewFile","path":"/wordpress/wp-content/uploads/wp-codebox/reviews/artifacts/review.md","relativePath":"artifacts/review.md","bytes":9},"error":null}')
const reviewFileResult = await runtime.writeReviewFile(reviewFileClient, { path: "artifacts/review.md", content: "looks ok\n" })
assert.deepEqual(sameRealm(reviewFileResult), {
  operation: "writeReviewFile",
  success: true,
  status: "ok",
  target: "reviewFile",
  path: "/wordpress/wp-content/uploads/wp-codebox/reviews/artifacts/review.md",
  data: {
    target: "reviewFile",
    path: "/wordpress/wp-content/uploads/wp-codebox/reviews/artifacts/review.md",
    relativePath: "artifacts/review.md",
    bytes: 9,
  },
  errors: [],
})
assert.match(reviewFileClient.files[0]?.contents ?? "", /case 'writeReviewFile':/)

const unsafeReviewFileResult = await runtime.writeReviewFile(createClient("{}"), { path: "../escape.md", content: "nope" })
assert.deepEqual(sameRealm(unsafeReviewFileResult), {
  operation: "writeReviewFile",
  success: false,
  status: "error",
  target: "reviewFile",
  path: "../escape.md",
  data: null,
  errors: [
    {
      code: "invalid_args",
      message: "Review file path must be a safe relative path.",
      data: null,
    },
  ],
})

const invalidReviewFileArgsResult = await runtime.writeReviewFile(createClient("{}"), null)
assert.deepEqual(sameRealm(invalidReviewFileArgsResult), {
  operation: "writeReviewFile",
  success: false,
  status: "error",
  target: "reviewFile",
  path: null,
  data: null,
  errors: [
    {
      code: "invalid_args",
      message: "Review file operation args must be an object.",
      data: null,
    },
  ],
})

const themeClient = createClient("{\"success\":true,\"data\":{\"slug\":\"codebox-theme\",\"activated\":true,\"files\":[]},\"error\":null}")
const themeResult = await runtime.installTheme(themeClient, {
  slug: "codebox-theme",
  activate: true,
  files: {
    "style.css": "/* Theme Name: Codebox Theme */",
    "templates/index.html": { content: "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->" },
  },
})
assert.equal(themeResult.success, true)
assert.equal(themeResult.data.slug, "codebox-theme")
assert.equal(themeResult.data.activated, true)
assert.match(themeClient.files[0]?.contents ?? "", /case 'installTheme':/)
assert.match(themeClient.files[0]?.contents ?? "", /wp_codebox_browser_operation_theme_file_path/)

const activateClient = createClient("{\"success\":true,\"data\":{\"slug\":\"twentytwentysix\",\"name\":\"Twenty Twenty-Six\"},\"error\":null}")
const activateResult = await runtime.activateTheme(activateClient, { slug: "twentytwentysix" })
assert.equal(activateResult.success, true)
assert.equal(activateResult.data.slug, "twentytwentysix")
assert.match(activateClient.files[0]?.contents ?? "", /case 'activateTheme':/)

const errorClient = createClient("PHP warning {\"success\":false,\"error\":{\"code\":\"operation_failed\",\"message\":\"Theme does not exist\",\"data\":{\"type\":\"RuntimeException\"}}}")
const errorResult = await runtime.runWordPressOperation(errorClient, { type: "activateTheme", args: { slug: "missing-theme" } })
assert.deepEqual(sameRealm(errorResult), {
  success: false,
  error: {
    code: "operation_failed",
    message: "Theme does not exist",
    data: { type: "RuntimeException" },
  },
})

const rawResponse = { text: "raw response" }
const rawClient = createClient(rawResponse)
assert.equal(await runtime.runPhpRequest(rawClient, { code: "<?php echo 'ok';" }), rawResponse)

const recipeClient = createClient('{"success":true,"schema":"wp-codebox/browser-agent-run/v1"}')
const recipeResult = await runtime.runRecipe(recipeClient, {
  browser: { task_path: "/tmp/wp-codebox-agent-task.json" },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=<?php echo wp_json_encode( array( 'success' => true ) );"],
      },
    ],
  },
}, { goal: "Smoke test browser recipe marker." })
assert.equal(recipeResult.success, true)
assert.match(recipeClient.files[0]?.contents ?? "", /case 'writeFile':/)
assert.deepEqual(extractBrowserOperation(recipeClient.files[0]?.contents ?? ""), {
  type: "writeFile",
  args: {
    path: "/tmp/wp-codebox-agent-task.json",
    content: JSON.stringify({ goal: "Smoke test browser recipe marker." }),
  },
})
assert.match(recipeClient.files[1]?.contents ?? "", /WP_CODEBOX_BROWSER_PLAYGROUND_RUNNER/)
assert.match(recipeClient.files[1]?.contents ?? "", /<\?php\ndefine\( 'WP_CODEBOX_BROWSER_PLAYGROUND_RUNNER', true \);/)

const sessionClient = createClient("prefix {\"success\":true,\"data\":{\"summary\":\"session runner\"},\"error\":null} suffix")
const sessionOutput = {
  schema: "wp-codebox/browser-playground-session/v1",
  success: true,
  session: { id: "browser-session-smoke", status: "ready" },
  task_input: { goal: "Run session smoke", expected_artifacts: ["summary"] },
  task_payload: {
    schema: "wp-codebox/browser-agent-task-payload/v1",
    goal: "Run session smoke from task payload",
    provider: "openai",
    model: "gpt-5.5",
    inherited: {
      provider_plugin_paths: ["/wordpress/wp-content/plugins/ai-provider-for-openai"],
      env_names: ["AI_PROVIDER_OPENAI_CODEX_REFRESH_TOKEN"],
    },
  },
  recipe: {
    schema: "wp-codebox/workspace-recipe/v1",
    browser: {
      task_path: "/tmp/wp-codebox-agent-task.json",
      result_path: "/tmp/wp-codebox-agent-result.json",
    },
    workflow: {
      steps: [
        {
          command: "wordpress.run-php",
          args: ["code=<?php echo wp_json_encode(array('success' => true, 'data' => array('summary' => 'session runner'), 'error' => null));"],
        },
      ],
    },
  },
}
const sessionResult = await runtime.runBrowserSessionRecipe(sessionClient, sessionOutput)
assert.deepEqual(sameRealm(sessionResult), { success: true, data: { summary: "session runner" }, error: null })
assert.match(sessionClient.files[0]?.contents ?? "", /case 'writeFile':/)
assert.deepEqual(extractBrowserOperation(sessionClient.files[0]?.contents ?? ""), {
  type: "writeFile",
  args: {
    path: "/tmp/wp-codebox-agent-task.json",
    content: JSON.stringify(sessionOutput.task_payload),
  },
})
assert.match(sessionClient.files[1]?.path ?? "", /\/wordpress\/wp-content\/uploads\/wp-codebox\/runner\/codebox-browser-session-/)
assert.match(sessionClient.requests[0]?.url ?? "", /\/wp-content\/uploads\/wp-codebox\/runner\/codebox-browser-session-/)

const overridePayload = { goal: "Explicit payload override", provider: "test-provider", model: "override-model" }
const overrideSessionClient = createClient("prefix {\"success\":true,\"data\":{\"summary\":\"override runner\"},\"error\":null} suffix")
await runtime.runBrowserSessionRecipe(overrideSessionClient, sessionOutput, overridePayload)
assert.deepEqual(extractBrowserOperation(overrideSessionClient.files[0]?.contents ?? ""), {
  type: "writeFile",
  args: {
    path: "/tmp/wp-codebox-agent-task.json",
    content: JSON.stringify(overridePayload),
  },
})

assert.equal(runtime.browserSessionRecipe(sessionOutput), sessionOutput.recipe)
await assert.rejects(
  () => runtime.runBrowserSessionRecipe(createClient("{}"), { ...sessionOutput, success: false, error: { message: "not ready" } }),
  /not ready/
)

const embeddedPayloadClient = createClient('{"success":true,"schema":"wp-codebox/browser-agent-run/v1"}')
await runtime.runRecipe(embeddedPayloadClient, {
  browser: {
    task_path: "/tmp/wp-codebox-agent-task.json",
    task_payload: { schema: "wp-codebox/browser-agent-task-payload/v1", goal: "embedded" },
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=<?php echo wp_json_encode( array( 'success' => true ) );"],
      },
    ],
  },
})
assert.match(embeddedPayloadClient.files[0]?.contents ?? "", /case 'writeFile':/)
assert.deepEqual(extractBrowserOperation(embeddedPayloadClient.files[0]?.contents ?? ""), {
  type: "writeFile",
  args: {
    path: "/tmp/wp-codebox-agent-task.json",
    content: JSON.stringify({ schema: "wp-codebox/browser-agent-task-payload/v1", goal: "embedded" }),
  },
})

await assert.rejects(
  () => runtime.runWordPressOperation(createClient("{}"), { args: {} }),
  /WordPress browser operation must include a type/
)

const probeClient = createContractProbeClient()
const probeResult = await runtime.runBrowserRuntimeContractProbe(probeClient)
assert.equal(probeResult.schema, "wp-codebox/browser-runtime-contract-probe/v1")
assert.equal(probeResult.success, true)
assert.deepEqual(sameRealm(probeResult.phases.map((phase: { name: string }) => phase.name)), [
  "runtime-bootstrap",
  "php-execution",
  "playground-request-handler",
  "runner-file-write-read",
  "provider-bridge-echo",
  "runtime-tool-artifact-write",
  "artifact-capture",
  "generated-runner-artifact-capture",
  "event-diagnostics",
])
assert.equal(probeResult.phases.every((phase: { status: string }) => phase.status === "passed"), true)
assert.equal(probeResult.phases.find((phase: { name: string }) => phase.name === "provider-bridge-echo")?.data.provider, "echo")
assert.deepEqual(sameRealm(probeResult.phases.find((phase: { name: string }) => phase.name === "generated-runner-artifact-capture")?.data), {
  schema: "wp-codebox/browser-runtime-contract-generated-runner/v1",
  root: "contract-generated/",
  artifact_schema: "wp-codebox/browser-runtime-contract-generated-artifact/v1",
  file_count: 1,
})
assert.equal(probeResult.phases.find((phase: { name: string }) => phase.name === "event-diagnostics")?.data.bounded, true)
assert.equal(probeClient.requests.length > 0, true)
assert.equal(probeClient.targetWrites.includes("/tmp/wp-codebox-contract-probe.txt"), true)
assert.equal(probeClient.targetWrites.some((path: string) => path.endsWith("/tool-output.txt")), true)
assert.equal(probeClient.targetWrites.includes("/tmp/wp-codebox-contract-recipe-task.json"), true)

console.log("Browser runtime operation smoke passed")

function sameRealm<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function extractBrowserOperation(source: string): unknown {
  const match = source.match(/base64_decode\( '([^']+)' \)/)
  assert.ok(match, "Browser operation PHP should contain a base64 operation payload")
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"))
}

function createClient(response: unknown, supportsRun = false, supportsRequestHandler = false) {
  const client = {
    mkdirs: [] as string[],
    files: [] as Array<{ path: string; contents: string }>,
    requests: [] as Array<{ method: string; url: string }>,
    handlerRequests: [] as Array<{ method: string; url: string }>,
    runs: [] as Array<{ code: string }>,
    runResponse: undefined as unknown,
    requestHandler: undefined as undefined | { request: (request: { method: string; url: string } | { request: { method: string; url: string } }) => Promise<unknown> },
    async mkdir(path: string) {
      this.mkdirs.push(path)
    },
    async writeFile(path: string, contents: string) {
      this.files.push({ path, contents })
    },
    async request(request: { method: string; url: string }) {
      this.requests.push(request)
      return response
    },
    async run(options: { code: string }) {
      this.runs.push(options)
      return this.runResponse
    },
  }

  if (!supportsRun) {
    delete (client as { run?: unknown }).run
  }

  if (supportsRequestHandler) {
    client.requestHandler = {
      request: async (body: { method: string; url: string } | { request: { method: string; url: string } }) => {
        const request = "request" in body ? body.request : body
        client.handlerRequests.push(request)
        return response
      },
    }
  }

  return client
}

function createContractProbeClient() {
  const storedFiles = new Map<string, string>()
  const targetWrites: string[] = []
  const client = {
    mkdirs: [] as string[],
    files: [] as Array<{ path: string; contents: string }>,
    targetWrites,
    requests: [] as Array<{ method: string; url: string }>,
    runs: [] as Array<{ code: string }>,
    async mkdir(path: string) {
      this.mkdirs.push(path)
    },
    async writeFile(path: string, contents: string) {
      this.files.push({ path, contents })
      storedFiles.set(path, contents)
    },
    async request(request: { method: string; url: string }) {
      this.requests.push(request)
      const script = this.files.find((file) => request.url.endsWith(file.path.split("/").pop() ?? ""))?.contents ?? ""
      return probePhpResponse(script, storedFiles, targetWrites)
    },
    async run(options: { code: string }) {
      this.runs.push(options)
      return probePhpResponse(options.code, storedFiles, targetWrites)
    },
  }

  return client
}

function probePhpResponse(script: string, storedFiles: Map<string, string>, targetWrites: string[]) {
  if (script.includes("'phase' => 'php-execution'")) {
    return JSON.stringify({ success: true, data: { phase: "php-execution" }, error: null })
  }

  if (script.includes("'phase' => 'playground-request-handler'")) {
    return JSON.stringify({ success: true, data: { phase: "playground-request-handler" }, error: null })
  }

  if (script.includes("/tmp/wp-codebox-contract-probe.txt")) {
    const content = storedFiles.get("/tmp/wp-codebox-contract-probe.txt") ?? ""
    return JSON.stringify({ success: content.length > 0, data: { path: "/tmp/wp-codebox-contract-probe.txt", sha256: sha256(content) }, error: null })
  }

  if (script.includes("wp-codebox/browser-runtime-contract-artifact-capture/v1")) {
    const path = "/wordpress/wp-content/uploads/wp-codebox/artifacts/contract-probe/tool-output.txt"
    const content = storedFiles.get(path) ?? ""
    return JSON.stringify({
      success: content.length > 0,
      data: {
        schema: "wp-codebox/browser-runtime-contract-artifact-capture/v1",
        files: content.length > 0 ? [{ path: "tool-output.txt", sha256: sha256(content), size: content.length }] : [],
      },
      error: content.length > 0 ? null : { code: "artifact_missing", message: "Probe artifact was not readable." },
    })
  }

  if (script.includes("wp-codebox/browser-runtime-contract-generated-runner/v1")) {
    assert.match(script, /WP_CODEBOX_BROWSER_PLAYGROUND_RUNNER/)
    assert.match(script, /wp_codebox_browser_artifact_environment\( \$payload \)/)
    assert.match(script, /wp_codebox_browser_capture_artifact_bundle\( \$payload \)/)
    const payload = JSON.parse(storedFiles.get("/tmp/wp-codebox-contract-recipe-task.json") ?? "{}")
    const artifact = payload.artifacts ?? {}
    const fileCount = Array.isArray(artifact.files) ? artifact.files.length : 0
    return JSON.stringify({
      success: Boolean(artifact.schema && artifact.root && fileCount > 0),
      data: {
        schema: "wp-codebox/browser-runtime-contract-generated-runner/v1",
        root: `${String(artifact.root ?? "").replace(/\/$/, "")}/`,
        artifact_schema: artifact.schema ?? "",
        file_count: fileCount,
      },
      error: artifact.schema ? null : { code: "artifact_contract_missing", message: "Generated runner artifact contract was not available." },
    })
  }

  const operation = extractBrowserOperation(script) as { type?: string; args?: Record<string, unknown> }
  if (operation.type === "writeFile") {
    const path = String(operation.args?.path ?? "")
    const content = String(operation.args?.content ?? "")
    storedFiles.set(path, content)
    targetWrites.push(path)
    return JSON.stringify({ success: true, data: { path, bytes: content.length }, error: null })
  }

  return JSON.stringify({ success: true, data: {}, error: null })
}

function sha256(value: string) {
  return Buffer.from(value).toString("hex")
}
