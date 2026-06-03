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
  btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
}

vm.runInNewContext(runtimeSource, context)

const runtime = context.window.wpCodeboxBrowser
assert.ok(runtime, "browser runtime should attach window.wpCodeboxBrowser")
assert.equal(typeof runtime.runPhpRequest, "function")
assert.equal(typeof runtime.runRecipe, "function")
assert.equal(typeof runtime.runBrowserSessionRecipe, "function")
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

const handlerClient = createClient("prefix {\"success\":true,\"data\":{\"runner\":\"handler\"},\"error\":null} suffix", false, true)
const handlerResult = await runtime.runPhpRequest(handlerClient, { code: "<?php echo 'ok';", expectJson: true })
assert.deepEqual(sameRealm(handlerResult), { success: true, data: { runner: "handler" }, error: null })
assert.equal(handlerClient.handlerRequests.length, 1)
assert.equal(handlerClient.requests.length, 0)
assert.match(handlerClient.handlerRequests[0]?.url ?? "", /\/wp-content\/uploads\/wp-codebox\/runner\/task-/)

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
    content: JSON.stringify({ goal: "Run session smoke", expected_artifacts: ["summary"] }),
  },
})
assert.match(sessionClient.files[1]?.path ?? "", /\/wordpress\/wp-content\/uploads\/wp-codebox\/runner\/codebox-browser-session-/)
assert.match(sessionClient.requests[0]?.url ?? "", /\/wp-content\/uploads\/wp-codebox\/runner\/codebox-browser-session-/)

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
    requestHandler: undefined as undefined | { request: (request: { method: string; url: string }) => Promise<unknown> },
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
      request: async (request: { method: string; url: string }) => {
        client.handlerRequests.push(request)
        return response
      },
    }
  }

  return client
}
