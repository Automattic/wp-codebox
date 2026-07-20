import { loadPHPRuntime, PHP, type PHPRequestHandler } from "@php-wasm/universal"
import { decodeRemoteZip, decodeZip } from "@php-wasm/stream-compression"
import { bootWordPressAndRequestHandler, type WordPressInstallMode } from "@wp-playground/wordpress"
// The PHP-WASM package publishes this Emscripten loader without TypeScript declarations.
// @ts-expect-error The adjacent Wasm declaration covers the compiled binary import.
import { dependenciesTotalSize, init } from "../../../node_modules/@php-wasm/web-8-5/asyncify/php_8_5.js"
import phpWasmModule from "../../../node_modules/@php-wasm/web-8-5/asyncify/8_5_8/php_8_5.wasm"
import { CLOUDFLARE_RUNTIME_HEALTH_MARKER, CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, cloudflareRuntimeHealthResponse } from "./health-envelope.js"
import { leaseRetryDelayMs } from "./lease-retry.js"
import { routeWorkerRequest, type EditorMemoryProbePhase } from "./request-routing.js"
import { toFetchResponse, toPHPRequest } from "./request-translation.js"
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
const MARKDOWN_DATABASE_INTEGRATION_REVISION = "7cf025f2d64aa933d937f1a18a129e278c231783"
const SITE_URL = "https://wp-codebox-runtime.invalid"
const DATABASE_PATH = "/wordpress/wp-content/database/.ht.sqlite"
const MARKDOWN_ROOT = "/wordpress/wp-content/markdown"
const MARKDOWN_INDEX_PATH = "/tmp/markdown-index.sqlite"
const MARKDOWN_RESOLVED_INDEX_PATH = "/tmp/markdown-index-8133b4cf3c66.sqlite"
const MARKDOWN_CHANGES_PATH = "/tmp/wp-codebox-canonical-changes.json"
const R2_MARKDOWN_REVISION_PREFIX = "sites/default/markdown/revisions"
const R2_MARKDOWN_OBJECT_PREFIX = "sites/default/markdown/objects"
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
    if (route.kind === "operator-reset") return resetCanonicalWordPress(request, env, coordinator)
    if (route.kind === "editor-memory-probe") return runEditorMemoryProbe(request, env, coordinator, route.phase)
    if (route.kind === "probe") {
      if (route.phase === "canonical-session") return canonicalSessionProbe(env.WORDPRESS_STATE_BUCKET, await coordinatorCall<{ pointer: MarkdownPointer | null }>(coordinator, request.url, "state"))
      return runBootProbe(route.phase, env.WORDPRESS_STATE_BUCKET)
    }
    if (route.kind === "r2-state") {
      if (request.method !== "GET") return new Response("WordPress state read requires GET.", { status: 405 })
      return coordinator.fetch(new Request(coordinatorUrl(request.url, "state")))
    }
    if (route.kind === "canonical-auth") return runCoordinatedWordPressRequest(request, env, coordinator, route.kind)
    return runCoordinatedWordPressRequest(request, env, coordinator, route.kind)
  },
}

async function runEditorMemoryProbe(request: Request, env: Env, coordinator: DurableObjectStub, phase: EditorMemoryProbePhase): Promise<Response> {
  const lease = await acquireLease(coordinator, request.url)
  let finalized = false
  try {
    if (!lease.pointer) throw new Error("Canonical WordPress must be initialized before running an editor memory probe.")
    const runtime = await getRuntime(env, lease.pointer, new URL(request.url).origin)
    patchEditorMemoryStop(runtime.php, phase)
    const response = toFetchResponse(request, await runtime.requestHandler.request(await toPHPRequest(request)))
    await releaseLease(coordinator, request.url, lease)
    finalized = true
    await discardCachedRuntime()
    return response
  } catch (error) {
    if (!finalized) await abortLease(coordinator, request.url, lease)
    await discardCachedRuntime()
    throw error
  }
}

function patchEditorMemoryStop(php: PHP, phase: EditorMemoryProbePhase): void {
  const stops: Record<EditorMemoryProbePhase, { path: string; marker: string; before: boolean }> = {
    admin: { path: "/wordpress/wp-admin/post-new.php", marker: "require_once __DIR__ . '/admin.php';", before: false },
    "before-insert": { path: "/wordpress/wp-admin/includes/post.php", marker: "if ( $create_in_db ) {", before: false },
    "after-insert": { path: "/wordpress/wp-admin/includes/post.php", marker: `$post_id = wp_insert_post(
			array(
				'post_title'  => post_type_supports( $post_type, 'title' ) ? __( 'Auto Draft' ) : '',
				'post_type'   => $post_type,
				'post_status' => 'auto-draft',
			),
			true,
			false
		);`, before: false },
    "after-get-post": { path: "/wordpress/wp-admin/includes/post.php", marker: "if ( current_theme_supports( 'post-formats' )", before: true },
    "before-hooks": { path: "/wordpress/wp-admin/includes/post.php", marker: "wp_after_insert_post( $post, false, null );", before: true },
    "after-hooks": { path: "/wordpress/wp-admin/includes/post.php", marker: "// Schedule auto-draft cleanup.", before: true },
    "before-preload-paths": { path: "/wordpress/wp-admin/edit-form-blocks.php", marker: "$preload_paths = array(", before: true },
    "before-rest-preload": { path: "/wordpress/wp-admin/edit-form-blocks.php", marker: "block_editor_rest_api_preload( $preload_paths, $block_editor_context );", before: true },
    "before-rest-preload-skip-global-styles": { path: "/wordpress/wp-admin/edit-form-blocks.php", marker: "block_editor_rest_api_preload( $preload_paths, $block_editor_context );", before: true },
    "after-rest-preload": { path: "/wordpress/wp-admin/edit-form-blocks.php", marker: "block_editor_rest_api_preload( $preload_paths, $block_editor_context );", before: false },
    "after-block-definitions": { path: "/wordpress/wp-admin/edit-form-blocks.php", marker: "// Preload server-registered block bindings sources.", before: true },
    "before-editor-settings": { path: "/wordpress/wp-admin/edit-form-blocks.php", marker: "$editor_settings = get_block_editor_settings( $editor_settings, $block_editor_context );", before: true },
    "settings-before-styles": { path: "/wordpress/wp-includes/block-editor.php", marker: "$global_styles = array();", before: true },
    "settings-before-global": { path: "/wordpress/wp-includes/block-editor.php", marker: "$editor_settings['__experimentalFeatures'] = wp_get_global_settings();", before: true },
    "settings-before-assets": { path: "/wordpress/wp-includes/block-editor.php", marker: "$editor_settings['__unstableResolvedAssets']", before: true },
    "settings-after-assets": { path: "/wordpress/wp-includes/block-editor.php", marker: "$editor_settings['__unstableIsBlockBasedTheme']", before: true },
    "after-editor-settings": { path: "/wordpress/wp-admin/edit-form-blocks.php", marker: "$editor_settings = get_block_editor_settings( $editor_settings, $block_editor_context );", before: false },
    "block-editor": { path: "/wordpress/wp-admin/post-new.php", marker: "require_once ABSPATH . 'wp-admin/admin-footer.php';", before: true },
  }
  const stop = stops[phase]
  let source = new TextDecoder().decode(php.readFileAsBuffer(stop.path))
  if (phase === "before-rest-preload-skip-global-styles") {
    const lookup = "WP_Theme_JSON_Resolver::get_user_global_styles_post_id()"
    if (source.split(lookup).length - 1 !== 2) throw new Error("WordPress global styles lookup count changed.")
    source = source.replaceAll(lookup, "0")
  }
  const index = source.indexOf(stop.marker)
  if (index === -1 || index !== source.lastIndexOf(stop.marker)) throw new Error(`WordPress editor memory marker is not unique: ${phase}`)
  const insertion = stop.before ? index : index + stop.marker.length
  const output = `\necho wp_json_encode( array( 'schema' => 'wp-codebox/cloudflare-editor-memory/v1', 'phase' => '${phase}', 'memoryBytes' => memory_get_usage( true ), 'peakMemoryBytes' => memory_get_peak_usage( true ) ) ); exit;\n`
  php.writeFile(stop.path, new TextEncoder().encode(`${source.slice(0, insertion)}${output}${source.slice(insertion)}`))
}

interface MarkdownManifestFile {
  path: string
  objectKey: string
  sha256: string
  size: number
}

interface MarkdownManifest extends MarkdownPointer {
  files: MarkdownManifestFile[]
}

interface RuntimeFile {
  path: string
  bytes: Uint8Array
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

async function secretsMatch(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [leftHash, rightHash] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))])
  const leftBytes = new Uint8Array(leftHash)
  const rightBytes = new Uint8Array(rightHash)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index++) difference |= leftBytes[index] ^ rightBytes[index]
  return difference === 0
}

async function runCoordinatedWordPressRequest(request: Request, env: Env, coordinator: DurableObjectStub, route: "wordpress" | "health" | "r2-mutate" | "canonical-auth"): Promise<Response> {
  if (route === "r2-mutate" && request.method !== "POST") return new Response("WordPress state mutation requires POST.", { status: 405 })
  let lease = await acquireLease(coordinator, request.url)
  let finalized = false
  try {
    if (!lease.pointer) {
      const bootstrapped = await bootstrapCanonicalRuntime(env, coordinator, request.url, lease)
      // Bootstrap promotion consumes its lease before login or any other request observes it.
      lease = await acquireLease(coordinator, request.url)
      if (!lease.pointer || lease.pointer.revision !== bootstrapped.pointer.revision) throw new Error("Canonical bootstrap promotion was not observed by its next lease.")
      cacheRuntime(lease.pointer, bootstrapped)
    }
    const runtime = await getRuntime(env, lease.pointer, new URL(request.url).origin)
    let response: Response
    let canonicalChanges: MarkdownChanges | undefined
    if (route === "r2-mutate") {
      const mutation = await runSyntheticMutation(runtime)
      response = mutation.response
      canonicalChanges = mutation.canonicalChanges
    } else if (route === "health") {
      response = await health(runtime)
    } else if (route === "canonical-auth") {
      response = await canonicalAuthProbe(runtime, request)
    } else {
      if (isMutation(request, route)) runtime.php.writeFile(MARKDOWN_CHANGES_PATH, new TextEncoder().encode(JSON.stringify({ created: [], changed: [], deleted: [] })))
      response = toFetchResponse(request, await runtime.requestHandler.request(await toPHPRequest(request)))
      if (isMutation(request, route)) canonicalChanges = readCanonicalChanges(runtime.php)
    }
    if (isMutation(request, route)) {
      if (!canonicalChanges) throw new Error("Canonical mutation completed without an MDI change set.")
      const next = await persistRuntime(env.WORDPRESS_STATE_BUCKET, runtime, canonicalChanges)
      await commitLease(coordinator, request.url, lease, next)
      // The runtime now represents the promoted revision, including login session state.
      runtime.pointer = next
      cacheRuntime(next, runtime)
    } else {
      await releaseLease(coordinator, request.url, lease)
    }
    finalized = true
    return response
  } catch (error) {
    if (!finalized) await abortLease(coordinator, request.url, lease)
    throw error
  }
}

function isMutation(request: Request, route: "wordpress" | "health" | "r2-mutate" | "canonical-auth"): boolean {
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
  return { ...await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, await readMarkdownRevision(bucket, pointer), new Uint8Array(markdownPrimaryBootstrapIndex), origin, authConstants, bucket, true), pointer }
}

async function bootstrapCanonicalRuntime(env: Env, coordinator: DurableObjectStub, requestUrl: string, lease: Lease): Promise<Runtime> {
  if (!env.WORDPRESS_ADMIN_PASSWORD) throw new Error("WORDPRESS_ADMIN_PASSWORD is required to bootstrap a complete canonical WordPress revision.")
  const origin = new URL(requestUrl).origin
  const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, await packagedCanonicalMarkdownSeed(), new Uint8Array(markdownPrimaryBootstrapIndex), origin, await canonicalWordPressAuthConstants(env), env.WORDPRESS_STATE_BUCKET, true)
  try {
    const passwordFile = "/tmp/wordpress-admin-password"
    runtime.php.writeFile(passwordFile, new TextEncoder().encode(env.WORDPRESS_ADMIN_PASSWORD))
    const output = (await runtime.php.run({ code: canonicalBootstrapSetupCode(passwordFile, origin) })).text.trim()
    if (output !== "flushed") throw new Error("MDI did not confirm canonical bootstrap flush.")
    const pointer = await persistMarkdownRevision(env.WORDPRESS_STATE_BUCKET, collectRuntimeFiles(runtime.php, MARKDOWN_ROOT))
    await commitLease(coordinator, requestUrl, lease, pointer)
    return { ...runtime, pointer }
  } catch (error) {
    runtime.php.exit()
    throw error
  }
}

async function canonicalWordPressAuthConstants(env: Env): Promise<Record<WordPressAuthConstant, string>> {
  return deriveWordPressAuthConstants(env.WORDPRESS_AUTH_SECRET ?? "", "default")
}

async function persistRuntime(bucket: R2Bucket, runtime: Runtime, changes: MarkdownChanges): Promise<MarkdownPointer> {
  validateMarkdownChanges(changes)
  const changedPaths = [...changes.created, ...changes.changed].sort((left, right) => left.localeCompare(right))
  return persistMarkdownRevision(bucket, collectRuntimeFiles(runtime.php, MARKDOWN_ROOT, changedPaths), runtime.pointer, changes)
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

async function canonicalAuthProbe(runtime: Runtime, request: Request): Promise<Response> {
  const cookiePath = "/tmp/wp-codebox-canonical-auth-cookie"
  runtime.php.writeFile(cookiePath, new TextEncoder().encode(request.headers.get("cookie") ?? ""))
  const output = (await runtime.php.run({ code: `<?php
$raw = file_get_contents('${cookiePath}');
@unlink('${cookiePath}');
foreach (explode(';', is_string($raw) ? $raw : '') as $part) {
  $pair = explode('=', trim($part), 2);
  if (count($pair) === 2 && $pair[0] !== '') $_COOKIE[$pair[0]] = urldecode($pair[1]);
}
require '/wordpress/wp-load.php';
$parsed = wp_parse_auth_cookie('', 'logged_in');
$admin_parsed = wp_parse_auth_cookie('', 'auth');
$user = is_array($parsed) && isset($parsed['username']) ? get_user_by('login', $parsed['username']) : false;
$token = is_array($parsed) && isset($parsed['token']) ? $parsed['token'] : '';
$session = $user && is_string($token) && $token !== '' ? WP_Session_Tokens::get_instance($user->ID) : null;
$session_row = $user ? $GLOBALS['wpdb']->get_var($GLOBALS['wpdb']->prepare("SELECT meta_value FROM {$GLOBALS['wpdb']->usermeta} WHERE user_id = %d AND meta_key LIKE %s", $user->ID, '%session_tokens')) : null;
$session_value = is_string($session_row) ? maybe_unserialize($session_row) : null;
$auth_constants = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
echo json_encode([
  'schema' => 'wp-codebox/cloudflare-canonical-auth/v1',
  'authCookiePresent' => isset($_COOKIE[LOGGED_IN_COOKIE]),
  'authCookieParsed' => is_array($parsed) && isset($parsed['username'], $parsed['expiration'], $parsed['token'], $parsed['hmac']),
  'adminCookiePresent' => isset($_COOKIE[AUTH_COOKIE]),
  'adminCookieParsed' => is_array($admin_parsed) && isset($admin_parsed['username'], $admin_parsed['expiration'], $admin_parsed['token'], $admin_parsed['hmac']),
  'userFound' => false !== $user,
  'sessionTokenRowPresent' => is_string($session_row) && $session_row !== '',
  'sessionTokenSerializedArray' => is_array($session_value),
  'sessionTokenVerified' => $session instanceof WP_Session_Tokens && is_string($token) && $token !== '' && $session->verify($token),
  'authConstantsDefined' => !array_diff($auth_constants, array_filter($auth_constants, 'defined')),
  'adminCookieValidated' => false !== wp_validate_auth_cookie('', 'auth'),
  'loggedInCookieValidated' => false !== wp_validate_auth_cookie('', 'logged_in'),
]);` })).text.trim()
  return Response.json(JSON.parse(output) as Record<string, boolean | string>)
}

async function canonicalSessionProbe(bucket: R2Bucket, state: { pointer: MarkdownPointer | null }): Promise<Response> {
  if (!state.pointer) return Response.json({ schema: "wp-codebox/cloudflare-canonical-session/v1", pointerRevision: null, sessionTokenRows: 0 })
  const manifest = await readMarkdownManifest(bucket, state.pointer)
  const users = manifest?.files.find((file) => file.path === "_tables/users.json")
  const usermeta = manifest?.files.find((file) => file.path === "_tables/usermeta.json")
  if (!users || !usermeta) throw new Error("The canonical WordPress revision is missing users or usermeta.")
  const usersObject = await bucket.get(users.objectKey)
  const object = await bucket.get(usermeta.objectKey)
  if (!usersObject || !object) throw new Error("The canonical WordPress user identity objects are missing.")
  const usersRows = await usersObject.json<Array<{ ID?: unknown; user_login?: unknown; user_pass?: unknown }>>()
  const rows = await object.json<Array<{ meta_key?: string; meta_value?: unknown }>>()
  const usermetaKeys = rows.map((row) => row.meta_key).filter((key): key is string => typeof key === "string").sort()
  const sessionTokenRows = rows.filter((row) => row.meta_key?.endsWith("session_tokens"))
  const adminRow = usersRows.find((row) => typeof row.user_login === "string")
  return Response.json({ schema: "wp-codebox/cloudflare-canonical-session/v1", pointerRevision: state.pointer.revision, sessionTokenRows: sessionTokenRows.length, hasSessionTokens: sessionTokenRows.some((row) => typeof row.meta_value === "string" && row.meta_value.length > 0), usersTableStructurallyValid: !!adminRow && (typeof adminRow.ID === "number" || (typeof adminRow.ID === "string" && /^\d+$/.test(adminRow.ID))) && typeof adminRow.user_pass === "string", usersTableFieldTypes: { id: typeof adminRow?.ID, login: typeof adminRow?.user_login, password: typeof adminRow?.user_pass }, usermetaTableStructurallyValid: rows.every((row) => typeof row.meta_key === "string" && typeof row.meta_value === "string"), usermetaKeys })
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
  return path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..")
}

async function readMarkdownRevision(bucket: R2Bucket, pointer: MarkdownPointer): Promise<RuntimeFile[]> {
  const manifestObject = await bucket.get(pointer.manifestKey)
  if (!manifestObject) throw new Error(`R2 Markdown manifest is missing: ${pointer.manifestKey}`)
  const manifest = await manifestObject.json<MarkdownManifest>()
  return Promise.all(manifest.files.map(async (file): Promise<RuntimeFile> => {
    const object = await bucket.get(file.objectKey)
    if (!object) throw new Error(`R2 Markdown object is missing: ${file.objectKey}`)
    return { path: file.path, bytes: new Uint8Array(await object.arrayBuffer()) }
  }))
}

async function persistMarkdownRevision(bucket: R2Bucket, files: RuntimeFile[], current?: MarkdownPointer, changes?: MarkdownChanges): Promise<MarkdownPointer> {
  const currentManifest = current ? await readMarkdownManifest(bucket, current) : null
  if (current && !currentManifest) throw new Error(`R2 Markdown manifest is missing: ${current.manifestKey}`)
  if (current && currentManifest && changes) {
    validateMarkdownChanges(changes)
    if (!changes.created.length && !changes.changed.length && !changes.deleted.length) return current
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
    return persistMarkdownManifest(bucket, [...manifestFiles.values()].sort((left, right) => left.path.localeCompare(right.path)))
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
    if (JSON.stringify(currentManifest.files) === JSON.stringify(manifestFiles)) return current
  }

  return persistMarkdownManifest(bucket, manifestFiles)
}

async function persistMarkdownManifest(bucket: R2Bucket, files: MarkdownManifestFile[]): Promise<MarkdownPointer> {
  const revision = crypto.randomUUID()
  const manifestKey = `${R2_MARKDOWN_REVISION_PREFIX}/${revision}.json`
  const persistedAt = new Date().toISOString()
  const pointer: MarkdownPointer = { revision, manifestKey, persistedAt }
  const manifest: MarkdownManifest = { ...pointer, files }
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
      materializeRuntimeFiles(php, MARKDOWN_ROOT, await packagedCanonicalMarkdownSeed())
      const evidence = (await php.run({
        code: "<?php echo json_encode(['dropin' => file_exists('/wordpress/wp-content/db.php'), 'storage' => file_exists('/wordpress/wp-content/plugins/markdown-database-integration/inc/class-wp-markdown-storage.php'), 'siteurl' => file_exists('/wordpress/wp-content/markdown/_options/siteurl.json')]);",
      })).text.trim()
      return probeResponse(phase, { ...wordpress, ...JSON.parse(evidence) as Record<string, string> })
    } finally {
      php.exit()
    }
  }

  if (phase === "mdi-shortinit") {
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, await packagedCanonicalMarkdownSeed(), new Uint8Array(markdownPrimaryBootstrapIndex), SITE_URL, {}, bucket)
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
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, await packagedCanonicalMarkdownSeed(), new Uint8Array(markdownPrimaryBootstrapIndex), SITE_URL, {}, bucket)
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

  if (["mdi-includes", "mdi-embed", "mdi-textdomain", "mdi-ai-client", "mdi-plugin-constants", "mdi-muplugins", "mdi-plugins", "mdi-globals", "mdi-theme", "mdi-site-health-class", "mdi-site-health", "mdi-current-user", "mdi-init", "mdi-wp-loaded", "mdi-init-callbacks", "mdi-init-exclude-scheduling", "mdi-init-exclude-wp-cron", "mdi-init-exclude-privacy-schedule", "mdi-init-exclude-update-schedule", "mdi-init-exclude-wp-cron-privacy-schedule", "mdi-init-exclude-wp-cron-update-schedule", "mdi-init-exclude-privacy-update-schedule", "mdi-init-exclude-block-registration", "mdi-init-exclude-theme-patterns-styles", "mdi-init-exclude-widgets", "mdi-init-exclude-rest-connectors-sitemaps", "mdi-init-exclude-initial-content-types", "mdi-widgets-callbacks", "mdi-widgets-constructors", "mdi-widgets-hooks", "mdi-widgets-factory", "mdi-widgets-remaining-hooks", "mdi-widgets-direct-basic-classic-first", "mdi-widgets-direct-basic-classic-first-pages", "mdi-widgets-direct-basic-classic-first-calendar", "mdi-widgets-direct-basic-classic-first-archives", "mdi-widgets-direct-basic-classic-first-meta", "mdi-widgets-direct-basic-classic-first-search", "mdi-widgets-direct-basic-classic-first-text", "mdi-widgets-direct-basic-classic-second", "mdi-widgets-direct-media", "mdi-widgets-direct-custom-html-block", "mdi-widgets-direct-block", "mdi-widgets-direct-custom-html", "mdi-widgets-direct-factory-all", "mdi-widgets-option-reads", "mdi-widgets-get-settings", "mdi-widgets-get-settings-first", "mdi-widgets-get-settings-second", "mdi-widgets-register-one"].includes(phase)) {
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, await packagedCanonicalMarkdownSeed(), new Uint8Array(markdownPrimaryBootstrapIndex), SITE_URL, {}, bucket)
    try {
      const evidence = (await runtime.php.run({ code: wordpressProbeCode(phase) })).text.trim()
      return probeResponse(phase, JSON.parse(evidence) as Record<string, string>)
    } finally {
      runtime.php.exit()
    }
  }

  if (phase === "cwr" || phase === "cwc" || phase === "cwp" || phase === "cwcron" || phase === "cwu" || canonicalLifecyclePhaseAliases[phase] || ["canonical-current-user", "canonical-init", "canonical-site-status", "canonical-wp-loaded", "canonical-wp-loaded-callbacks", "canonical-wp-loaded-exclude-rewrite-flush", "canonical-wp-loaded-exclude-core-template-header", "canonical-wp-loaded-exclude-playground", "canonical-wp-loaded-exclude-wp-cron", "canonical-wp-loaded-exclude-all", "canonical-wp-loaded-suppress-rewrite-persist"].includes(phase)) {
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, await packagedCanonicalMarkdownSeed(), new Uint8Array(markdownPrimaryBootstrapIndex), "https://canonical-probe.invalid", {}, bucket, true)
    try {
      const evidence = (await runtime.php.run({ code: canonicalLifecycleProbeCode(phase) })).text.trim()
      return probeResponse(phase, JSON.parse(evidence) as Record<string, boolean | number | string>)
    } finally {
      runtime.php.exit()
    }
  }

  if (phase === "canonical-wordpress" || phase === "canonical-bootstrap-setup") {
    const canonicalSeed = await packagedCanonicalMarkdownSeed()
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, canonicalSeed, new Uint8Array(markdownPrimaryBootstrapIndex), "https://canonical-probe.invalid", {}, bucket, true)
    try {
      if (phase === "canonical-bootstrap-setup") {
        const passwordFile = "/tmp/wp-codebox-canonical-bootstrap-probe-password"
        runtime.php.writeFile(passwordFile, new TextEncoder().encode("probe-only-password"))
        const output = (await runtime.php.run({ code: canonicalBootstrapSetupCode(passwordFile, "https://canonical-probe.invalid") })).text.trim()
        if (output !== "flushed") throw new Error("Canonical bootstrap setup probe did not confirm its ephemeral flush.")
        const changes = canonicalChangedPathCounts(canonicalSeed, collectRuntimeFiles(runtime.php, MARKDOWN_ROOT))
        return probeResponse(phase, { wordpressVersion: runtime.wordpressVersion, canonicalSeedFiles: canonicalSeed.length, ...changes })
      }
      const evidence = (await runtime.php.run({ code: `<?php
require '/wordpress/wp-load.php';
echo json_encode([
  'wordpressVersion' => get_bloginfo('version'),
  'postCount' => (int) $wpdb->get_var("SELECT COUNT(*) FROM {\$wpdb->posts}"),
  'pageCount' => (int) $wpdb->get_var("SELECT COUNT(*) FROM {\$wpdb->posts} WHERE post_type = 'page'"),
  'userCount' => (int) $wpdb->get_var("SELECT COUNT(*) FROM {\$wpdb->users}"),
  'optionCount' => (int) $wpdb->get_var("SELECT COUNT(*) FROM {\$wpdb->options}"),
  'widgetOptionCount' => (int) $wpdb->get_var("SELECT COUNT(*) FROM {\$wpdb->options} WHERE option_name LIKE 'widget\\_%'"),
  'widgetStateOptionCount' => (int) $wpdb->get_var("SELECT COUNT(*) FROM {\$wpdb->options} WHERE option_name LIKE 'widget\\_%' OR option_name = 'sidebars_widgets'"),
  'wpCronInitAttached' => false !== has_action('init', 'wp_cron'),
  'updateScheduleInitAttached' => false !== has_action('init', 'wp_schedule_update_checks'),
  'privacyScheduleInitAttached' => false !== has_action('init', 'wp_schedule_delete_old_privacy_export_files'),
  'memoryBytes' => memory_get_usage(true),
  'peakMemoryBytes' => memory_get_peak_usage(true),
]);` })).text.trim()
      return probeResponse(phase, { canonicalSeedFiles: canonicalSeed.length, ...JSON.parse(evidence) as Record<string, number | string> })
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

  const widgetPhases = ["mdi-widgets-callbacks", "mdi-widgets-constructors", "mdi-widgets-hooks", "mdi-widgets-factory", "mdi-widgets-remaining-hooks", "mdi-widgets-direct-basic-classic-first", "mdi-widgets-direct-basic-classic-first-pages", "mdi-widgets-direct-basic-classic-first-calendar", "mdi-widgets-direct-basic-classic-first-archives", "mdi-widgets-direct-basic-classic-first-meta", "mdi-widgets-direct-basic-classic-first-search", "mdi-widgets-direct-basic-classic-first-text", "mdi-widgets-direct-basic-classic-second", "mdi-widgets-direct-media", "mdi-widgets-direct-custom-html-block", "mdi-widgets-direct-block", "mdi-widgets-direct-custom-html", "mdi-widgets-direct-factory-all", "mdi-widgets-option-reads", "mdi-widgets-get-settings", "mdi-widgets-get-settings-first", "mdi-widgets-get-settings-second", "mdi-widgets-register-one"]
  if (widgetPhases.includes(phase)) {
    return `<?php
$settings_path = '/wordpress/wp-settings.php';
$settings = file_get_contents($settings_path);
$needle = "do_action( 'init' );";
if (substr_count($settings, $needle) !== 1) {
    throw new Exception('WordPress widget probe needle was not uniquely found.');
}
$phase = ${JSON.stringify(phase)};
$probe = <<<'PHP'
function wp_codebox_widgets_probe_callback_identifier($callback) {
    if (is_string($callback)) return $callback;
    if ($callback instanceof Closure) return 'Closure';
    if (is_array($callback) && count($callback) === 2 && is_string($callback[1])) {
        $class = is_object($callback[0]) ? get_class($callback[0]) : $callback[0];
        return is_string($class) ? $class . '::' . $callback[1] : 'Closure';
    }
    if (is_object($callback) && method_exists($callback, '__invoke')) return get_class($callback) . '::__invoke';
    return 'Closure';
}
function wp_codebox_widgets_probe_inventory($hook_name) {
    $inventory = array();
    $hook = isset($GLOBALS['wp_filter'][$hook_name]) ? $GLOBALS['wp_filter'][$hook_name] : null;
    if (!$hook || !isset($hook->callbacks) || !is_array($hook->callbacks)) return $inventory;
    foreach ($hook->callbacks as $priority => $callbacks) {
        $identifiers = array();
        foreach ($callbacks as $registered) $identifiers[] = wp_codebox_widgets_probe_callback_identifier($registered['function']);
        sort($identifiers, SORT_STRING);
        $inventory[(string) $priority] = $identifiers;
    }
    ksort($inventory, SORT_NUMERIC);
    return $inventory;
}
function wp_codebox_widgets_probe_remove_callbacks($hook_name, $identifiers, $retain) {
    $removed = array();
    $hook = isset($GLOBALS['wp_filter'][$hook_name]) ? $GLOBALS['wp_filter'][$hook_name] : null;
    if (!$hook || !isset($hook->callbacks) || !is_array($hook->callbacks)) return $removed;
    $callbacks_by_priority = $hook->callbacks;
    foreach ($callbacks_by_priority as $priority => $callbacks) {
        foreach ($callbacks as $registered) {
            if (!isset($registered['function'])) continue;
            $identifier = wp_codebox_widgets_probe_callback_identifier($registered['function']);
            if (in_array($identifier, $identifiers, true) !== $retain) {
                if (remove_action($hook_name, $registered['function'], (int) $priority)) $removed[] = $identifier;
            }
        }
    }
    sort($removed, SORT_STRING);
    return $removed;
}
function wp_codebox_widgets_probe_register_defaults() {
    if (!is_blog_installed()) return;
    register_widget('WP_Widget_Pages');
    register_widget('WP_Widget_Calendar');
    register_widget('WP_Widget_Archives');
    if (get_option('link_manager_enabled')) register_widget('WP_Widget_Links');
    register_widget('WP_Widget_Media_Audio');
    register_widget('WP_Widget_Media_Image');
    register_widget('WP_Widget_Media_Gallery');
    register_widget('WP_Widget_Media_Video');
    register_widget('WP_Widget_Meta');
    register_widget('WP_Widget_Search');
    register_widget('WP_Widget_Text');
    register_widget('WP_Widget_Categories');
    register_widget('WP_Widget_Recent_Posts');
    register_widget('WP_Widget_Recent_Comments');
    register_widget('WP_Widget_RSS');
    register_widget('WP_Widget_Tag_Cloud');
    register_widget('WP_Nav_Menu_Widget');
    register_widget('WP_Widget_Custom_HTML');
    register_widget('WP_Widget_Block');
}
function wp_codebox_widgets_probe_register_selected($class_names) {
    $registered = isset($GLOBALS['wp_widget_factory']->widgets) && is_array($GLOBALS['wp_widget_factory']->widgets) ? $GLOBALS['wp_widget_factory']->widgets : array();
    foreach ($class_names as $class_name) {
        if (!isset($registered[$class_name])) throw new Exception('Widget probe class was not registered: ' . $class_name);
        $registered[$class_name]->_register();
    }
}
function wp_codebox_widgets_probe_array_dimensions($value) {
    if (!is_array($value)) return 0;
    $dimensions = 1;
    foreach ($value as $item) $dimensions = max($dimensions, 1 + wp_codebox_widgets_probe_array_dimensions($item));
    return $dimensions;
}
function wp_codebox_widgets_probe_get_settings($class_names) {
    $registered = isset($GLOBALS['wp_widget_factory']->widgets) && is_array($GLOBALS['wp_widget_factory']->widgets) ? $GLOBALS['wp_widget_factory']->widgets : array();
    $completed = array();
    $settings_shapes = array();
    foreach ($class_names as $class_name) {
        if (!isset($registered[$class_name])) throw new Exception('Widget probe class was not registered: ' . $class_name);
        $settings = $registered[$class_name]->get_settings();
        $completed[] = $class_name;
        $settings_shapes[$class_name] = array('arrayLike' => is_array($settings), 'dimensions' => wp_codebox_widgets_probe_array_dimensions($settings));
    }
    return array('completedClassNames' => $completed, 'settingsShapes' => $settings_shapes);
}
$direct_groups = array(
    'mdi-widgets-direct-basic-classic-first' => array('WP_Widget_Pages', 'WP_Widget_Calendar', 'WP_Widget_Archives', 'WP_Widget_Meta', 'WP_Widget_Search', 'WP_Widget_Text'),
    'mdi-widgets-direct-basic-classic-first-pages' => array('WP_Widget_Pages'),
    'mdi-widgets-direct-basic-classic-first-calendar' => array('WP_Widget_Calendar'),
    'mdi-widgets-direct-basic-classic-first-archives' => array('WP_Widget_Archives'),
    'mdi-widgets-direct-basic-classic-first-meta' => array('WP_Widget_Meta'),
    'mdi-widgets-direct-basic-classic-first-search' => array('WP_Widget_Search'),
    'mdi-widgets-direct-basic-classic-first-text' => array('WP_Widget_Text'),
    'mdi-widgets-direct-basic-classic-second' => array('WP_Widget_Categories', 'WP_Widget_Recent_Posts', 'WP_Widget_Recent_Comments', 'WP_Widget_RSS', 'WP_Widget_Tag_Cloud', 'WP_Nav_Menu_Widget'),
    'mdi-widgets-direct-media' => array('WP_Widget_Media_Audio', 'WP_Widget_Media_Image', 'WP_Widget_Media_Gallery', 'WP_Widget_Media_Video'),
    'mdi-widgets-direct-custom-html-block' => array('WP_Widget_Custom_HTML', 'WP_Widget_Block'),
    'mdi-widgets-direct-block' => array('WP_Widget_Block'),
    'mdi-widgets-direct-custom-html' => array('WP_Widget_Custom_HTML'),
    'mdi-widgets-direct-factory-all' => array('WP_Widget_Pages', 'WP_Widget_Calendar', 'WP_Widget_Archives', 'WP_Widget_Media_Audio', 'WP_Widget_Media_Image', 'WP_Widget_Media_Gallery', 'WP_Widget_Media_Video', 'WP_Widget_Meta', 'WP_Widget_Search', 'WP_Widget_Text', 'WP_Widget_Categories', 'WP_Widget_Recent_Posts', 'WP_Widget_Recent_Comments', 'WP_Widget_RSS', 'WP_Widget_Tag_Cloud', 'WP_Nav_Menu_Widget', 'WP_Widget_Custom_HTML', 'WP_Widget_Block'),
);
$widget_option_id_bases = array('archives', 'block', 'calendar', 'categories', 'custom_html', 'links', 'media_audio', 'media_gallery', 'media_image', 'media_video', 'meta', 'nav_menu', 'pages', 'recent-comments', 'recent-posts', 'rss', 'search', 'tag_cloud', 'text');
$widget_classes = array('WP_Widget_Pages', 'WP_Widget_Calendar', 'WP_Widget_Archives', 'WP_Widget_Media_Audio', 'WP_Widget_Media_Image', 'WP_Widget_Media_Gallery', 'WP_Widget_Media_Video', 'WP_Widget_Meta', 'WP_Widget_Search', 'WP_Widget_Text', 'WP_Widget_Categories', 'WP_Widget_Recent_Posts', 'WP_Widget_Recent_Comments', 'WP_Widget_RSS', 'WP_Widget_Tag_Cloud', 'WP_Nav_Menu_Widget', 'WP_Widget_Custom_HTML', 'WP_Widget_Block');
$get_settings_groups = array(
    'mdi-widgets-get-settings' => $widget_classes,
    'mdi-widgets-get-settings-first' => array_slice($widget_classes, 0, 10),
    'mdi-widgets-get-settings-second' => array_slice($widget_classes, 10),
);
if ($phase === 'mdi-widgets-callbacks') {
    echo json_encode(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => $phase, 'callbacks' => wp_codebox_widgets_probe_inventory('widgets_init'), 'memoryBytes' => memory_get_usage(true), 'peakMemoryBytes' => memory_get_peak_usage(true)));
    return;
}
$removed_init = wp_codebox_widgets_probe_remove_callbacks('init', array('wp_widgets_init'), false);
$memory_before = memory_get_usage(true);
if ($phase === 'mdi-widgets-option-reads') {
    $get_option_found = array();
    $get_option_missing = array();
    $sqlite_present = array();
    $sqlite_missing = array();
    foreach ($widget_option_id_bases as $id_base) {
        $option_name = 'widget_' . $id_base;
        if (get_option($option_name, false) === false) $get_option_missing[] = $option_name;
        else $get_option_found[] = $option_name;
        $row_present = $wpdb->get_var($wpdb->prepare("SELECT 1 FROM {$wpdb->options} WHERE option_name = %s LIMIT 1", $option_name));
        if ($row_present === '1') $sqlite_present[] = $option_name;
        else $sqlite_missing[] = $option_name;
    }
    echo json_encode(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => $phase, 'completed' => true, 'getOption' => array('found' => $get_option_found, 'missing' => $get_option_missing), 'sqliteRows' => array('present' => $sqlite_present, 'missing' => $sqlite_missing), 'memoryBeforeBytes' => $memory_before, 'memoryBytes' => memory_get_usage(true), 'peakMemoryBytes' => memory_get_peak_usage(true)));
    return;
}
$removed_widgets = array();
wp_codebox_widgets_probe_register_defaults();
if (isset($get_settings_groups[$phase])) {
    $settings_probe = wp_codebox_widgets_probe_get_settings($get_settings_groups[$phase]);
    echo json_encode(array_merge(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => $phase, 'completed' => true), $settings_probe));
    return;
}
if ($phase === 'mdi-widgets-register-one') {
    $class_name = 'WP_Widget_Text';
    $option_name = 'widget_text';
    $instance_number = 2;
    if (!isset($GLOBALS['wp_widget_factory']->widgets[$class_name])) throw new Exception('Widget probe class was not registered: ' . $class_name);
    update_option($option_name, array($instance_number => array('title' => 'Widget probe')));
    $widget = $GLOBALS['wp_widget_factory']->widgets[$class_name];
    $settings = $widget->get_settings();
    $widget->_register_one($instance_number);
    echo json_encode(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => $phase, 'completed' => true, 'widgetClassName' => $class_name, 'preloadedOptionName' => $option_name, 'getSettingsShape' => array('arrayLike' => is_array($settings), 'dimensions' => wp_codebox_widgets_probe_array_dimensions($settings)), 'registerOneCompleted' => true));
    return;
}
if (isset($direct_groups[$phase])) {
    $removed_widgets = wp_codebox_widgets_probe_remove_callbacks('widgets_init', array(), true);
    wp_codebox_widgets_probe_register_selected($direct_groups[$phase]);
    echo json_encode(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => $phase, 'completed' => true, 'removedInitCallbacks' => $removed_init, 'removedWidgetsCallbacks' => $removed_widgets, 'classNamesAttempted' => $direct_groups[$phase], 'classCount' => count($direct_groups[$phase]), 'memoryBeforeBytes' => $memory_before, 'memoryBytes' => memory_get_usage(true), 'peakMemoryBytes' => memory_get_peak_usage(true)));
    return;
} elseif ($phase === 'mdi-widgets-hooks') {
    do_action('widgets_init');
} elseif ($phase === 'mdi-widgets-factory') {
    $removed_widgets = wp_codebox_widgets_probe_remove_callbacks('widgets_init', array('WP_Widget_Factory::_register_widgets'), true);
    do_action('widgets_init');
} elseif ($phase === 'mdi-widgets-remaining-hooks') {
    $removed_widgets = wp_codebox_widgets_probe_remove_callbacks('widgets_init', array('WP_Widget_Factory::_register_widgets'), false);
    do_action('widgets_init');
}
$widget_class_count = isset($GLOBALS['wp_widget_factory']->widgets) && is_array($GLOBALS['wp_widget_factory']->widgets) ? count($GLOBALS['wp_widget_factory']->widgets) : 0;
echo json_encode(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => $phase, 'completed' => true, 'removedInitCallbacks' => $removed_init, 'removedWidgetsCallbacks' => $removed_widgets, 'widgetClassCount' => $widget_class_count, 'memoryBeforeBytes' => $memory_before, 'memoryBytes' => memory_get_usage(true), 'peakMemoryBytes' => memory_get_peak_usage(true)));
return;
PHP;
file_put_contents($settings_path, str_replace($needle, $probe, $settings));
require '/wordpress/wp-load.php';`
  }

  const initExclusions: Record<string, string[]> = {
    "mdi-init-exclude-scheduling": [
      "wp_schedule_update_checks",
      "wp_schedule_delete_old_privacy_export_files",
      "wp_cron",
      "WP_Site_Health::schedule_cron",
      "wp_schedule_site_health_cron",
      "WP_Site_Health::maybe_create_scheduled_event",
    ],
    "mdi-init-exclude-wp-cron": ["wp_cron"],
    "mdi-init-exclude-privacy-schedule": ["wp_schedule_delete_old_privacy_export_files"],
    "mdi-init-exclude-update-schedule": ["wp_schedule_update_checks"],
    "mdi-init-exclude-wp-cron-privacy-schedule": ["wp_cron", "wp_schedule_delete_old_privacy_export_files"],
    "mdi-init-exclude-wp-cron-update-schedule": ["wp_cron", "wp_schedule_update_checks"],
    "mdi-init-exclude-privacy-update-schedule": ["wp_schedule_delete_old_privacy_export_files", "wp_schedule_update_checks"],
    "mdi-init-exclude-block-registration": [
      "register_block_core_*",
      "register_core_block_*",
      "register_core_block_types_from_metadata",
      "register_core_block_style_handles",
      "wp_register_core_block_style_handles",
      "WP_Block_Supports::init",
    ],
    "mdi-init-exclude-theme-patterns-styles": [
      "_register_theme_block_patterns",
      "_register_theme_block_pattern_categories",
      "_register_core_block_patterns_and_categories",
      "wp_register_global_styles",
      "wp_register_global_styles_custom_css",
      "wp_register_typography_support",
    ],
    "mdi-init-exclude-widgets": ["wp_widgets_init"],
    "mdi-init-exclude-rest-connectors-sitemaps": [
      "rest_api_init",
      "wp_sitemaps_get_server",
      "WP_Sitemaps::init",
      "WP_Sitemaps_Registry::init",
    ],
    "mdi-init-exclude-initial-content-types": [
      "create_initial_taxonomies",
      "create_initial_post_types",
      "create_initial_post_statuses",
      "wp_create_initial_post_meta",
    ],
  }
  if (phase === "mdi-init-callbacks" || initExclusions[phase]) {
    const excluded = initExclusions[phase] ?? []
    return `<?php
$settings_path = '/wordpress/wp-settings.php';
$settings = file_get_contents($settings_path);
$needle = "do_action( 'init' );";
if (substr_count($settings, $needle) !== 1) {
    throw new Exception('WordPress init probe needle was not uniquely found.');
}
$phase = ${JSON.stringify(phase)};
$excluded = ${JSON.stringify(excluded)};
$probe = <<<'PHP'
function wp_codebox_init_probe_callback_identifier($callback) {
    if (is_string($callback)) return $callback;
    if ($callback instanceof Closure) return 'Closure';
    if (is_array($callback) && count($callback) === 2 && is_string($callback[1])) {
        $class = is_object($callback[0]) ? get_class($callback[0]) : $callback[0];
        return is_string($class) ? $class . '::' . $callback[1] : 'Closure';
    }
    if (is_object($callback) && method_exists($callback, '__invoke')) return get_class($callback) . '::__invoke';
    return 'Closure';
}
function wp_codebox_init_probe_inventory() {
    $inventory = array();
    $hook = isset($GLOBALS['wp_filter']['init']) ? $GLOBALS['wp_filter']['init'] : null;
    if (!$hook || !isset($hook->callbacks) || !is_array($hook->callbacks)) return $inventory;
    foreach ($hook->callbacks as $priority => $callbacks) {
        $identifiers = array();
        foreach ($callbacks as $registered) $identifiers[] = wp_codebox_init_probe_callback_identifier($registered['function']);
        sort($identifiers, SORT_STRING);
        $inventory[(string) $priority] = $identifiers;
    }
    ksort($inventory, SORT_NUMERIC);
    return $inventory;
}
function wp_codebox_init_probe_matches($identifier, $patterns) {
    foreach ($patterns as $pattern) {
        if (str_ends_with($pattern, '*') && str_starts_with($identifier, substr($pattern, 0, -1))) return true;
        if ($identifier === $pattern) return true;
    }
    return false;
}
$inventory = wp_codebox_init_probe_inventory();
if ($phase === 'mdi-init-callbacks') {
    echo json_encode(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => $phase, 'callbacks' => $inventory, 'memoryBytes' => memory_get_usage(true), 'peakMemoryBytes' => memory_get_peak_usage(true)));
    return;
}
$removed = array();
$hook = isset($GLOBALS['wp_filter']['init']) ? $GLOBALS['wp_filter']['init'] : null;
if ($hook && isset($hook->callbacks) && is_array($hook->callbacks)) {
    $callbacks_by_priority = $hook->callbacks;
    foreach ($callbacks_by_priority as $priority => $callbacks) {
        foreach ($callbacks as $registered) {
            if (!isset($registered['function'])) continue;
            $identifier = wp_codebox_init_probe_callback_identifier($registered['function']);
            if (wp_codebox_init_probe_matches($identifier, $excluded)) {
                if (remove_action('init', $registered['function'], (int) $priority)) $removed[] = $identifier;
            }
        }
    }
}
sort($removed, SORT_STRING);
$memory_before = memory_get_usage(true);
do_action('init');
echo json_encode(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => $phase, 'completed' => true, 'removedCallbacks' => $removed, 'memoryBeforeBytes' => $memory_before, 'memoryBytes' => memory_get_usage(true), 'peakMemoryBytes' => memory_get_peak_usage(true)));
return;
PHP;
file_put_contents($settings_path, str_replace($needle, $probe, $settings));
require '/wordpress/wp-load.php';`
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

const canonicalLifecyclePhaseAliases: Record<string, string> = {
  cwr: "canonical-wp-loaded-exclude-rewrite-flush",
  cwc: "canonical-wp-loaded-exclude-core-template-header",
  cwp: "canonical-wp-loaded-exclude-playground",
  cwcron: "canonical-wp-loaded-exclude-wp-cron",
  cwu: "canonical-wp-loaded-suppress-rewrite-persist",
  "canon-wpl-no-rewrite": "canonical-wp-loaded-exclude-rewrite-flush",
  "canon-wpl-no-core": "canonical-wp-loaded-exclude-core-template-header",
  "canon-wpl-no-playground": "canonical-wp-loaded-exclude-playground",
  "canon-wpl-no-cron": "canonical-wp-loaded-exclude-wp-cron",
}

function canonicalLifecycleProbeCode(phase: string): string {
  const canonicalPhase = canonicalLifecyclePhaseAliases[phase] ?? phase
  const wpLoadedExclusions: Record<string, { identifiers: string[]; retain: boolean }> = {
    "canonical-wp-loaded-exclude-rewrite-flush": { identifiers: ["WP_Rewrite::flush_rules", "playground_maybe_flush_rewrite_rules"], retain: false },
    "canonical-wp-loaded-exclude-core-template-header": { identifiers: ["_add_template_loader_filters", "_custom_header_background_just_in_time", "_custom_logo_header_styles"], retain: false },
    "canonical-wp-loaded-exclude-playground": { identifiers: ["playground_maybe_flush_rewrite_rules", "playground_save_wp_env_info"], retain: false },
    "canonical-wp-loaded-exclude-wp-cron": { identifiers: ["_wp_cron"], retain: false },
    "canonical-wp-loaded-exclude-all": { identifiers: [], retain: true },
    "canonical-wp-loaded-suppress-rewrite-persist": { identifiers: [], retain: false },
  }
  const wpLoadedNeedle = "do_action( 'wp_loaded' );"
  const stops: Record<string, { needle: string; after?: boolean }> = {
    "canonical-current-user": { needle: "// Set up current user." },
    "canonical-init": { needle: "do_action( 'init' );", after: true },
    "canonical-site-status": { needle: "// Check site status." },
    "canonical-wp-loaded": { needle: wpLoadedNeedle, after: true },
    "canonical-wp-loaded-callbacks": { needle: wpLoadedNeedle },
    ...Object.fromEntries(Object.keys(wpLoadedExclusions).map((name) => [name, { needle: wpLoadedNeedle }])),
  }
  const stop = stops[canonicalPhase]
  if (!stop) throw new Error(`Unknown canonical lifecycle probe phase: ${phase}`)

  const wpLoadedProbe = canonicalPhase === "canonical-wp-loaded-callbacks" || wpLoadedExclusions[canonicalPhase]
  const exclusion = wpLoadedExclusions[canonicalPhase]
  const wpLoadedStop = !wpLoadedProbe ? "" : `function wp_codebox_canonical_wp_loaded_callback_identifier($callback) {
    if (is_string($callback)) return $callback;
    if ($callback instanceof Closure) return 'Closure';
    if (is_array($callback) && count($callback) === 2 && is_string($callback[1])) {
        $class = is_object($callback[0]) ? get_class($callback[0]) : $callback[0];
        return is_string($class) ? $class . '::' . $callback[1] : 'Closure';
    }
    if (is_object($callback) && method_exists($callback, '__invoke')) return get_class($callback) . '::__invoke';
    return 'Closure';
}
function wp_codebox_canonical_wp_loaded_inventory() {
    $inventory = array();
    $hook = isset($GLOBALS['wp_filter']['wp_loaded']) ? $GLOBALS['wp_filter']['wp_loaded'] : null;
    if (!$hook || !isset($hook->callbacks) || !is_array($hook->callbacks)) return $inventory;
    $remaining = 100;
    foreach ($hook->callbacks as $priority => $callbacks) {
        if (0 === $remaining) break;
        $identifiers = array();
        foreach ($callbacks as $registered) if (isset($registered['function'])) $identifiers[] = wp_codebox_canonical_wp_loaded_callback_identifier($registered['function']);
        sort($identifiers, SORT_STRING);
        $identifiers = array_slice($identifiers, 0, $remaining);
        if ($identifiers) {
            $inventory[(string) $priority] = $identifiers;
            $remaining -= count($identifiers);
        }
    }
    ksort($inventory, SORT_NUMERIC);
    return $inventory;
}
function wp_codebox_canonical_wp_loaded_remove_snapshot($identifiers, $retain) {
    $removed = array();
    $hook = isset($GLOBALS['wp_filter']['wp_loaded']) ? $GLOBALS['wp_filter']['wp_loaded'] : null;
    if (!$hook || !isset($hook->callbacks) || !is_array($hook->callbacks)) return $removed;
    $callbacks_by_priority = $hook->callbacks;
    foreach ($callbacks_by_priority as $priority => $callbacks) {
        foreach ($callbacks as $registered) {
            if (!isset($registered['function'])) continue;
            $identifier = wp_codebox_canonical_wp_loaded_callback_identifier($registered['function']);
            $matches = in_array($identifier, $identifiers, true);
            if (($retain && !$matches) || (!$retain && $matches)) {
                if (remove_action('wp_loaded', $registered['function'], (int) $priority)) $removed[] = $identifier;
            }
        }
    }
    sort($removed, SORT_STRING);
    return $removed;
}
$inventory = wp_codebox_canonical_wp_loaded_inventory();
${canonicalPhase === "canonical-wp-loaded-callbacks" ? `echo json_encode(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => '${phase}', 'callbacks' => $inventory, 'memoryBytes' => memory_get_usage(true), 'peakMemoryBytes' => memory_get_peak_usage(true)));
return;` : `$removed = wp_codebox_canonical_wp_loaded_remove_snapshot(${JSON.stringify(exclusion?.identifiers ?? [])}, ${exclusion?.retain ? "true" : "false"});
${canonicalPhase === "canonical-wp-loaded-suppress-rewrite-persist" ? "add_filter('pre_update_option_rewrite_rules', static function($value, $old_value) { return $old_value; }, PHP_INT_MAX, 2);" : ""}
$memory_before = memory_get_usage(true);
do_action('wp_loaded');
echo json_encode(array('wordpressVersion' => $wp_version, 'bootstrapPhase' => '${phase}', 'completed' => true, 'callbacks' => $inventory, 'removedCallbacks' => $removed, 'memoryBeforeBytes' => $memory_before, 'memoryBytes' => memory_get_usage(true), 'peakMemoryBytes' => memory_get_peak_usage(true)));
return;`}`
  return `<?php
$settings_path = '/wordpress/wp-settings.php';
$settings = file_get_contents($settings_path);
$needle = ${JSON.stringify(stop.needle)};
if (substr_count($settings, $needle) !== 1) {
    throw new Exception('WordPress canonical lifecycle probe needle was not uniquely found.');
}
$stop = <<<'PHP'
${wpLoadedStop}
echo json_encode(array(
    'wordpressVersion' => $wp_version,
    'bootstrapPhase' => '${phase}',
    'completed' => true,
    'memoryBytes' => memory_get_usage(true),
    'peakMemoryBytes' => memory_get_peak_usage(true),
    'wpCronInitAttached' => false !== has_action('init', 'wp_cron'),
    'updateScheduleInitAttached' => false !== has_action('init', 'wp_schedule_update_checks'),
    'privacyScheduleInitAttached' => false !== has_action('init', 'wp_schedule_delete_old_privacy_export_files'),
));
return;
PHP;
$replacement = ${stop.after ? "$needle . \"\\n\" . \$stop" : "$stop . \"\\n\" . $needle"};
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
    hooks: streamWordPressFiles || databaseSeed || markdownFiles ? {
      beforeWordPressFiles: streamWordPressFiles || markdownFiles ? async (php: PHP) => {
        if (streamWordPressFiles) await materializeWordPressServerFiles(php, runtimeBucket)
        if (markdownFiles) {
          await materializeMarkdownDatabaseIntegration(php)
          materializeCanonicalChangeAdapter(php)
          materializeRuntimeFiles(php, MARKDOWN_ROOT, markdownFiles)
          if (markdownIndexSeed) php.writeFile(MARKDOWN_RESOLVED_INDEX_PATH, markdownIndexSeed)
        }
        if (shouldPatchCanonicalRuntimePoliciesAtInit) patchCanonicalRuntimePoliciesAtInit(php)
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

function canonicalChangedPathCounts(before: RuntimeFile[], after: RuntimeFile[]): { createdPathCount: number; changedPathCount: number; deletedPathCount: number } {
  const beforeByPath = new Map(before.map((file) => [file.path, file.bytes]))
  const afterByPath = new Map(after.map((file) => [file.path, file.bytes]))
  let createdPathCount = 0
  let changedPathCount = 0
  let deletedPathCount = 0
  for (const [path, bytes] of afterByPath) {
    const previous = beforeByPath.get(path)
    if (!previous) createdPathCount++
    else if (previous.byteLength !== bytes.byteLength || previous.some((byte, index) => byte !== bytes[index])) changedPathCount++
  }
  for (const path of beforeByPath.keys()) if (!afterByPath.has(path)) deletedPathCount++
  return { createdPathCount, changedPathCount, deletedPathCount }
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

function probeResponse(phase: string, evidence: Record<string, boolean | number | string>): Response {
  return Response.json({ schema: "wp-codebox/cloudflare-boot-probe/v1", phase, completed: true, evidence })
}
