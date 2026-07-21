import { loadPHPRuntime, PHP, type PHPRequestHandler } from "@php-wasm/universal"
import { decodeRemoteZip, decodeZip } from "@php-wasm/stream-compression"
import { bootWordPressAndRequestHandler, type WordPressInstallMode } from "@wp-playground/wordpress"
// The PHP-WASM package publishes this Emscripten loader without TypeScript declarations.
// @ts-expect-error The adjacent Wasm declaration covers the compiled binary import.
import { dependenciesTotalSize, init } from "../../../node_modules/@php-wasm/web-8-5/asyncify/php_8_5.js"
import phpWasmModule from "../../../node_modules/@php-wasm/web-8-5/asyncify/8_5_8/php_8_5.wasm"
import { CLOUDFLARE_RUNTIME_HEALTH_MARKER, CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, cloudflareRuntimeHealthResponse } from "./health-envelope.js"
import { leaseRetryDelayMs } from "./lease-retry.js"
import { routeWorkerRequest } from "./request-routing.js"
import { toFetchResponse, toPHPRequest } from "./request-translation.js"
import { R2_UPLOAD_OBJECT_PREFIX, validateUploadManifestFiles, validateUploadMetadata } from "./upload-persistence.js"
import { deriveWordPressAuthConstants, type WordPressAuthConstant } from "./wordpress-auth.js"
import { isWordPressRuntimeFile, wordpressStaticArchivePath, wordpressStaticContentType } from "./wordpress-runtime-corpus.js"
import { materializeWordPressRuntimeArtifact, type WordPressRuntimeArtifactManifest } from "./wordpress-runtime-artifact.js"
import type { MarkdownPointer } from "./state-coordinator.js"
export { WordPressStateCoordinator } from "./state-coordinator.js"
import markdownDatabaseIntegrationRuntime from "../assets/markdown-database-integration-runtime.zip"
import canonicalMarkdownSeed from "../assets/markdown-database-integration-canonical-seed.zip"
import canonicalMarkdownSeedManifest from "../assets/markdown-database-integration-canonical-seed.json" with { type: "json" }
import markdownPrimaryBootstrapIndex from "../assets/markdown-primary-bootstrap-index.sqlite"
import wordpressInstallSeed from "../assets/wordpress-install-seed.sqlite"
import wordpressRuntimeArtifactManifest from "../assets/wordpress-runtime-artifact.json" with { type: "json" }

const PHP_VERSION = "8.5.8"
// Browser assets must come from the same immutable WordPress release as the server corpus.
const WORDPRESS_ARCHIVE_URL = (wordpressRuntimeArtifactManifest as WordPressRuntimeArtifactManifest).source.url
const SQLITE_INTEGRATION_ARCHIVE_URL = "https://github.com/WordPress/sqlite-database-integration/releases/download/v2.2.23/plugin-sqlite-database-integration.zip"
const MARKDOWN_DATABASE_INTEGRATION_REVISION = "2a8ee7f6a46e1d64b4606f1ee3c97e14032dc96c"
const SITE_URL = "https://wp-codebox-runtime.invalid"
const DATABASE_PATH = "/wordpress/wp-content/database/.ht.sqlite"
const MARKDOWN_ROOT = "/wordpress/wp-content/markdown"
const UPLOADS_ROOT = "/wordpress/wp-content/uploads"
const MARKDOWN_INDEX_PATH = "/tmp/markdown-index.sqlite"
const MARKDOWN_RESOLVED_INDEX_PATH = "/tmp/markdown-index-8133b4cf3c66.sqlite"
const MARKDOWN_CHANGES_PATH = "/tmp/wp-codebox-canonical-changes.json"
const R2_MARKDOWN_REVISION_PREFIX = "sites/default/markdown/revisions"
const R2_MARKDOWN_OBJECT_PREFIX = "sites/default/markdown/objects"
const R2_WORDPRESS_PAGE_PREFIX = "sites/default/pages"
const WORDPRESS_PAGE_CACHE_SCHEMA = "v2"
const SERIALIZED_MARKDOWN_MUTATION_CODE = `<?php
define('SHORTINIT', true);
require '/wordpress/wp-load.php';
foreach (['class-wp-markdown-frontmatter-profiles.php', 'class-wp-markdown-storage.php', 'class-wp-markdown-driver.php', 'class-wp-markdown-search.php', 'class-wp-markdown-write-engine.php', 'class-wp-markdown-loader.php', 'class-wp-markdown-primary-storage-runtime.php'] as $file) require_once '/wordpress/wp-content/plugins/markdown-database-integration/inc/' . $file;
if (!isset($GLOBALS['@pdo']) || !($GLOBALS['@pdo'] instanceof PDO)) {
  throw new Exception('MDI disposable index connection is unavailable.');
}
$prefix = $wpdb->prefix;
$connection = new WP_SQLite_Connection(['pdo' => $GLOBALS['@pdo'], 'path' => FQDB]);
$runtime = WP_Markdown_Primary_Storage_Runtime::bootstrap(
  ['content_root' => MARKDOWN_DB_CONTENT_DIR, 'state_root' => MARKDOWN_DB_STATE_DIR],
  $connection,
  defined('DB_NAME') && '' !== DB_NAME ? DB_NAME : 'database_name_here',
  null,
  true,
  array_filter(array_map('trim', explode(',', MARKDOWN_DB_EXCLUDED_TYPES))),
  $prefix
);
$driver = $runtime->get_driver();
$option_rows = $driver->query("SELECT option_id, option_value FROM \`{\$prefix}options\` WHERE option_name = 'wp_codebox_mdi_revision'");
$current = empty($option_rows) ? 0 : (int) $option_rows[0]->option_value;
$previous_rows = 0 === $current ? [] : $driver->query("SELECT ID FROM \`{\$prefix}posts\` WHERE post_name = 'cloudflare-r2-proof-$current'");
$value = $current + 1;
$post_id_rows = $driver->query("SELECT COALESCE(MAX(ID), 0) + 1 AS post_id FROM \`{\$prefix}posts\`");
$post_id = (int) $post_id_rows[0]->post_id;
$now = gmdate('Y-m-d H:i:s');
$slug = 'cloudflare-r2-proof-' . $value;
$title = 'Cloudflare R2 Proof ' . $value;
$content = 'Persisted by MDI primary mode in R2 revision ' . $value . '.';
$driver->query("INSERT INTO \`{\$prefix}posts\` (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES ($post_id, 0, '$now', '$now', '$content', '$title', '', 'publish', 'closed', 'closed', '', '$slug', '', '', '$now', '$now', '', 0, '', 0, 'post', '', 0)");
if (empty($option_rows)) {
  $driver->query("INSERT INTO \`{\$prefix}options\` (option_name, option_value, autoload) VALUES ('wp_codebox_mdi_revision', '$value', 'off')");
} else {
  $driver->query("UPDATE \`{\$prefix}options\` SET option_value = '$value', autoload = 'off' WHERE option_name = 'wp_codebox_mdi_revision'");
}
$changes = $runtime->flush();
echo json_encode(['revisionValue' => $value, 'previousPostFound' => !empty($previous_rows), 'postId' => $post_id, 'wordpressVersion' => $wp_version, 'canonicalChanges' => $changes]);`
interface Env {
  WORDPRESS_STATE: DurableObjectNamespace
  WORDPRESS_STATE_BUCKET: R2Bucket
  WORDPRESS_ADMIN_PASSWORD?: string
  WORDPRESS_AUTH_SECRET?: string
  WORDPRESS_OPERATOR_TOKEN?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const staticResponse = await serveWordPressStaticAsset(request)
    if (staticResponse) return staticResponse
    const route = routeWorkerRequest(request)
    const coordinator = env.WORDPRESS_STATE.getByName("default")
    const uploadResponse = await serveWordPressUpload(request, env.WORDPRESS_STATE_BUCKET, coordinator)
    if (uploadResponse) return uploadResponse
    if (route.kind === "operator-reset") return resetCanonicalWordPress(request, env, coordinator)
    if (route.kind === "operator-restore") return restoreCanonicalWordPress(request, env, coordinator)
    if (route.kind === "probe") {
      return runBootProbe(route.phase, env.WORDPRESS_STATE_BUCKET)
    }
    if (route.kind === "r2-state") {
      if (request.method !== "GET") return new Response("WordPress state read requires GET.", { status: 405 })
      return coordinator.fetch(new Request(coordinatorUrl(request.url, "state")))
    }
    return runCoordinatedWordPressRequest(request, env, coordinator, route.kind)
  },
}

interface MarkdownManifestFile {
  path: string
  objectKey: string
  sha256: string
  size: number
}

interface MarkdownManifest extends MarkdownPointer {
  files: MarkdownManifestFile[]
  uploads?: MarkdownManifestFile[]
}

interface RuntimeFile {
  path: string
  bytes: Uint8Array
}

interface CoordinatorState {
  pointer: MarkdownPointer | null
}

interface WordPressPageSnapshot {
  schema: "wp-codebox/wordpress-page/v1"
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: string
}

interface CanonicalSeedManifest {
  schema: string
  markdownDatabaseIntegrationRevision: string
  archiveSha256: string
  files: Array<{ path: string; sha256: string; size: number }>
}

interface Lease {
  token: string
  pointer: MarkdownPointer | null
  version: number
  expiresAt: number
}

interface Runtime {
  php: PHP
  requestHandler: PHPRequestHandler
  wordpressVersion: string
  pointer: MarkdownPointer
}

let cachedRuntime: { baseRevision: string; promise: Promise<Runtime> } | undefined
const LEASE_ACQUISITION_TIMEOUT_MS = 100_000

async function resetCanonicalWordPress(request: Request, env: Env, coordinator: DurableObjectStub): Promise<Response> {
  if (request.method !== "POST") return new Response("Canonical reset requires POST.", { status: 405 })
  const authorization = request.headers.get("authorization")
  if (!env.WORDPRESS_OPERATOR_TOKEN || !authorization || !await secretsMatch(authorization, `Bearer ${env.WORDPRESS_OPERATOR_TOKEN}`)) {
    return new Response("Canonical reset authorization failed.", { status: 401 })
  }
  const response = await coordinator.fetch(new Request(coordinatorUrl(request.url, "reset"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
  if (response.ok) await discardCachedRuntime()
  return response
}

async function restoreCanonicalWordPress(request: Request, env: Env, coordinator: DurableObjectStub): Promise<Response> {
  if (request.method !== "POST") return new Response("Canonical restore requires POST.", { status: 405 })
  const authorization = request.headers.get("authorization")
  if (!env.WORDPRESS_OPERATOR_TOKEN || !authorization || !await secretsMatch(authorization, `Bearer ${env.WORDPRESS_OPERATOR_TOKEN}`)) {
    return new Response("Canonical restore authorization failed.", { status: 401 })
  }
  let pointer: MarkdownPointer
  try {
    pointer = await request.json<MarkdownPointer>()
  } catch {
    return new Response("Canonical restore requires a JSON pointer.", { status: 400 })
  }
  if (!isCanonicalRestorePointer(pointer)) return new Response("Canonical restore pointer is invalid.", { status: 400 })
  const manifest = await readMarkdownManifest(env.WORDPRESS_STATE_BUCKET, pointer)
  if (!manifest || manifest.revision !== pointer.revision || manifest.manifestKey !== pointer.manifestKey || manifest.persistedAt !== pointer.persistedAt || !Array.isArray(manifest.files)) {
    return new Response("Canonical restore manifest is unavailable or inconsistent.", { status: 409 })
  }
  const lease = await acquireLease(coordinator, request.url)
  try {
    if (lease.pointer) {
      await abortLease(coordinator, request.url, lease)
      return new Response("Canonical restore requires an empty current pointer.", { status: 409 })
    }
    const restored = await commitLease(coordinator, request.url, lease, pointer)
    await discardCachedRuntime()
    return Response.json({ restored: true, ...restored })
  } catch (error) {
    await abortLease(coordinator, request.url, lease)
    throw error
  }
}

function isCanonicalRestorePointer(pointer: unknown): pointer is MarkdownPointer {
  if (!pointer || typeof pointer !== "object") return false
  const candidate = pointer as Partial<MarkdownPointer>
  return typeof candidate.revision === "string" && /^[a-f0-9-]{36}$/.test(candidate.revision)
    && candidate.manifestKey === `sites/default/markdown/revisions/${candidate.revision}.json`
    && typeof candidate.persistedAt === "string" && Number.isFinite(Date.parse(candidate.persistedAt))
}

async function secretsMatch(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [leftHash, rightHash] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))])
  const leftBytes = new Uint8Array(leftHash)
  const rightBytes = new Uint8Array(rightHash)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index++) difference |= leftBytes[index] ^ rightBytes[index]
  return difference === 0
}

async function runCoordinatedWordPressRequest(request: Request, env: Env, coordinator: DurableObjectStub, route: "wordpress" | "health" | "r2-mutate"): Promise<Response> {
  if (route === "r2-mutate" && request.method !== "POST") return new Response("WordPress state mutation requires POST.", { status: 405 })
  if (route === "wordpress" && isCacheableWordPressPageRequest(request)) {
    const state = await coordinatorCall<CoordinatorState>(coordinator, request.url, "state")
    if (state.pointer) {
      const cachedPage = await matchWordPressPageCache(request, state.pointer, env.WORDPRESS_STATE_BUCKET)
      if (cachedPage) return cachedPage
    }
  }
  let lease = await acquireLease(coordinator, request.url)
  let runtime: Runtime | undefined
  let finalized = false
  try {
    if (!lease.pointer) {
      const bootstrapped = await bootstrapCanonicalRuntime(env, coordinator, request.url, lease)
      // Bootstrap promotion consumes its lease before login or any other request observes it.
      lease = await acquireLease(coordinator, request.url)
      if (!lease.pointer || lease.pointer.revision !== bootstrapped.pointer.revision) throw new Error("Canonical bootstrap promotion was not observed by its next lease.")
      cacheRuntime(lease.pointer, bootstrapped)
    }
    const cachedPage = route === "wordpress" ? await matchWordPressPageCache(request, lease.pointer, env.WORDPRESS_STATE_BUCKET) : null
    if (cachedPage) {
      await releaseLease(coordinator, request.url, lease)
      finalized = true
      return cachedPage
    }
    runtime = await getRuntime(env, lease.pointer, new URL(request.url).origin)
    const mutatesCanonicalState = isMutation(request, route)
    let response: Response
    let canonicalChanges: MarkdownChanges | undefined
    if (route === "r2-mutate") {
      const mutation = await runSyntheticMutation(runtime)
      response = mutation.response
      canonicalChanges = mutation.canonicalChanges
    } else if (route === "health") {
      response = await health(runtime)
    } else {
      if (mutatesCanonicalState) runtime.php.writeFile(MARKDOWN_CHANGES_PATH, new TextEncoder().encode(JSON.stringify({ created: [], changed: [], deleted: [] })))
      response = toFetchResponse(request, await runtime.requestHandler.request(await toPHPRequest(request)))
      if (mutatesCanonicalState) canonicalChanges = readCanonicalChanges(runtime.php)
    }
    if (mutatesCanonicalState) {
      if (!canonicalChanges) throw new Error("Canonical mutation completed without an MDI change set.")
      const next = await persistRuntime(env.WORDPRESS_STATE_BUCKET, runtime, canonicalChanges)
      await commitLease(coordinator, request.url, lease, next)
    } else {
      await releaseLease(coordinator, request.url, lease)
    }
    finalized = true
    if (mutatesCanonicalState) await discardRuntime(runtime)
    else if (route === "wordpress") response = await cacheWordPressPage(request, lease.pointer, response, env.WORDPRESS_STATE_BUCKET)
    return response
  } catch (error) {
    if (!finalized) await abortLease(coordinator, request.url, lease)
    if (runtime) await discardRuntime(runtime)
    throw error
  }
}

function isCacheableWordPressPageRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  if (request.headers.has("authorization") || request.headers.has("cookie")) return false
  const url = new URL(request.url)
  if (["/wp-admin", "/wp-login.php", "/wp-json"].some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) return false
  return !url.searchParams.has("preview") && !url.searchParams.has("rest_route")
}

async function matchWordPressPageCache(request: Request, pointer: MarkdownPointer, bucket: R2Bucket): Promise<Response | null> {
  if (!isCacheableWordPressPageRequest(request)) return null
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  try {
    const cached = cache ? await cache.match(wordPressPageCacheKey(request, pointer)) : null
    if (cached) return pageCacheResponse(cached, request.method === "HEAD", "hit", "edge")
    const object = await bucket.get(await wordPressPageSnapshotKey(request, pointer))
    if (!object) return null
    const snapshot = JSON.parse(await object.text()) as WordPressPageSnapshot
    if (snapshot.schema !== "wp-codebox/wordpress-page/v1" || snapshot.status !== 200 || !Array.isArray(snapshot.headers) || typeof snapshot.body !== "string") return null
    const response = new Response(snapshot.body, { status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers })
    if (cache) await cache.put(wordPressPageCacheKey(request, pointer), response.clone())
    return pageCacheResponse(response, request.method === "HEAD", "hit", "r2")
  } catch {
    return null
  }
}

async function cacheWordPressPage(request: Request, pointer: MarkdownPointer, response: Response, bucket: R2Bucket): Promise<Response> {
  if (!isCacheableWordPressPageRequest(request) || response.status !== 200 || !response.headers.get("content-type")?.includes("text/html") || response.headers.has("set-cookie")) return response
  if (request.method === "HEAD") return pageCacheResponse(response, true, "miss", "render")
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  const cacheable = pageCacheResponse(response, false, "miss", "render")
  try {
    const snapshot: WordPressPageSnapshot = {
      schema: "wp-codebox/wordpress-page/v1",
      status: cacheable.status,
      statusText: cacheable.statusText,
      headers: Array.from(cacheable.headers.entries()),
      body: await cacheable.clone().text(),
    }
    await Promise.all([
      cache ? cache.put(wordPressPageCacheKey(request, pointer), cacheable.clone()) : Promise.resolve(),
      bucket.put(await wordPressPageSnapshotKey(request, pointer), JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" } }),
    ])
  } catch {
    // Page caching is an optimization; canonical rendering remains authoritative.
  }
  return cacheable
}

function wordPressPageCacheKey(request: Request, pointer: MarkdownPointer): Request {
  const url = new URL(request.url)
  url.searchParams.set("__wp_codebox_revision", pointer.revision)
  url.searchParams.set("__wp_codebox_page_cache", WORDPRESS_PAGE_CACHE_SCHEMA)
  return new Request(url, { method: "GET" })
}

async function wordPressPageSnapshotKey(request: Request, pointer: MarkdownPointer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(new URL(request.url).toString()))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${R2_WORDPRESS_PAGE_PREFIX}/${pointer.revision}/${hash}.json`
}

function pageCacheResponse(response: Response, head: boolean, status: "hit" | "miss", source: "edge" | "r2" | "render"): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "public, max-age=60, s-maxage=31536000")
  headers.set("x-wp-codebox-page-cache", status)
  headers.set("x-wp-codebox-page-cache-source", source)
  return new Response(head ? null : response.body, { status: response.status, statusText: response.statusText, headers })
}

function isMutation(request: Request, route: "wordpress" | "health" | "r2-mutate"): boolean {
  return route === "r2-mutate" || !["GET", "HEAD", "OPTIONS"].includes(request.method)
}

function coordinatorUrl(requestUrl: string, action: string): string {
  const url = new URL(requestUrl)
  url.searchParams.set("__wp_codebox_coordinator", action)
  return url.toString()
}

async function coordinatorCall<T>(coordinator: DurableObjectStub, requestUrl: string, action: string, body?: Record<string, unknown>): Promise<T> {
  const response = await coordinator.fetch(new Request(coordinatorUrl(requestUrl, action), body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined))
  if (!response.ok) {
    const detail = await response.text()
    const retryAfter = response.headers.get("retry-after")
    throw new CoordinatorRequestError(response.status, detail, retryAfter ? Number(retryAfter) : undefined)
  }
  return response.json<T>()
}

async function acquireLease(coordinator: DurableObjectStub, requestUrl: string): Promise<Lease> {
  const deadline = Date.now() + LEASE_ACQUISITION_TIMEOUT_MS
  let lastError: CoordinatorRequestError | undefined
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    try {
      return await coordinatorCall<Lease>(coordinator, requestUrl, "begin", {})
    } catch (error) {
      if (!(error instanceof CoordinatorRequestError) || error.status !== 409) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, leaseRetryDelayMs(error.retryAfter, deadline - Date.now())))
    }
  }
  throw new Error(`Timed out waiting for the canonical WordPress lease${lastError ? `: ${lastError.message}` : "."}`)
}

function releaseLease(coordinator: DurableObjectStub, requestUrl: string, lease: Lease): Promise<{ released: true }> {
  return coordinatorCall(coordinator, requestUrl, "release", { token: lease.token })
}

async function abortLease(coordinator: DurableObjectStub, requestUrl: string, lease: Lease): Promise<void> {
  try {
    await coordinatorCall(coordinator, requestUrl, "abort", { token: lease.token })
  } catch (error) {
    if (!(error instanceof CoordinatorRequestError) || error.status !== 409) throw error
  }
}

function commitLease(coordinator: DurableObjectStub, requestUrl: string, lease: Lease, pointer: MarkdownPointer): Promise<{ pointer: MarkdownPointer; version: number }> {
  return coordinatorCall(coordinator, requestUrl, "commit", { token: lease.token, baseRevision: lease.pointer?.revision ?? null, version: lease.version, pointer })
}

async function getRuntime(env: Env, pointer: MarkdownPointer, origin: string): Promise<Runtime> {
  if (cachedRuntime && cachedRuntime.baseRevision !== pointer.revision) await discardCachedRuntime()
  if (!cachedRuntime) {
    const promise = bootRuntime(env.WORDPRESS_STATE_BUCKET, pointer, origin, await canonicalWordPressAuthConstants(env))
    cachedRuntime = { baseRevision: pointer.revision, promise }
    promise.catch(() => {
      if (cachedRuntime?.promise === promise) cachedRuntime = undefined
    })
  }
  return cachedRuntime.promise
}

function cacheRuntime(pointer: MarkdownPointer, runtime: Runtime): void {
  cachedRuntime = { baseRevision: pointer.revision, promise: Promise.resolve(runtime) }
}

async function discardCachedRuntime(): Promise<void> {
  const cached = cachedRuntime
  cachedRuntime = undefined
  if (!cached) return
  try {
    ;(await cached.promise).php.exit()
  } catch {
    // A rejected boot has no live runtime to dispose.
  }
}

async function discardRuntime(runtime: Runtime): Promise<void> {
  if (cachedRuntime?.promise) {
    try {
      if (await cachedRuntime.promise === runtime) cachedRuntime = undefined
    } catch {
      cachedRuntime = undefined
    }
  }
  runtime.php.exit()
}

async function bootRuntime(bucket: R2Bucket, pointer: MarkdownPointer, origin: string, authConstants: Record<WordPressAuthConstant, string>): Promise<Runtime> {
  const revision = await readCanonicalRevision(bucket, pointer)
  return { ...await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, revision.markdown, new Uint8Array(markdownPrimaryBootstrapIndex), origin, authConstants, bucket, true, revision.uploads), pointer }
}

async function bootstrapCanonicalRuntime(env: Env, coordinator: DurableObjectStub, requestUrl: string, lease: Lease): Promise<Runtime> {
  if (!env.WORDPRESS_ADMIN_PASSWORD) throw new Error("WORDPRESS_ADMIN_PASSWORD is required to bootstrap a complete canonical WordPress revision.")
  const origin = new URL(requestUrl).origin
  const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, await packagedCanonicalMarkdownSeed(), new Uint8Array(markdownPrimaryBootstrapIndex), origin, await canonicalWordPressAuthConstants(env), env.WORDPRESS_STATE_BUCKET, true)
  try {
    const passwordFile = "/tmp/wordpress-admin-password"
    runtime.php.writeFile(passwordFile, new TextEncoder().encode(env.WORDPRESS_ADMIN_PASSWORD))
    const passwordOutput = (await runtime.php.run({ code: canonicalBootstrapPasswordCode(passwordFile) })).text.trim()
    if (passwordOutput !== "password-updated") throw new Error("Canonical bootstrap did not update the admin password.")
    const urlOutput = (await runtime.php.run({ code: canonicalBootstrapUrlCode(origin) })).text.trim()
    if (urlOutput !== "urls-updated") throw new Error("Canonical bootstrap did not update the site URLs.")
    const flushOutput = (await runtime.php.run({ code: canonicalBootstrapFlushCode() })).text.trim()
    if (flushOutput !== "flushed") throw new Error("MDI did not confirm canonical bootstrap flush.")
    const pointer = await persistMarkdownRevision(env.WORDPRESS_STATE_BUCKET, collectRuntimeFiles(runtime.php, MARKDOWN_ROOT))
    await commitLease(coordinator, requestUrl, lease, pointer)
    return { ...runtime, pointer }
  } catch (error) {
    runtime.php.exit()
    throw error
  }
}

function canonicalBootstrapPasswordCode(passwordFile: string): string {
  return `<?php
require '/wordpress/wp-load.php';
$password = file_get_contents(${JSON.stringify(passwordFile)});
@unlink(${JSON.stringify(passwordFile)});
if (!is_string($password) || $password === '') throw new Exception('WORDPRESS_ADMIN_PASSWORD was unavailable during canonical bootstrap.');
$admin = get_user_by('login', 'admin');
if (!$admin) throw new Exception('The WordPress seed does not contain the admin user.');
wp_set_password($password, $admin->ID);
echo 'password-updated';`
}

function canonicalBootstrapUrlCode(origin: string): string {
  return `<?php
require '/wordpress/wp-load.php';
update_option('siteurl', ${JSON.stringify(origin)});
update_option('home', ${JSON.stringify(origin)});
echo 'urls-updated';`
}

function canonicalBootstrapFlushCode(): string {
  return `<?php
require '/wordpress/wp-load.php';
$GLOBALS['wpdb']->flush_canonical_writes();
echo 'flushed';`
}
async function canonicalWordPressAuthConstants(env: Env): Promise<Record<WordPressAuthConstant, string>> {
  return deriveWordPressAuthConstants(env.WORDPRESS_AUTH_SECRET ?? "", "default")
}

async function persistRuntime(bucket: R2Bucket, runtime: Runtime, changes: MarkdownChanges): Promise<MarkdownPointer> {
  validateMarkdownChanges(changes)
  const changedPaths = [...changes.created, ...changes.changed].sort((left, right) => left.localeCompare(right))
  return persistMarkdownRevision(bucket, collectRuntimeFiles(runtime.php, MARKDOWN_ROOT, changedPaths), runtime.pointer, changes, await collectUploadFiles(runtime.php))
}

function readCanonicalChanges(php: PHP): MarkdownChanges {
  const raw = new TextDecoder().decode(php.readFileAsBuffer(MARKDOWN_CHANGES_PATH)).trim()
  const changes = JSON.parse(raw) as MarkdownChanges
  validateMarkdownChanges(changes)
  return changes
}

async function runSyntheticMutation(runtime: Runtime): Promise<{ response: Response; canonicalChanges: MarkdownChanges }> {
  const mutationOutput = (await runtime.php.run({ code: SERIALIZED_MARKDOWN_MUTATION_CODE })).text.trim()
  const mutation = JSON.parse(mutationOutput) as { revisionValue: number; previousPostFound: boolean; postId: number; wordpressVersion: string; canonicalChanges: MarkdownChanges }
  validateMarkdownChanges(mutation.canonicalChanges)
  return { response: Response.json({ schema: "wp-codebox/cloudflare-wordpress-mutation/v1", source: "entry-worker-primary-runtime", ...mutation, canonicalFiles: collectRuntimeFiles(runtime.php, MARKDOWN_ROOT).length, markdownDatabaseIntegrationRevision: MARKDOWN_DATABASE_INTEGRATION_REVISION, sqlitePersisted: false }), canonicalChanges: mutation.canonicalChanges }
}

async function health(runtime: Runtime): Promise<Response> {
  const phpVersion = (await runtime.php.run({ code: "<?php echo PHP_VERSION;" })).text.trim()
  return cloudflareRuntimeHealthResponse({ schema: CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, marker: CLOUDFLARE_RUNTIME_HEALTH_MARKER, wordpressVersion: runtime.wordpressVersion, phpVersion, runtime: { backend: "wordpress-playground", environment: "wordpress" }, evidence: { initialization: "completed", execution: "completed", initializationScope: "isolate" } })
}

class CoordinatorRequestError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) {
    super(message)
  }
}

interface MarkdownChanges {
  created: string[]
  changed: string[]
  deleted: string[]
}

function validateMarkdownChanges(changes: MarkdownChanges): void {
  for (const group of [changes.created, changes.changed, changes.deleted]) {
    if (!Array.isArray(group) || group.some((path) => !isCanonicalRelativePath(path))) {
      throw new Error("MDI flush returned an invalid canonical path.")
    }
    if (group.some((path, index) => index > 0 && group[index - 1] >= path)) {
      throw new Error("MDI flush returned non-deterministic canonical paths.")
    }
  }
}

function isCanonicalRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..")
}

async function readCanonicalRevision(bucket: R2Bucket, pointer: MarkdownPointer): Promise<{ markdown: RuntimeFile[]; uploads: RuntimeFile[] }> {
  const manifestObject = await bucket.get(pointer.manifestKey)
  if (!manifestObject) throw new Error(`R2 Markdown manifest is missing: ${pointer.manifestKey}`)
  const manifest = await manifestObject.json<MarkdownManifest>()
  validateUploadManifestFiles(manifest.uploads ?? [])
  return {
    markdown: await readManifestFiles(bucket, manifest.files, "Markdown"),
    uploads: await readManifestFiles(bucket, manifest.uploads ?? [], "upload"),
  }
}

async function readManifestFiles(bucket: R2Bucket, files: MarkdownManifestFile[], label: string): Promise<RuntimeFile[]> {
  return Promise.all(files.map(async (file): Promise<RuntimeFile> => {
    const object = await bucket.get(file.objectKey)
    if (!object) throw new Error(`R2 ${label} object is missing: ${file.objectKey}`)
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.sha256) throw new Error(`R2 ${label} object failed integrity validation: ${file.objectKey}`)
    return { path: file.path, bytes }
  }))
}

async function persistMarkdownRevision(bucket: R2Bucket, files: RuntimeFile[], current?: MarkdownPointer, changes?: MarkdownChanges, uploads: RuntimeFile[] = []): Promise<MarkdownPointer> {
  const currentManifest = current ? await readMarkdownManifest(bucket, current) : null
  if (current && !currentManifest) throw new Error(`R2 Markdown manifest is missing: ${current.manifestKey}`)
  const uploadManifestFiles = await persistUploadObjects(bucket, uploads, currentManifest?.uploads ?? [])
  const uploadsUnchanged = JSON.stringify(currentManifest?.uploads ?? []) === JSON.stringify(uploadManifestFiles)
  if (current && currentManifest && changes) {
    validateMarkdownChanges(changes)
    if (!changes.created.length && !changes.changed.length && !changes.deleted.length && uploadsUnchanged) return current
    const manifestFiles = new Map(currentManifest.files.map((file) => [file.path, file]))
    for (const path of changes.deleted) manifestFiles.delete(path)
    const filesByPath = new Map(files.map((file) => [file.path, file]))
    for (const path of [...changes.created, ...changes.changed]) {
      const file = filesByPath.get(path)
      if (!file) throw new Error(`MDI changed path is missing from the canonical runtime: ${path}`)
      const sha256 = await sha256Hex(file.bytes)
      const objectKey = `${R2_MARKDOWN_OBJECT_PREFIX}/${sha256}`
      await bucket.put(objectKey, file.bytes)
      manifestFiles.set(path, { path, objectKey, sha256, size: file.bytes.byteLength })
    }
    return persistMarkdownManifest(bucket, [...manifestFiles.values()].sort((left, right) => left.path.localeCompare(right.path)), uploadManifestFiles)
  }
  const currentFiles = new Map(currentManifest?.files.map((file) => [file.path, file]) ?? [])
  const manifestFiles = await Promise.all(files.map(async (file): Promise<MarkdownManifestFile> => {
    const sha256 = await sha256Hex(file.bytes)
    const existing = currentFiles.get(file.path)
    if (existing?.sha256 === sha256 && existing.size === file.bytes.byteLength) return existing
    const objectKey = `${R2_MARKDOWN_OBJECT_PREFIX}/${sha256}`
    if (current || !await bucket.head(objectKey)) await bucket.put(objectKey, file.bytes)
    return { path: file.path, objectKey, sha256, size: file.bytes.byteLength }
  }))
  if (current && currentManifest) {
    if (JSON.stringify(currentManifest.files) === JSON.stringify(manifestFiles) && uploadsUnchanged) return current
  }

  return persistMarkdownManifest(bucket, manifestFiles, uploadManifestFiles)
}

async function persistUploadObjects(bucket: R2Bucket, files: RuntimeFile[], current: MarkdownManifestFile[]): Promise<MarkdownManifestFile[]> {
  validateUploadFiles(files)
  const currentFiles = new Map(current.map((file) => [file.path, file]))
  const persisted: MarkdownManifestFile[] = []
  for (const file of files) {
    const sha256 = await sha256Hex(file.bytes)
    const existing = currentFiles.get(file.path)
    if (existing?.sha256 === sha256 && existing.size === file.bytes.byteLength) {
      persisted.push(existing)
      continue
    }
    const objectKey = `${R2_UPLOAD_OBJECT_PREFIX}/${sha256}`
    if (!await bucket.head(objectKey)) await bucket.put(objectKey, file.bytes)
    persisted.push({ path: file.path, objectKey, sha256, size: file.bytes.byteLength })
  }
  return persisted
}

function validateUploadFiles(files: RuntimeFile[]): void {
  validateUploadMetadata(files.map((file) => ({ path: file.path, size: file.bytes.byteLength })))
}

async function persistMarkdownManifest(bucket: R2Bucket, files: MarkdownManifestFile[], uploads: MarkdownManifestFile[] = []): Promise<MarkdownPointer> {
  const revision = crypto.randomUUID()
  const manifestKey = `${R2_MARKDOWN_REVISION_PREFIX}/${revision}.json`
  const persistedAt = new Date().toISOString()
  const pointer: MarkdownPointer = { revision, manifestKey, persistedAt }
  const manifest: MarkdownManifest = { ...pointer, files, uploads }
  await bucket.put(manifestKey, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  })
  return pointer
}

async function readMarkdownManifest(bucket: R2Bucket, pointer: MarkdownPointer): Promise<MarkdownManifest | null> {
  const object = await bucket.get(pointer.manifestKey)
  return object ? object.json<MarkdownManifest>() : null
}

function canonicalBootstrapSetupCode(passwordFile: string, origin: string): string {
  return `<?php
require '/wordpress/wp-load.php';
$password = file_get_contents(${JSON.stringify(passwordFile)});
@unlink(${JSON.stringify(passwordFile)});
if (!is_string($password) || $password === '') throw new Exception('WORDPRESS_ADMIN_PASSWORD was unavailable during canonical bootstrap.');
$admin = get_user_by('login', 'admin');
if (!$admin) throw new Exception('The WordPress seed does not contain the admin user.');
wp_set_password($password, $admin->ID);
$password = null;
update_option('siteurl', ${JSON.stringify(origin)});
update_option('home', ${JSON.stringify(origin)});
$GLOBALS['wpdb']->flush_canonical_writes();
echo 'flushed';`
}


async function packagedCanonicalMarkdownSeed(): Promise<RuntimeFile[]> {
  const manifest = canonicalMarkdownSeedManifest as CanonicalSeedManifest
  if (manifest.schema !== "wp-codebox/cloudflare-canonical-mdi-seed/v1" || manifest.markdownDatabaseIntegrationRevision !== MARKDOWN_DATABASE_INTEGRATION_REVISION) throw new Error("Packaged canonical MDI seed provenance is invalid.")
  if (await sha256Hex(new Uint8Array(canonicalMarkdownSeed)) !== manifest.archiveSha256) throw new Error("Packaged canonical MDI seed hash is invalid.")
  const expected = new Map(manifest.files.map((file) => [file.path, file]))
  const files: RuntimeFile[] = []
  for await (const entry of decodeZip(new Blob([canonicalMarkdownSeed]).stream())) {
    const bytes = new Uint8Array(await entry.arrayBuffer())
    const expectedFile = expected.get(entry.name)
    if (!expectedFile || expectedFile.size !== bytes.byteLength || expectedFile.sha256 !== await sha256Hex(bytes)) throw new Error("Packaged canonical MDI seed file validation failed.")
    files.push({ path: entry.name, bytes })
  }
  if (files.length !== expected.size) throw new Error("Packaged canonical MDI seed archive is incomplete.")
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function runBootProbe(phase: string, bucket: R2Bucket): Promise<Response> {
  if (phase === "wordpress-archive" || phase === "sqlite-archive") {
    const archive = phase === "wordpress-archive"
      ? await fetchArchive(WORDPRESS_ARCHIVE_URL, "wordpress.zip")
      : await fetchArchive(SQLITE_INTEGRATION_ARCHIVE_URL, "sqlite-database-integration.zip")
    return probeResponse(phase, { archiveBytes: archive.size })
  }

  if (phase === "archives") {
    const wordpressZip = await fetchArchive(WORDPRESS_ARCHIVE_URL, "wordpress.zip")
    const sqliteZip = await fetchArchive(SQLITE_INTEGRATION_ARCHIVE_URL, "sqlite-database-integration.zip")
    return probeResponse(phase, { wordpressArchiveBytes: wordpressZip.size, sqliteArchiveBytes: sqliteZip.size })
  }

  if (phase === "php") {
    const php = new PHP(await createPhpRuntime())
    try {
      const phpVersion = (await php.run({ code: "<?php echo PHP_VERSION;" })).text.trim()
      return probeResponse(phase, { phpVersion })
    } finally {
      php.exit()
    }
  }

  if (phase === "php-wordpress-archive" || phase === "wordpress-archive-php") {
    const archive = phase === "wordpress-archive-php"
      ? await fetchArchive(WORDPRESS_ARCHIVE_URL, "wordpress.zip")
      : undefined
    const php = new PHP(await createPhpRuntime())
    try {
      const wordpressZip = archive ?? await fetchArchive(WORDPRESS_ARCHIVE_URL, "wordpress.zip")
      const phpVersion = (await php.run({ code: "<?php echo PHP_VERSION;" })).text.trim()
      return probeResponse(phase, { phpVersion, archiveBytes: wordpressZip.size })
    } finally {
      php.exit()
    }
  }

  if (phase === "streamed-files") {
    const php = new PHP(await createPhpRuntime())
    try {
      const evidence = await materializeWordPressServerFiles(php, bucket)
      const wordpressVersion = (await php.run({ code: "<?php require '/wordpress/wp-includes/version.php'; echo $wp_version;" })).text.trim()
      return probeResponse(phase, { ...evidence, wordpressVersion })
    } finally {
      php.exit()
    }
  }

  if (phase === "mdi-files") {
    const php = new PHP(await createPhpRuntime())
    try {
      const wordpress = await materializeWordPressServerFiles(php, bucket)
      await materializeMarkdownDatabaseIntegration(php)
      materializeRuntimeFiles(php, MARKDOWN_ROOT, initialMarkdownFiles())
      const evidence = (await php.run({
        code: "<?php echo json_encode(['dropin' => file_exists('/wordpress/wp-content/db.php'), 'storage' => file_exists('/wordpress/wp-content/plugins/markdown-database-integration/inc/class-wp-markdown-storage.php'), 'siteurl' => file_exists('/wordpress/wp-content/markdown/_options/siteurl.json')]);",
      })).text.trim()
      return probeResponse(phase, { ...wordpress, ...JSON.parse(evidence) as Record<string, string> })
    } finally {
      php.exit()
    }
  }

  if (phase === "mdi-shortinit") {
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, initialMarkdownFiles(), new Uint8Array(markdownPrimaryBootstrapIndex), SITE_URL, {}, bucket)
    try {
      const evidence = (await runtime.php.run({
        code: "<?php define('SHORTINIT', true); require '/wordpress/wp-load.php'; echo json_encode(['wordpressVersion' => $wp_version, 'markdownDropin' => defined('MARKDOWN_DB_DROPIN'), 'markdownMode' => defined('MARKDOWN_DB_MODE') ? MARKDOWN_DB_MODE : '']);",
      })).text.trim()
      return probeResponse(phase, JSON.parse(evidence) as Record<string, string>)
    } finally {
      runtime.php.exit()
    }
  }

  if (phase === "mdi-wordpress" || phase === "mdi-option" || phase === "mdi-insert") {
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, initialMarkdownFiles(), new Uint8Array(markdownPrimaryBootstrapIndex), SITE_URL, {}, bucket)
    try {
      const operation = phase === "mdi-option"
        ? "$updated = update_option('wp_codebox_mdi_probe', 1); $result = ['updated' => $updated];"
        : phase === "mdi-insert"
          ? "$post_id = wp_insert_post(['post_title' => 'MDI Probe', 'post_name' => 'mdi-probe', 'post_content' => 'MDI probe body.', 'post_status' => 'publish', 'post_type' => 'post'], true); if (is_wp_error($post_id)) { throw new Exception($post_id->get_error_message()); } $result = ['postId' => $post_id];"
          : "$result = [];"
      const evidence = (await runtime.php.run({
        code: `<?php require '/wordpress/wp-load.php'; ${operation} echo json_encode(array_merge(['wordpressVersion' => get_bloginfo('version')], $result));`,
      })).text.trim()
      return probeResponse(phase, JSON.parse(evidence) as Record<string, string>)
    } finally {
      runtime.php.exit()
    }
  }

  if (["mdi-includes", "mdi-embed", "mdi-textdomain", "mdi-ai-client", "mdi-plugin-constants", "mdi-muplugins", "mdi-plugins", "mdi-globals", "mdi-theme", "mdi-site-health-class", "mdi-site-health", "mdi-current-user", "mdi-init", "mdi-wp-loaded"].includes(phase)) {
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, initialMarkdownFiles(), new Uint8Array(markdownPrimaryBootstrapIndex), SITE_URL, {}, bucket)
    try {
      const evidence = (await runtime.php.run({ code: wordpressProbeCode(phase) })).text.trim()
      return probeResponse(phase, JSON.parse(evidence) as Record<string, string>)
    } finally {
      runtime.php.exit()
    }
  }

  if (phase?.startsWith("seeded-")) {
    const runtime = await bootWordPressRuntime(
      "do-not-attempt-installing",
      true,
      true,
      new Uint8Array(wordpressInstallSeed),
      undefined,
      undefined,
      SITE_URL,
      {},
      bucket,
    )
    try {
      const wordpress = (await runtime.php.run({
        code: wordpressProbeCode(phase),
      })).text.trim()
      try {
        return probeResponse(phase, JSON.parse(wordpress) as Record<string, string>)
      } catch {
        return Response.json({
          schema: "wp-codebox/cloudflare-boot-probe/v1",
          phase,
          completed: false,
          evidence: { rawPhpOutput: wordpress },
        }, { status: 500 })
      }
    } finally {
      runtime.php.exit()
    }
  }

  if (phase === "wordpress-files" || phase === "sqlite" || phase === "full" || phase === "streamed-sqlite" || phase === "streamed-wordpress") {
    const runtime = await bootWordPressRuntime(
      phase === "full" || phase === "streamed-wordpress" ? "install-from-existing-files" : "do-not-attempt-installing",
      phase !== "wordpress-files",
      phase === "streamed-sqlite" || phase === "streamed-wordpress",
      undefined,
      undefined,
      undefined,
      SITE_URL,
      {},
      bucket,
    )
    try {
      const phpVersion = (await runtime.php.run({ code: "<?php echo PHP_VERSION;" })).text.trim()
      return probeResponse(phase, { phpVersion, wordpressVersion: runtime.wordpressVersion })
    } finally {
      if (phase !== "full") runtime.php.exit()
    }
  }

  return new Response(`Unknown boot probe phase: ${phase}`, { status: 400 })
}

function wordpressProbeCode(phase: string): string {
  if (phase === "seeded-shortinit") {
    return "<?php define('SHORTINIT', true); require '/wordpress/wp-load.php'; echo json_encode(['wordpressVersion' => $wp_version, 'shortInit' => true]);"
  }
  if (phase === "seeded-wordpress") {
    return "<?php require '/wordpress/wp-load.php'; echo json_encode(['siteUrl' => get_option('siteurl'), 'wordpressVersion' => get_bloginfo('version')]);"
  }

  const stops: Record<string, { needle: string; after?: boolean }> = {
    "seeded-includes": { needle: "add_action( 'after_setup_theme', array( wp_script_modules(), 'add_hooks' ) );" },
    "seeded-embed": { needle: "/**\n * WordPress Textdomain Registry object." },
    "seeded-textdomain": { needle: "// WordPress AI Client initialization." },
    "seeded-ai-client": { needle: "// Load multisite-specific files." },
    "seeded-plugin-constants": { needle: "// Load must-use plugins." },
    "seeded-muplugins": { needle: "if ( is_multisite() ) {\n\tms_cookie_constants();" },
    "seeded-plugins": { needle: "// Define constants which affect functionality if not already defined." },
    "seeded-globals": { needle: "/**\n * Fires before the theme is loaded." },
    "seeded-theme": { needle: "// Create an instance of WP_Site_Health so that Cron events may fire." },
    "seeded-site-health-class": { needle: "WP_Site_Health::get_instance();" },
    "seeded-site-health": { needle: "// Set up current user." },
    "seeded-current-user": { needle: "/**\n * Fires after WordPress has finished loading but before any headers are sent." },
    "seeded-init": { needle: "// Check site status." },
    "seeded-wp-loaded": { needle: "do_action( 'wp_loaded' );", after: true },
  }
  const stop = stops[phase.replace(/^mdi-/, "seeded-")]
  if (!stop) throw new Error(`Unknown seeded WordPress probe phase: ${phase}`)

  return `<?php
$settings_path = '/wordpress/wp-settings.php';
$settings = file_get_contents($settings_path);
$needle = ${JSON.stringify(stop.needle)};
if (strpos($settings, $needle) === false) {
    throw new Exception('WordPress bootstrap probe needle not found.');
}
$stop = "echo json_encode(['wordpressVersion' => \\$wp_version, 'bootstrapPhase' => '${phase}', 'memoryBytes' => memory_get_usage(true), 'peakMemoryBytes' => memory_get_peak_usage(true), 'markdownIndexExists' => file_exists('${MARKDOWN_RESOLVED_INDEX_PATH}')]); return;\n";
$replacement = ${stop.after ? "$needle . \"\\n\" . $stop" : "$stop . $needle"};
file_put_contents($settings_path, str_replace($needle, $replacement, $settings));
require '/wordpress/wp-load.php';`
}

async function bootWordPressRuntime(
  wordpressInstallMode: WordPressInstallMode = "install-from-existing-files",
  includeSqlite = true,
  streamWordPressFiles = false,
  databaseSeed?: Uint8Array,
  markdownFiles?: RuntimeFile[],
  markdownIndexSeed?: Uint8Array,
  siteUrl = SITE_URL,
  authConstants: Partial<Record<WordPressAuthConstant, string>> = {},
  runtimeBucket?: R2Bucket,
  shouldPatchCanonicalRuntimePoliciesAtInit = false,
  uploadFiles?: RuntimeFile[],
): Promise<{ php: PHP; requestHandler: PHPRequestHandler; wordpressVersion: string }> {
  const requestHandler = await bootWordPressAndRequestHandler({
    createPhpRuntime,
    constants: {
      AUTOMATIC_UPDATER_DISABLED: true,
      CONCATENATE_SCRIPTS: false,
      DISABLE_WP_CRON: true,
      SCRIPT_DEBUG: false,
      ...authConstants,
      ...(markdownFiles ? {
        MARKDOWN_DB_CONTENT_DIR: MARKDOWN_ROOT,
        MARKDOWN_DB_EXCLUDED_TYPES: "revision,auto-draft,nav_menu_item,customize_changeset,oembed_cache,wp_navigation,wp_global_styles,wp_template,wp_template_part",
        MARKDOWN_DB_INDEX_PATH: MARKDOWN_INDEX_PATH,
        MARKDOWN_DB_MODE: "primary",
        MARKDOWN_DB_STATE_DIR: MARKDOWN_ROOT,
        MARKDOWN_DB_VERSION: "0.8.3",
      } : {}),
      WP_HTTP_BLOCK_EXTERNAL: true,
    },
    dataSqlPath: DATABASE_PATH,
    // Browser cookies are carried by the Worker Fetch request; Playground's
    // internal store would overwrite that header after an isolate restart.
    cookieStore: false,
    hooks: streamWordPressFiles || databaseSeed || markdownFiles || uploadFiles?.length ? {
      beforeWordPressFiles: streamWordPressFiles || markdownFiles || uploadFiles?.length ? async (php: PHP) => {
        if (streamWordPressFiles) await materializeWordPressServerFiles(php, runtimeBucket)
        if (markdownFiles) {
          await materializeMarkdownDatabaseIntegration(php)
          materializeCanonicalChangeAdapter(php)
          materializeRuntimeFiles(php, MARKDOWN_ROOT, markdownFiles)
          if (markdownIndexSeed) php.writeFile(MARKDOWN_RESOLVED_INDEX_PATH, markdownIndexSeed)
        }
        if (uploadFiles?.length) materializeRuntimeFiles(php, UPLOADS_ROOT, uploadFiles)
        if (shouldPatchCanonicalRuntimePoliciesAtInit) {
          patchCanonicalRuntimePoliciesAtInit(php)
          patchCanonicalThemeJsonCustomCss(php)
        }
      } : undefined,
      beforeDatabaseSetup: databaseSeed ? (php: PHP) => {
        php.mkdir("/wordpress/wp-content/database")
        php.writeFile(DATABASE_PATH, databaseSeed)
      } : undefined,
    } : undefined,
    maxPhpInstances: 1,
    phpVersion: "8.5",
    siteUrl,
    wordPressZip: streamWordPressFiles ? undefined : fetchArchive(WORDPRESS_ARCHIVE_URL, "wordpress.zip"),
    sqliteIntegrationPluginZip: includeSqlite ? fetchArchive(SQLITE_INTEGRATION_ARCHIVE_URL, "sqlite-database-integration.zip") : undefined,
    wordpressInstallMode,
  })
  const php = await requestHandler.getPrimaryPhp()
  const wordpressVersion = (await php.run({ code: "<?php require '/wordpress/wp-includes/version.php'; echo $wp_version;" })).text.trim()
  if (!wordpressVersion) throw new Error("WordPress boot completed without a detected version.")
  return { php, requestHandler, wordpressVersion }
}

function initialMarkdownFiles(): RuntimeFile[] {
  const options = [
    { option_id: 1, option_name: "siteurl", option_value: SITE_URL, autoload: "on" },
    { option_id: 2, option_name: "home", option_value: SITE_URL, autoload: "on" },
    { option_id: 3, option_name: "blogname", option_value: "WP Codebox Cloudflare Runtime", autoload: "on" },
  ]
  return options.map((option) => ({
    path: `_options/${option.option_name}.json`,
    bytes: new TextEncoder().encode(JSON.stringify(option, null, 2)),
  }))
}

function materializeRuntimeFiles(php: PHP, root: string, files: RuntimeFile[]): void {
  for (const file of files) {
    const destination = `${root}/${file.path}`
    php.mkdir(destination.slice(0, destination.lastIndexOf("/")))
    php.writeFile(destination, file.bytes)
  }
}

function patchCanonicalRuntimePoliciesAtInit(php: PHP): void {
  const settingsPath = "/wordpress/wp-settings.php"
  const needle = "do_action( 'init' );"
  const settings = new TextDecoder().decode(php.readFileAsBuffer(settingsPath))
  const firstNeedle = settings.indexOf(needle)
  if (firstNeedle === -1 || firstNeedle !== settings.lastIndexOf(needle)) {
    throw new Error("WordPress canonical runtime policy patch needle was not uniquely found.")
  }
  const replacement = `if ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) {
	remove_action( 'init', 'wp_cron' );
	remove_action( 'init', 'wp_schedule_delete_old_privacy_export_files' );
	remove_action( 'init', 'wp_schedule_update_checks' );
}
// Rewrite rules are derived for each runtime; keep them out of canonical MDI state.
add_filter( 'pre_update_option_rewrite_rules', static function ( $value, $old_value ) {
	return $old_value;
}, PHP_INT_MAX, 2 );
${needle}`
  php.writeFile(settingsPath, new TextEncoder().encode(`${settings.slice(0, firstNeedle)}${replacement}${settings.slice(firstNeedle + needle.length)}`))
}

function patchCanonicalThemeJsonCustomCss(php: PHP): void {
  const path = "/wordpress/wp-includes/class-wp-theme-json.php"
  const needle = "\t\t$blocks_metadata = static::get_blocks_metadata();\n\t\t$style_nodes     = static::get_style_nodes( $this->theme_json, $blocks_metadata, $options );\n\t\t$setting_nodes   = static::get_setting_nodes( $this->theme_json, $blocks_metadata );"
  const source = new TextDecoder().decode(php.readFileAsBuffer(path))
  const index = source.indexOf(needle)
  if (index === -1 || index !== source.lastIndexOf(needle)) throw new Error("WordPress theme JSON custom CSS patch needle was not uniquely found.")
  const fastPath = `\t\tif ( array( 'custom-css' ) === $types ) {
\t\t\treturn (string) _wp_array_get( $this->theme_json, array( 'styles', 'css' ), '' );
\t\t}

`
  php.writeFile(path, new TextEncoder().encode(`${source.slice(0, index)}${fastPath}${source.slice(index)}`))
}

function collectRuntimeFiles(php: PHP, root: string, paths?: string[]): RuntimeFile[] {
  if (paths) {
    return paths.map((path) => {
      if (!isCanonicalRelativePath(path)) throw new Error(`Invalid canonical runtime path: ${path}`)
      const absolute = `${root}/${path}`
      if (php.isDir(absolute)) throw new Error(`Canonical runtime file is missing: ${path}`)
      return { path, bytes: php.readFileAsBuffer(absolute) }
    })
  }
  const files: RuntimeFile[] = []
  const visit = (directory: string): void => {
    for (const name of php.listFiles(directory)) {
      if (name === "." || name === "..") continue
      const path = `${directory}/${name}`
      if (php.isDir(path)) {
        visit(path)
      } else if (!name.includes(".tmp.") && !name.startsWith("markdown-index.sqlite")) {
        files.push({ path: path.slice(root.length + 1), bytes: php.readFileAsBuffer(path) })
      }
    }
  }
  visit(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function collectUploadFiles(php: PHP): Promise<RuntimeFile[]> {
  if (!php.isDir(UPLOADS_ROOT)) return []
  const output = (await php.run({ code: `<?php
$root = '${UPLOADS_ROOT}';
$files = array();
$iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
foreach ($iterator as $file) {
    if (!$file->isFile()) continue;
    $path = str_replace('\\\\', '/', $file->getPathname());
    $files[] = array('path' => substr($path, strlen($root) + 1), 'size' => $file->getSize());
}
usort($files, static fn($left, $right) => strcmp($left['path'], $right['path']));
echo json_encode($files, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);` })).text.trim()
  const metadata: unknown = JSON.parse(output)
  validateUploadMetadata(metadata)
  return metadata.map((file) => ({ path: file.path, bytes: php.readFileAsBuffer(`${UPLOADS_ROOT}/${file.path}`) }))
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function materializeMarkdownDatabaseIntegration(php: PHP): Promise<void> {
  const stream = decodeZip(new Blob([markdownDatabaseIntegrationRuntime]).stream())
  const reader = stream.getReader()
  while (true) {
    const { done, value: entry } = await reader.read()
    if (done) break
    const relative = entry.name
    const bytes = new Uint8Array(await entry.arrayBuffer())
    const destination = `/wordpress/wp-content/plugins/markdown-database-integration/${relative}`
    php.mkdir(destination.slice(0, destination.lastIndexOf("/")))
    php.writeFile(destination, bytes)
    if (relative === "db.php") php.writeFile("/wordpress/wp-content/db.php", bytes)
  }
}

function materializeCanonicalChangeAdapter(php: PHP): void {
  const path = "/wordpress/wp-content/mu-plugins/wp-codebox-cloudflare-canonical-changes.php"
  const source = `<?php
add_action( 'markdown_database_integration_flushed', static function ( $changes ) {
	$json = json_encode( $changes, JSON_UNESCAPED_SLASHES );
	if ( false === $json || false === file_put_contents( '${MARKDOWN_CHANGES_PATH}', $json, LOCK_EX ) ) {
		throw new RuntimeException( 'Failed to expose the canonical MDI change set.' );
	}
}, PHP_INT_MAX );`
  php.mkdir(path.slice(0, path.lastIndexOf("/")))
  php.writeFile(path, new TextEncoder().encode(source))
}

async function materializeWordPressServerFiles(php: PHP, bucket: R2Bucket | undefined): Promise<{ materializedFiles: number; materializedBytes: number }> {
  if (!bucket) throw new Error("WordPress runtime corpus artifact requires WORDPRESS_STATE_BUCKET.")
  return materializeWordPressRuntimeArtifact(php, bucket, wordpressRuntimeArtifactManifest as WordPressRuntimeArtifactManifest)
}

async function serveWordPressUpload(request: Request, bucket: R2Bucket, coordinator: DurableObjectStub): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/wp-content/uploads/")) return null
  let path: string
  try {
    path = decodeURIComponent(url.pathname.slice("/wp-content/uploads/".length))
  } catch {
    return new Response("Invalid WordPress upload path.", { status: 400 })
  }
  if (!isCanonicalRelativePath(path)) return new Response("Invalid WordPress upload path.", { status: 400 })
  const state = await coordinatorCall<CoordinatorState>(coordinator, request.url, "state")
  if (!state.pointer) return null
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  const cacheKey = wordPressUploadCacheKey(request, state.pointer)
  if (request.method === "GET" && cache) {
    try {
      const cached = await cache.match(cacheKey)
      if (cached) return cached
    } catch {
      // R2 remains authoritative when the edge cache is unavailable.
    }
  }
  const manifest = await readMarkdownManifest(bucket, state.pointer)
  validateUploadManifestFiles(manifest?.uploads ?? [])
  const file = manifest?.uploads?.find((candidate) => candidate.path === path)
  if (!file) return new Response("WordPress upload not found.", { status: 404 })
  const object = await bucket.get(file.objectKey)
  if (!object) throw new Error(`R2 upload object is missing: ${file.objectKey}`)
  if (object.size !== file.size) throw new Error(`R2 upload object size is inconsistent: ${file.objectKey}`)
  let body: Uint8Array | null = null
  if (request.method === "GET") {
    body = new Uint8Array(await object.arrayBuffer())
    if (await sha256Hex(body) !== file.sha256) throw new Error(`R2 upload object failed integrity validation: ${file.objectKey}`)
  }
  const headers = new Headers({
    "cache-control": "public, max-age=60",
    "content-length": String(file.size),
    "content-type": wordPressUploadContentType(path),
    etag: `"${file.sha256}"`,
    "x-wp-codebox-static": "r2-upload",
  })
  const response = new Response(body ? Uint8Array.from(body).buffer : null, { status: 200, headers })
  if (request.method === "GET" && cache) {
    try {
      await cache.put(cacheKey, response.clone())
    } catch {
      // R2 remains authoritative when the edge cache is unavailable.
    }
  }
  return response
}

function wordPressUploadCacheKey(request: Request, pointer: MarkdownPointer): Request {
  const url = new URL(request.url)
  url.searchParams.set("__wp_codebox_revision", pointer.revision)
  return new Request(url, { method: "GET" })
}

function wordPressUploadContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return ({
    avif: "image/avif",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
    xml: "application/xml",
  } as Record<string, string>)[extension] ?? "application/octet-stream"
}

async function serveWordPressStaticAsset(request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const archivePath = wordpressStaticArchivePath(new URL(request.url).pathname)
  if (!archivePath) return null

  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  if (request.method === "GET" && cache) {
    try {
      const cached = await cache.match(request)
      if (cached) return cached
    } catch {
      // Cache availability is an optimization, never a dependency.
    }
  }

  const decoder = new TextDecoder()
  const stream = await decodeRemoteZip(WORDPRESS_ARCHIVE_URL, (entry: { path: Uint8Array }) => decoder.decode(entry.path) === archivePath)
  const reader = stream.getReader()
  const { done, value: entry } = await reader.read()
  if (done || !entry) return new Response("Not found", { status: 404 })
  const path = entry instanceof File ? entry.name : decoder.decode(entry.path)
  if (path !== archivePath) return new Response("Not found", { status: 404 })
  const bytes = entry instanceof File ? new Uint8Array(await entry.arrayBuffer()) : entry.bytes
  const response = new Response(request.method === "HEAD" ? null : bytes, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": wordpressStaticContentType(archivePath),
      "x-wp-codebox-static": "wordpress-archive",
    },
  })
  if (request.method === "GET" && cache) {
    try {
      await cache.put(request, response.clone())
    } catch {
      // A full or unavailable Worker cache must not affect the archive response.
    }
  }
  return response
}


function createPhpRuntime() {
  return loadPHPRuntime(
    { dependencyFilename: "php_8_5.wasm", dependenciesTotalSize, phpWasmAsyncMode: "asyncify", init },
    { instantiateWasm: instantiatePrecompiledWasm(phpWasmModule) },
  )
}

async function fetchArchive(url: string, name: string): Promise<File> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Unable to fetch ${name}: ${response.status}.`)
  return new File([await response.arrayBuffer()], name, { type: "application/zip" })
}

function instantiatePrecompiledWasm(module: WebAssembly.Module) {
  return (imports: WebAssembly.Imports, receiveInstance: (instance: WebAssembly.Instance, wasmModule: WebAssembly.Module) => void) => receiveInstance(new WebAssembly.Instance(module, imports), module)
}

function probeResponse(phase: string, evidence: Record<string, number | string>): Response {
  return Response.json({ schema: "wp-codebox/cloudflare-boot-probe/v1", phase, completed: true, evidence })
}
