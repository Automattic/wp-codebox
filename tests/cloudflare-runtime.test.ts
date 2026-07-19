import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { decodeZip, encodeZip } from "@php-wasm/stream-compression"
import { RUNTIME_COMMAND_RESULT_SCHEMA } from "../packages/runtime-core/src/runtime-contracts.js"
import { CLOUDFLARE_RUNTIME_HEALTH_MARKER, CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, cloudflareRuntimeHealthResponse } from "../packages/runtime-cloudflare/src/health-envelope.js"
import { routeWorkerRequest } from "../packages/runtime-cloudflare/src/request-routing.js"
import { toFetchResponse, toPHPRequest } from "../packages/runtime-cloudflare/src/request-translation.js"
import { WordPressStateCoordinator } from "../packages/runtime-cloudflare/src/state-coordinator.js"
import { isWordPressRuntimeFile, wordpressStaticArchivePath, wordpressStaticContentType } from "../packages/runtime-cloudflare/src/wordpress-runtime-corpus.js"
import { materializeWordPressRuntimeArtifact, WORDPRESS_RUNTIME_ARTIFACT_SCHEMA, wordpressRuntimeArtifactKey, type WordPressRuntimeArtifactManifest } from "../packages/runtime-cloudflare/src/wordpress-runtime-artifact.js"

const execFileAsync = promisify(execFile)

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
  assert.deepEqual(routeWorkerRequest(new Request("https://worker.example/?phase=canonical-auth")), { kind: "canonical-auth" })
  assert.deepEqual(routeWorkerRequest(new Request("https://worker.example/?phase=seeded-wordpress")), { kind: "probe", phase: "seeded-wordpress" })
})

test("Cloudflare serves only safe browser assets from the WordPress archive", () => {
  assert.equal(wordpressStaticArchivePath("/wp-includes/js/jquery/jquery.min.js"), "wordpress/wp-includes/js/jquery/jquery.min.js")
  assert.equal(wordpressStaticArchivePath("/wp-admin/css/common.min.css"), "wordpress/wp-admin/css/common.min.css")
  assert.equal(wordpressStaticArchivePath("/wp-content/themes/twentytwentyfive/assets/fonts/manrope.woff2"), "wordpress/wp-content/themes/twentytwentyfive/assets/fonts/manrope.woff2")
  assert.equal(wordpressStaticArchivePath("/wp-content/themes/twentytwentyfive/style.css"), "wordpress/wp-content/themes/twentytwentyfive/style.css")
  assert.equal(wordpressStaticArchivePath("/wp-admin/admin-ajax.php"), null)
  assert.equal(wordpressStaticArchivePath("/wp-includes/version.php"), null)
  assert.equal(wordpressStaticArchivePath("/wp-content/plugins/example/app.js"), null)
  assert.equal(wordpressStaticArchivePath("/wp-includes/%2e%2e/wp-config.php"), null)
  assert.equal(wordpressStaticArchivePath("/wp-includes/..%2fwp-config.php"), null)
  assert.equal(wordpressStaticContentType("wordpress/wp-includes/js/jquery/jquery.min.js"), "text/javascript; charset=utf-8")
  assert.equal(wordpressStaticContentType("wordpress/wp-content/themes/example/assets/font.woff2"), "font/woff2")
  assert.equal(wordpressStaticContentType("wordpress/wp-admin/images/logo.png"), "image/png")
})

test("WordPress boot corpus excludes browser assets while retaining server metadata", () => {
  const paths = new Set<string>()
  assert.ok(isWordPressRuntimeFile("wordpress/wp-includes/version.php", paths))
  assert.ok(isWordPressRuntimeFile("wordpress/wp-includes/blocks/paragraph/block.json", paths))
  assert.ok(isWordPressRuntimeFile("wordpress/wp-content/themes/twentytwentyfive/style.css", paths))
  assert.ok(isWordPressRuntimeFile("wordpress/wp-admin/css/view-transitions.min.css", paths))
  assert.ok(isWordPressRuntimeFile("wordpress/wp-includes/js/wp-emoji-loader.min.js", paths))
  assert.ok(isWordPressRuntimeFile("wordpress/wp-admin/images/dashboard-background.svg", paths))
  assert.ok(!isWordPressRuntimeFile("wordpress/wp-includes/js/jquery/jquery.min.js", paths))
  assert.ok(!isWordPressRuntimeFile("wordpress/wp-admin/css/common.min.css", paths))
  assert.ok(!isWordPressRuntimeFile("wordpress/wp-content/themes/twentytwentyfive/assets/fonts/manrope.woff2", paths))
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
  const config = JSON.parse((await readFile(new URL("../packages/runtime-cloudflare/wrangler.jsonc", import.meta.url), "utf8")).replace(/^\s*\/\/.*\n/, "")) as { limits?: { cpu_ms?: number } }
  assert.equal(config.limits?.cpu_ms, 300_000)
})

test("Cloudflare runtime packages a provenanced canonical MDI seed", async () => {
  const config = JSON.parse((await readFile(new URL("../packages/runtime-cloudflare/wrangler.jsonc", import.meta.url), "utf8")).replace(/^\s*\/\/.*\n/, "")) as {
    rules?: Array<{ type?: string; globs?: string[] }>
    r2_buckets?: Array<{ binding?: string; bucket_name?: string }>
    durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> }
    migrations?: Array<{ new_sqlite_classes?: string[] }>
  }
  const markdownIndex = await readFile(new URL("../packages/runtime-cloudflare/assets/markdown-primary-bootstrap-index.sqlite", import.meta.url))
  const markdownRuntime = await readFile(new URL("../packages/runtime-cloudflare/assets/markdown-database-integration-runtime.zip", import.meta.url))
  const canonicalSeed = await readFile(new URL("../packages/runtime-cloudflare/assets/markdown-database-integration-canonical-seed.zip", import.meta.url))
  const sqliteInput = await readFile(new URL("../packages/runtime-cloudflare/assets/wordpress-install-seed.sqlite", import.meta.url))
  const canonicalManifest = JSON.parse(await readFile(new URL("../packages/runtime-cloudflare/assets/markdown-database-integration-canonical-seed.json", import.meta.url), "utf8")) as { markdownDatabaseIntegrationRevision: string; wordpressInstallSeedSha256: string; archiveSha256: string; files: Array<{ path: string }> }

  assert.equal(markdownIndex.subarray(0, 16).toString(), "SQLite format 3\0")
  assert.equal(markdownRuntime.subarray(0, 4).toString("hex"), "504b0304")
  assert.equal(canonicalSeed.subarray(0, 4).toString("hex"), "504b0304")
  assert.equal(canonicalManifest.markdownDatabaseIntegrationRevision, "1870fb41279e7eb5946e506c9c7406f1f1ea6dc3")
  assert.equal(canonicalManifest.wordpressInstallSeedSha256, createHash("sha256").update(sqliteInput).digest("hex"))
  assert.equal(canonicalManifest.archiveSha256, createHash("sha256").update(canonicalSeed).digest("hex"))
  assert.ok(canonicalManifest.files.some((file) => file.path.endsWith(".md")))
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

test("Cloudflare keeps PHP-WASM in the entry Worker and uses the Durable Object only for leases", async () => {
  const worker = await readFile(new URL("../packages/runtime-cloudflare/src/worker.ts", import.meta.url), "utf8")
  const coordinator = await readFile(new URL("../packages/runtime-cloudflare/src/state-coordinator.ts", import.meta.url), "utf8")
  const materializer = worker.slice(worker.indexOf("async function materializeWordPressServerFiles"), worker.indexOf("async function serveWordPressStaticAsset"))
  const corpus = await readFile(new URL("../packages/runtime-cloudflare/src/wordpress-runtime-corpus.ts", import.meta.url), "utf8")

  assert.match(worker, /return runCoordinatedWordPressRequest\(request, env, coordinator, route\.kind\)/)
  assert.match(worker, /let cachedRuntime/)
  assert.match(worker, /cachedRuntime\.baseRevision !== pointer\.revision/)
  assert.match(worker, /promise\.catch\(\(\) =>/)
  assert.match(worker, /runtime\.pointer = next/)
  assert.match(worker, /cacheRuntime\(next, runtime\)/)
  assert.match(worker, /await abortLease\(coordinator, request\.url, lease\)/)
  assert.match(worker, /const LEASE_ACQUISITION_TIMEOUT_MS = 100_000/)
  assert.match(worker, /bootWordPressRuntime\("do-not-attempt-installing", true, true, undefined, await readMarkdownRevision/)
  const noPointerBoot = worker.slice(worker.indexOf("async function bootstrapCanonicalRuntime"), worker.indexOf("async function persistRuntime"))
  assert.match(noPointerBoot, /packagedCanonicalMarkdownSeed\(\)/)
  assert.match(noPointerBoot, /canonicalBootstrapSetupCode\(passwordFile, origin\)/)
  assert.match(noPointerBoot, /await commitLease\(coordinator, requestUrl, lease, pointer\)/)
  assert.doesNotMatch(noPointerBoot, /wordpressInstallSeed|databaseSeed|bootstrap_existing_cache/)
  assert.doesNotMatch(coordinator, /@php-wasm|PHPRequestHandler|bootWordPressRuntime|new PHP\(/)
  assert.match(coordinator, /token: crypto\.randomUUID\(\)/)
  assert.match(coordinator, /record\.version\+\+/)
  assert.match(coordinator, /lease\.expiresAt <= Date\.now\(\)/)
  assert.match(worker, /phase === "canonical-session"/)
  assert.match(worker, /canonicalAuthProbe\(runtime, request\)/)
  assert.match(worker, /WP_Session_Tokens::get_instance/)
  assert.match(worker, /wp_validate_auth_cookie\('', 'logged_in'\)/)
  assert.match(worker, /authConstantsDefined/)
  assert.match(worker, /adminCookieValidated/)
  assert.match(worker, /cookieStore: false/)
  assert.match(worker, /meta_key\?\.endsWith\("session_tokens"\)/)
  assert.match(worker, /maxPhpInstances: 1/)
  assert.match(worker, /WORDPRESS_AUTH_SECRET/)
  assert.match(worker, /canonicalWordPressAuthConstants\(env\)/)
  assert.match(worker, /authConstants/)
  assert.match(worker, /const staticResponse = await serveWordPressStaticAsset\(request\)/)
  assert.ok(worker.indexOf("const staticResponse = await serveWordPressStaticAsset(request)") < worker.indexOf("const coordinator = env.WORDPRESS_STATE.getByName"))
  assert.match(worker, /CONCATENATE_SCRIPTS: false/)
  assert.match(worker, /SCRIPT_DEBUG: false/)
  assert.match(worker, /decodeRemoteZip\(WORDPRESS_ARCHIVE_URL, \(entry: \{ path: Uint8Array \}\) => decoder\.decode\(entry\.path\) === archivePath\)/)
  assert.match(worker, /request\.method === "HEAD" \? null : bytes/)
  assert.match(worker, /"x-wp-codebox-static": "wordpress-archive"/)
  assert.match(worker, /cache\.match\(request\)/)
  assert.match(worker, /cache\.put\(request, response\.clone\(\)\)/)
  assert.match(materializer, /materializeWordPressRuntimeArtifact\(php, bucket, wordpressRuntimeArtifactManifest/)
  assert.doesNotMatch(materializer, /decodeRemoteZip\(WORDPRESS_ARCHIVE_URL/)
  assert.match(corpus, /path\.endsWith\("\.map"\)/)
  assert.match(corpus, /SERVER_READ_EXTENSION/)
  assert.match(corpus, /path\.endsWith\("\/style\.css"\)/)
  assert.match(corpus, /STATIC_ARCHIVE_ROOTS/)
})

test("WordPress runtime artifacts are content-addressed and reject unavailable or corrupt R2 objects", async () => {
  const source = new TextEncoder().encode("<?php $wp_version = '6.8.1';")
  const archive = new Uint8Array(await new Response(encodeZip([new File([source], "wordpress/wp-includes/version.php", { lastModified: 0 })])).arrayBuffer())
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  const manifest: WordPressRuntimeArtifactManifest = {
    schema: WORDPRESS_RUNTIME_ARTIFACT_SCHEMA,
    key: wordpressRuntimeArtifactKey(sha256(archive)),
    archive: { sha256: sha256(archive), size: archive.byteLength },
    source: { url: "https://downloads.wordpress.org/release/wordpress-6.8.1.zip", version: "6.8.1" },
    files: [{ path: "wordpress/wp-includes/version.php", size: source.byteLength, sha256: sha256(source) }],
  }
  const writes = new Map<string, Uint8Array>()
  const php = { mkdir: () => {}, writeFile: (path: string, bytes: Uint8Array) => writes.set(path, bytes) }
  let arrayBufferReads = 0
  const bucket = (bytes: Uint8Array | null) => ({ get: async () => bytes === null ? null : {
    size: bytes.byteLength,
    // R2 supplies both helpers. Reading body would fail this production-shaped mock.
    body: new ReadableStream({ pull: (controller) => controller.error(new Error("R2 body stream should not be read directly.")) }),
    arrayBuffer: async () => {
      arrayBufferReads++
      return new Blob([bytes]).arrayBuffer()
    },
  } })

  await assert.rejects(materializeWordPressRuntimeArtifact(php, bucket(null) as never, manifest), /unavailable/)
  await assert.rejects(materializeWordPressRuntimeArtifact(php, bucket(new Uint8Array([...archive, 0])) as never, manifest), /size does not match/)
  const oversized = { get: async () => ({ size: 33 * 1024 * 1024, body: new ReadableStream(), arrayBuffer: async () => { throw new Error("oversized archive must not be read") } }) }
  await assert.rejects(materializeWordPressRuntimeArtifact(php, oversized as never, manifest), /exceeds its size budget/)
  const hashCorruptManifest = { ...manifest, key: wordpressRuntimeArtifactKey("a".repeat(64)), archive: { ...manifest.archive, sha256: "a".repeat(64) } }
  await assert.rejects(materializeWordPressRuntimeArtifact(php, bucket(archive) as never, hashCorruptManifest), /archive hash does not match/)
  assert.equal(writes.size, 0, "hash-corrupt archives fail before extraction")
  const evidence = await materializeWordPressRuntimeArtifact(php, bucket(archive) as never, manifest)
  assert.equal(arrayBufferReads, 2, "valid and hash-corrupt archives use R2 arrayBuffer()")
  assert.deepEqual(evidence, { materializedFiles: 1, materializedBytes: source.byteLength })
  assert.deepEqual(writes.get("/wordpress/wp-includes/version.php"), source)
})

test("WordPress runtime artifact validation rejects path traversal and invalid budgets", async () => {
  const manifest: WordPressRuntimeArtifactManifest = {
    schema: WORDPRESS_RUNTIME_ARTIFACT_SCHEMA,
    key: wordpressRuntimeArtifactKey("a".repeat(64)),
    archive: { sha256: "a".repeat(64), size: 1 },
    source: { url: "https://downloads.wordpress.org/release/wordpress-6.8.1.zip" },
    files: [{ path: "wordpress/../wp-includes/version.php", size: 9 * 1024 * 1024, sha256: "b".repeat(64) }],
  }
  const php = { mkdir: () => {}, writeFile: () => {} }
  await assert.rejects(materializeWordPressRuntimeArtifact(php, { get: async () => null } as never, manifest), /invalid file path/)
})

test("WordPress runtime corpus generator keeps the ZIP outside the Worker bundle", async () => {
  const generator = await readFile(new URL("../scripts/generate-cloudflare-wordpress-runtime-corpus.ts", import.meta.url), "utf8")
  const artifact = await readFile(new URL("../packages/runtime-cloudflare/src/wordpress-runtime-artifact.ts", import.meta.url), "utf8")
  const manifest = JSON.parse(await readFile(new URL("../packages/runtime-cloudflare/assets/wordpress-runtime-artifact.json", import.meta.url), "utf8")) as WordPressRuntimeArtifactManifest
  assert.match(generator, /decodeRemoteZip\(sourceUrl/)
  assert.match(generator, /encodeZip\(selected\)/)
  assert.match(generator, /lastModified: 0/)
  assert.match(generator, /artifacts\/cloudflare-wordpress-runtime-corpus\.zip/)
  assert.match(artifact, /decodeZip\(new Blob\(\[archiveBytes\]\)\.stream\(\)\)/)
  assert.equal(manifest.key, wordpressRuntimeArtifactKey(manifest.archive.sha256))
  assert.ok(manifest.files.length > 0)
})

test("Cloudflare coordinator serializes leases, promotes with CAS, and recovers stale leases", async () => {
  const values = new Map<string, unknown>()
  const objects = new Map<string, string>()
  const state = {
    id: { toString: () => "test-do" },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value) },
    },
  }
  const bucket = {
    get: async (key: string) => objects.has(key) ? { json: async <T>() => JSON.parse(objects.get(key)!) as T } : null,
    put: async (key: string, value: string) => { objects.set(key, value) },
  }
  const coordinator = new WordPressStateCoordinator(state as never, { WORDPRESS_STATE_BUCKET: bucket as never, COORDINATOR_LEASE_MS: 50 })
  const call = async (action: string, body: Record<string, unknown> = {}) => coordinator.fetch(new Request(`https://worker.example/?__wp_codebox_coordinator=${action}`, { method: action === "state" ? "GET" : "POST", headers: { "content-type": "application/json" }, body: action === "state" ? undefined : JSON.stringify(body) }))

  const first = await (await call("begin")).json() as { token: string; pointer: null; version: number }
  assert.equal(first.pointer, null)
  assert.equal((await call("begin")).status, 409)
  const pointer = { revision: "one", manifestKey: "sites/default/markdown/revisions/one.json", persistedAt: "2026-01-01T00:00:00.000Z" }
  assert.equal((await call("commit", { token: first.token, baseRevision: null, version: first.version, pointer })).status, 200)
  assert.equal(JSON.parse(objects.get("sites/default/markdown/current.json")!).revision, "one")
  const second = await (await call("begin")).json() as { token: string; pointer: { revision: string } }
  assert.equal(second.pointer.revision, "one")
  assert.equal((await call("abort", { token: second.token })).status, 200)
  const stale = await (await call("begin")).json() as { token: string }
  await new Promise((resolve) => setTimeout(resolve, 60))
  const recovered = await (await call("begin")).json() as { token: string }
  assert.notEqual(recovered.token, stale.token)
  assert.equal((await call("release", { token: recovered.token })).status, 200)
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
  assert.match(source, /packagedCanonicalMarkdownSeed/)
  assert.match(source, /update_option\('siteurl'/)
  assert.match(source, /WORDPRESS_ADMIN_PASSWORD is required/)
})

test("canonical MDI seed generator is reproducible and validates its pinned inputs", async () => {
  const generator = new URL("../scripts/build-cloudflare-canonical-mdi-seed.php", import.meta.url)
  const archive = new URL("../packages/runtime-cloudflare/assets/markdown-database-integration-canonical-seed.zip", import.meta.url)
  const before = createHash("sha256").update(await readFile(archive)).digest("hex")
  await execFileAsync("php", [generator.pathname], { cwd: new URL("..", import.meta.url).pathname })
  const after = createHash("sha256").update(await readFile(archive)).digest("hex")
  assert.equal(after, before)
  const source = await readFile(generator, "utf8")
  assert.match(source, /bootstrap_existing_cache/)
  assert.match(source, /SELECT ID FROM wp_posts ORDER BY ID/)
  assert.match(source, /MDI_REVISION/)
})
