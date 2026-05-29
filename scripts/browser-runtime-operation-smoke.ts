import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import { resolve } from "node:path"
import { TextEncoder } from "node:util"

const repoRoot = resolve(import.meta.dirname, "..")
const runtimePath = resolve(repoRoot, "packages/wordpress-plugin/assets/browser-runtime.js")
const runtimeSource = await readFile(runtimePath, "utf8")

const context = {
  TextEncoder,
  window: {} as { wpCodeboxBrowser?: any },
  btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
}

vm.runInNewContext(runtimeSource, context)

const runtime = context.window.wpCodeboxBrowser
assert.ok(runtime, "browser runtime should attach window.wpCodeboxBrowser")
assert.equal(typeof runtime.runPhpRequest, "function")
assert.equal(typeof runtime.runRecipe, "function")
assert.equal(typeof runtime.runWordPressOperation, "function")
assert.equal(typeof runtime.ensureDirectory, "function")
assert.equal(typeof runtime.writeFile, "function")
assert.equal(typeof runtime.installTheme, "function")
assert.equal(typeof runtime.activateTheme, "function")

const parsed = runtime.parseJsonResponse("notice before {\"success\":true,\"data\":{\"ok\":true}} warning after")
assert.deepEqual(sameRealm(parsed), { success: true, data: { ok: true } })

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
assert.match(successClient.files[0]?.contents ?? "", /wp-load\.php/)
assert.match(successClient.files[0]?.contents ?? "", /case 'ensureDirectory':/)
assert.match(successClient.requests[0]?.url ?? "", /\/wp-content\/uploads\/wp-codebox\/runner\/codebox-ensuredirectory-/)

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

await assert.rejects(
  () => runtime.runWordPressOperation(createClient("{}"), { args: {} }),
  /WordPress browser operation must include a type/
)

console.log("Browser runtime operation smoke passed")

function sameRealm<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createClient(response: unknown) {
  return {
    mkdirs: [] as string[],
    files: [] as Array<{ path: string; contents: string }>,
    requests: [] as Array<{ method: string; url: string }>,
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
  }
}
