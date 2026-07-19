import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { decodeZip } from "@php-wasm/stream-compression"
import { RUNTIME_COMMAND_RESULT_SCHEMA } from "../packages/runtime-core/src/runtime-contracts.js"
import { CLOUDFLARE_RUNTIME_HEALTH_MARKER, CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, cloudflareRuntimeHealthResponse } from "../packages/runtime-cloudflare/src/health-envelope.js"
import { routeWorkerRequest } from "../packages/runtime-cloudflare/src/request-routing.js"
import { toFetchResponse, toPHPRequest } from "../packages/runtime-cloudflare/src/request-translation.js"

test("Cloudflare health response preserves the Codebox execution envelope", async () => {
  const health = {
    schema: CLOUDFLARE_RUNTIME_HEALTH_SCHEMA,
    marker: CLOUDFLARE_RUNTIME_HEALTH_MARKER,
    wordpressVersion: "6.8.1",
    phpVersion: "8.5.8",
    runtime: { backend: "wordpress-playground" as const, environment: "wordpress" as const },
    evidence: { initialization: "completed" as const, execution: "completed" as const, initializationScope: "isolate" as const },
  }
  const response = cloudflareRuntimeHealthResponse(health)
  const payload = await response.json() as { execution: { schema: string; status: string; json: unknown }; marker: string; evidence: unknown }

  assert.equal(response.headers.get("content-type"), "application/json")
  assert.equal(payload.marker, CLOUDFLARE_RUNTIME_HEALTH_MARKER)
  assert.deepEqual(payload.evidence, health.evidence)
  assert.equal(payload.execution.schema, RUNTIME_COMMAND_RESULT_SCHEMA)
  assert.equal(payload.execution.status, "ok")
  assert.deepEqual(payload.execution.json, health)
})

test("Cloudflare routing reserves phases while the phase-less route serves WordPress", () => {
  assert.deepEqual(routeWorkerRequest(new Request("https://worker.example/")), { kind: "wordpress" })
  assert.deepEqual(routeWorkerRequest(new Request("https://worker.example/?phase=health")), { kind: "health" })
  assert.deepEqual(routeWorkerRequest(new Request("https://worker.example/?phase=r2-state")), { kind: "r2-state" })
  assert.deepEqual(routeWorkerRequest(new Request("https://worker.example/?phase=r2-mutate")), { kind: "r2-mutate" })
  assert.deepEqual(routeWorkerRequest(new Request("https://worker.example/?phase=seeded-wordpress")), { kind: "probe", phase: "seeded-wordpress" })
})

test("Cloudflare translates Fetch requests and PHP responses without losing browser data", async () => {
  const headers = new Headers({ "content-type": "application/octet-stream", "x-request-id": "first" })
  headers.append("x-request-id", "second")
  const request = new Request("https://worker.example/wp-admin/admin-ajax.php?action=save", {
    method: "POST",
    headers,
    body: new Uint8Array([0, 1, 255]),
  })
  const phpRequest = await toPHPRequest(request)

  assert.equal(phpRequest.method, "POST")
  assert.equal(phpRequest.url, "/wp-admin/admin-ajax.php?action=save")
  assert.equal(phpRequest.headers?.["x-request-id"], "first, second")
  assert.deepEqual(Array.from(phpRequest.body as Uint8Array), [0, 1, 255])

  const response = toFetchResponse(request, {
    httpStatusCode: 201,
    headers: { "content-type": ["application/octet-stream"], "set-cookie": ["first=1; Path=/", "second=2; Path=/"] },
    bytes: new Uint8Array([255, 1, 0]),
    errors: "",
    exitCode: 0,
  })
  const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] }
  assert.equal(response.status, 201)
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [255, 1, 0])
  assert.deepEqual(responseHeaders.getSetCookie?.() ?? [response.headers.get("set-cookie")], ["first=1; Path=/", "second=2; Path=/"])
})

test("Cloudflare runtime declares the paid-plan WordPress boot CPU budget", async () => {
  const config = JSON.parse(await readFile(new URL("../packages/runtime-cloudflare/wrangler.jsonc", import.meta.url), "utf8")) as { limits?: { cpu_ms?: number } }
  assert.equal(config.limits?.cpu_ms, 300_000)
})

test("Cloudflare runtime packages the disposable WordPress install seed", async () => {
  const config = JSON.parse(await readFile(new URL("../packages/runtime-cloudflare/wrangler.jsonc", import.meta.url), "utf8")) as {
    rules?: Array<{ type?: string; globs?: string[] }>
    r2_buckets?: Array<{ binding?: string; bucket_name?: string }>
    durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> }
    migrations?: Array<{ new_sqlite_classes?: string[] }>
  }
  const seed = await readFile(new URL("../packages/runtime-cloudflare/assets/wordpress-install-seed.sqlite", import.meta.url))
  const markdownIndex = await readFile(new URL("../packages/runtime-cloudflare/assets/markdown-primary-bootstrap-index.sqlite", import.meta.url))
  const markdownRuntime = await readFile(new URL("../packages/runtime-cloudflare/assets/markdown-database-integration-runtime.zip", import.meta.url))

  assert.equal(seed.subarray(0, 16).toString(), "SQLite format 3\0")
  assert.equal(markdownIndex.subarray(0, 16).toString(), "SQLite format 3\0")
  assert.equal(markdownRuntime.subarray(0, 4).toString("hex"), "504b0304")
  assert.ok(config.rules?.some((rule) => rule.type === "Data" && rule.globs?.includes("**/*.sqlite")))
  assert.ok(config.rules?.some((rule) => rule.type === "Data" && rule.globs?.includes("**/*-runtime.zip")))
  assert.deepEqual(config.r2_buckets, [{ binding: "WORDPRESS_STATE_BUCKET", bucket_name: "wp-codebox-runtime-chubes" }])
  assert.deepEqual(config.durable_objects?.bindings, [{ name: "WORDPRESS_STATE", class_name: "WordPressStateCoordinator" }])
  assert.ok(config.migrations?.some((migration) => migration.new_sqlite_classes?.includes("WordPressStateCoordinator")))
})

test("Cloudflare runtime pins and bundles the public constrained MDI runtime", async () => {
  const revision = "1870fb41279e7eb5946e506c9c7406f1f1ea6dc3"
  const generator = await readFile(new URL("../scripts/build-cloudflare-mdi-runtime-bundle.mjs", import.meta.url), "utf8")
  const worker = await readFile(new URL("../packages/runtime-cloudflare/src/worker.ts", import.meta.url), "utf8")
  const runtime = await readFile(new URL("../packages/runtime-cloudflare/assets/markdown-database-integration-runtime.zip", import.meta.url))
  const names: string[] = []
  for await (const entry of decodeZip(new Blob([runtime]).stream())) names.push(entry.name)

  assert.match(generator, new RegExp(`const revision = "${revision}"`))
  assert.match(worker, new RegExp(`MARKDOWN_DATABASE_INTEGRATION_REVISION = "${revision}"`))
  assert.deepEqual(names.sort(), [
    "db.php",
    "inc/class-wp-markdown-db.php",
    "inc/class-wp-markdown-driver.php",
    "inc/class-wp-markdown-frontmatter-profiles.php",
    "inc/class-wp-markdown-loader.php",
    "inc/class-wp-markdown-primary-storage-runtime.php",
    "inc/class-wp-markdown-search.php",
    "inc/class-wp-markdown-storage.php",
    "inc/class-wp-markdown-write-engine.php",
  ])
})

test("Cloudflare routes WordPress and health through the serialized Durable Object runtime", async () => {
  const worker = await readFile(new URL("../packages/runtime-cloudflare/src/worker.ts", import.meta.url), "utf8")
  const materializer = worker.slice(worker.indexOf("async function materializeWordPressServerFiles"), worker.indexOf("function isWordPressServerFile"))
  const predicate = worker.slice(worker.indexOf("function isWordPressServerFile"), worker.indexOf("function createPhpRuntime"))

  assert.match(worker, /return env\.WORDPRESS_STATE\.getByName\("default"\)\.fetch\(request\)/)
  assert.match(worker, /private runtimePromise/)
  assert.match(worker, /private async getRuntime\(origin: string\)/)
  assert.match(worker, /if \(this\.runtimePromise === runtime\) this\.runtimePromise = undefined/)
  assert.match(worker, /route\.kind === "health"\) return this\.health\(runtime\)/)
  assert.match(worker, /runSyntheticMutation\(new URL\(request\.url\)\.origin\)/)
  assert.match(worker, /private async runSyntheticMutation\(origin: string\)/)
  assert.match(worker, /bootWordPressRuntime\("do-not-attempt-installing", true, true, undefined, await readMarkdownRevision/)
  assert.match(worker, /maxPhpInstances: 1/)
  assert.match(materializer, /decodeRemoteZip\(WORDPRESS_ARCHIVE_URL,\s*\(entry: \{ path: Uint8Array \}\) => isWordPressServerFile\(decoder\.decode\(entry\.path\)\)\)/)
  assert.doesNotMatch(materializer, /decodeRemoteZip\(WORDPRESS_ARCHIVE_URL\)(?!\s*,)/)
  assert.match(predicate, /php\|json\|crt\|html\|css\|js\|mjs\|woff2\?\|ttf\|otf\|eot\|svg\|png\|jpe\?g\|gif\|webp\|avif\|ico/)
  assert.match(predicate, /path\.startsWith\("wordpress\/wp-admin\/"\)\) return true/)
})

test("serialized Cloudflare mutations use MDI flush paths and complete canonical state", async () => {
  const source = await readFile(new URL("../packages/runtime-cloudflare/src/worker.ts", import.meta.url), "utf8")
  const mutation = source.slice(source.indexOf("const SERIALIZED_MARKDOWN_MUTATION_CODE"), source.indexOf("interface Env"))

  assert.match(mutation, /WP_Markdown_Primary_Storage_Runtime::bootstrap/)
  assert.match(mutation, /new WP_SQLite_Connection\(\['pdo' => \$GLOBALS\['@pdo'\], 'path' => FQDB\]\)/)
  assert.match(mutation, /\$runtime->get_driver\(\)/)
  assert.match(mutation, /\$runtime->flush\(\)/)
  assert.doesNotMatch(mutation, /write_post|file_put_contents|wp_codebox_mdi_revision\.json/)
  assert.match(source, /validateMarkdownChanges\(mutation\.canonicalChanges\)/)
  assert.match(source, /flush_canonical_writes\(\)/)
  assert.match(source, /bootstrap_existing_cache/)
  assert.match(source, /update_option\('siteurl'/)
  assert.match(source, /_tables\/termmeta\.json/)
  assert.match(source, /_tables\/users\.json/)
  assert.match(source, /WORDPRESS_ADMIN_PASSWORD is required/)
})
