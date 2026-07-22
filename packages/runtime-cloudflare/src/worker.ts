import { loadPHPRuntime, PHP, type PHPRequestHandler, type PHPResponseData } from "@php-wasm/universal"
import { decodeZip } from "@php-wasm/stream-compression"
import { bootWordPressAndRequestHandler, type WordPressInstallMode } from "@wp-playground/wordpress"
// The PHP-WASM package publishes this Emscripten loader without TypeScript declarations.
// @ts-expect-error The adjacent Wasm declaration covers the compiled binary import.
import { dependenciesTotalSize, init } from "../../../node_modules/@php-wasm/web-8-5/asyncify/php_8_5.js"
import phpWasmModule from "../../../node_modules/@php-wasm/web-8-5/asyncify/8_5_8/php_8_5.wasm"
import { CLOUDFLARE_RUNTIME_HEALTH_MARKER, CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, cloudflareRuntimeHealthResponse } from "./health-envelope.js"
import { leaseRetryDelayMs } from "./lease-retry.js"
import { logMutationPhase, MutationRetainedBytes } from "./mutation-memory.js"
import { canonicalPublicRoute, MAX_PUBLISHED_PAGE_BYTES, MAX_PUBLISHED_REVISION_BYTES, MAX_PUBLISHED_ROUTES, normalizePublishedRoutes, PUBLISHED_PAGE_SCHEMA, PUBLISHED_REVISION_SCHEMA, publishedPageObjectKey, publishedRevisionObjectKey, R2_PUBLISHED_CURRENT_KEY, validatePublishedRevision, type PublishedRevision } from "./published-reader.js"
import { RevisionConflict, type MarkdownPointer, type RevisionCoordinator, type RevisionLease } from "./revision-coordinator.js"
import { routeWorkerRequest } from "./request-routing.js"
import { toFetchResponse, toPHPRequest } from "./request-translation.js"
import { R2_UPLOAD_OBJECT_PREFIX, validateUploadManifestFiles, validateUploadMetadata } from "./upload-persistence.js"
import { deriveWordPressAuthConstants, type WordPressAuthConstant } from "./wordpress-auth.js"
import { isWordPressRuntimeFile, wordpressStaticArchivePath, wordpressStaticContentType } from "./wordpress-runtime-corpus.js"
import { materializeWordPressRuntimeArtifact, type WordPressRuntimeArtifactManifest } from "./wordpress-runtime-artifact.js"
import { validateWordPressStaticArtifactManifest, type WordPressStaticArtifactManifest } from "./wordpress-static-artifact.js"
import { readRuntimeArchiveArtifact, type RuntimeArchiveArtifactManifest } from "./runtime-archive-artifact.js"
import { isCanonicalWpContentPath, MAX_WP_CONTENT_FILES, MAX_WP_CONTENT_FILE_BYTES, MAX_WP_CONTENT_TOTAL_BYTES, R2_WP_CONTENT_OBJECT_PREFIX, validateWpContentDeletedPaths, validateWpContentManifestFiles, validateWpContentMetadata } from "./wp-content-persistence.js"
import markdownDatabaseIntegrationRuntime from "../assets/markdown-database-integration-runtime.zip"
import canonicalMarkdownSeed from "../assets/markdown-database-integration-canonical-seed.zip"
import canonicalMarkdownSeedManifest from "../assets/markdown-database-integration-canonical-seed.json" with { type: "json" }
import markdownPrimaryBootstrapIndex from "../assets/markdown-primary-bootstrap-index.sqlite"
import wordpressInstallSeed from "../assets/wordpress-install-seed.sqlite"
import wordpressRuntimeArtifactManifest from "../assets/wordpress-runtime-artifact.json" with { type: "json" }
import wordpressStaticArtifactManifest from "../assets/wordpress-static-artifact.json" with { type: "json" }
import sqliteIntegrationArtifactManifest from "../assets/sqlite-database-integration-artifact.json" with { type: "json" }

const PHP_VERSION = "8.5.8"
const wordpressStaticArtifact = wordpressStaticArtifactManifest as WordPressStaticArtifactManifest
validateWordPressStaticArtifactManifest(wordpressStaticArtifact)
const wordpressStaticFiles = new Map(wordpressStaticArtifact.files.map((file) => [file.path, file]))
const wordpressWpContentBaselineHashes = new Map([
  ...(wordpressRuntimeArtifactManifest as WordPressRuntimeArtifactManifest).files,
  ...wordpressStaticArtifact.files,
].filter((file) => file.path.startsWith("wordpress/wp-content/"))
  .map((file) => [file.path.slice("wordpress/wp-content/".length), file.sha256] as const)
  .filter(([path]) => isCanonicalWpContentPath(path)))
const wordpressWpContentRuntimeBaselinePaths = new Set((wordpressRuntimeArtifactManifest as WordPressRuntimeArtifactManifest).files
  .filter((file) => file.path.startsWith("wordpress/wp-content/"))
  .map((file) => file.path.slice("wordpress/wp-content/".length))
  .filter(isCanonicalWpContentPath))
const MARKDOWN_DATABASE_INTEGRATION_REVISION = "bf6d434d1673fdd86d777501f7eaec292d32ad1f"
const SITE_URL = "https://wp-codebox-runtime.invalid"
const DATABASE_PATH = "/wordpress/wp-content/database/.ht.sqlite"
const MARKDOWN_ROOT = "/wordpress/wp-content/markdown"
const UPLOADS_ROOT = "/wordpress/wp-content/uploads"
const MARKDOWN_INDEX_PATH = "/tmp/markdown-index.sqlite"
const MARKDOWN_RESOLVED_INDEX_PATH = "/tmp/markdown-index-8133b4cf3c66.sqlite"
const MARKDOWN_CHANGES_PATH = "/tmp/wp-codebox-canonical-changes.json"
const PUBLICATION_CHANGES_PATH = "/tmp/wp-codebox-publication-changes.json"
const R2_MARKDOWN_REVISION_PREFIX = "sites/default/markdown/revisions"
const R2_MARKDOWN_OBJECT_PREFIX = "sites/default/markdown/objects"
const WORDPRESS_PAGE_CACHE_SCHEMA = "v3"
const PUBLIC_WP_CONTENT_EXTENSION = /\.(?:css|js|mjs|json|txt|xml|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/i
const MAX_CRON_EVENTS_PER_INVOCATION = 5
const MAX_CRON_INVOCATION_MS = 25_000
const PUBLICATION_JOB_SCHEMA = "wp-codebox/publication-job/v1"
const PUBLICATION_PROGRESS_SCHEMA = "wp-codebox/publication-progress/v1"
const R2_PUBLICATION_JOB_PREFIX = "sites/default/publications/jobs"
const R2_PUBLICATION_PROGRESS_PREFIX = "sites/default/publications/job-progress"
const R2_PUBLICATION_CLAIM_PREFIX = "sites/default/publications/job-claims"
const R2_PUBLICATION_RECEIPT_PREFIX = "sites/default/publications/job-receipts"
const PUBLICATION_CLAIM_MS = 90_000
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
const NEXT_CRON_EVENT_CODE = `<?php
require '/wordpress/wp-load.php';
$ready = wp_get_ready_cron_jobs();
if (empty($ready)) {
    echo json_encode(['executed' => false], JSON_THROW_ON_ERROR);
    return;
}
ksort($ready, SORT_NUMERIC);
foreach ($ready as $timestamp => $hooks) {
    ksort($hooks, SORT_STRING);
    foreach ($hooks as $hook => $events) {
        ksort($events, SORT_STRING);
        foreach ($events as $event) {
            $schedule = $event['schedule'] ?? false;
            $args = $event['args'] ?? array();
            if ($schedule) {
                $rescheduled = wp_reschedule_event((int) $timestamp, $schedule, $hook, $args, true);
                if (is_wp_error($rescheduled)) throw new RuntimeException($rescheduled->get_error_message());
            }
            $unscheduled = wp_unschedule_event((int) $timestamp, $hook, $args, true);
            if (is_wp_error($unscheduled)) throw new RuntimeException($unscheduled->get_error_message());
            do_action_ref_array($hook, $args);
            $GLOBALS['wpdb']->flush_canonical_writes();
            echo json_encode(['executed' => true, 'hook' => $hook, 'timestamp' => (int) $timestamp], JSON_THROW_ON_ERROR);
            return;
        }
    }
}
echo json_encode(['executed' => false], JSON_THROW_ON_ERROR);`
export interface RuntimeEnv {
  WORDPRESS_STATE_BUCKET: R2Bucket
  WORDPRESS_ADMIN_PASSWORD?: string
  WORDPRESS_AUTH_SECRET?: string
  WORDPRESS_OPERATOR_TOKEN?: string
}

export function createCloudflareRuntime<Env extends RuntimeEnv>(resolveCoordinator: (env: Env) => RevisionCoordinator) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      if (new URL(request.url).pathname === "/wp-cron.php") return new Response("WordPress cron is managed by the Cloudflare scheduled handler.", { status: 404 })
      const publishedResponse = await servePublishedWordPressPage(request, env.WORDPRESS_STATE_BUCKET)
      if (publishedResponse) return publishedResponse
      const coordinator = resolveCoordinator(env)
      const wpContentResponse = await serveWordPressWpContent(request, env.WORDPRESS_STATE_BUCKET, coordinator)
      if (wpContentResponse) return wpContentResponse
      const staticResponse = await serveWordPressStaticAsset(request, env.WORDPRESS_STATE_BUCKET)
      if (staticResponse) return staticResponse
      const route = routeWorkerRequest(request)
      const uploadResponse = await serveWordPressUpload(request, env.WORDPRESS_STATE_BUCKET, coordinator)
      if (uploadResponse) return uploadResponse
      if (route.kind === "operator-reset") return resetCanonicalWordPress(request, env, coordinator)
      if (route.kind === "operator-restore") return restoreCanonicalWordPress(request, env, coordinator)
      if (route.kind === "operator-publish") return publishCanonicalWordPressPages(request, env, coordinator)
      if (route.kind === "probe") {
        return runBootProbe(route.phase, env.WORDPRESS_STATE_BUCKET)
      }
      if (route.kind === "r2-state") {
        if (request.method !== "GET") return new Response("WordPress state read requires GET.", { status: 405 })
        return Response.json(await coordinator.state())
      }
      return runCoordinatedWordPressRequest(request, env, coordinator, route.kind)
    },
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      const coordinator = resolveCoordinator(env)
      const publication = await drainNextPublicationJob(env, coordinator)
      // A publication boot is intentionally the only heavyweight runtime in this invocation.
      const evidence = publication ? publication : await runScheduledWordPressCron(env, coordinator, controller.scheduledTime)
      console.log(JSON.stringify(evidence))
    },
  }
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
  wpContent?: MarkdownManifestFile[]
  wpContentDeleted?: string[]
}

interface RuntimeFile {
  path: string
  bytes: Uint8Array
}

interface RuntimeFileMetadata {
  path: string
  size: number
  sha256: string
}

interface WordPressPageSnapshot {
  schema: typeof PUBLISHED_PAGE_SCHEMA
  canonicalRevision: string
  route: string
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: string
}

interface PublicationChanges {
  all: boolean
  upsert: string[]
  remove: string[]
}

interface CurrentPublication {
  publication: PublishedRevision
  etag: string
}

interface CompiledPublicationRoute {
  route: string
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: string
}

interface PublicationJob {
  schema: typeof PUBLICATION_JOB_SCHEMA
  key: string
  canonical: MarkdownPointer
  coordinatorVersion: number
  changes: PublicationChanges
  createdAt: string
}

interface PublicationProgress {
  schema: typeof PUBLICATION_PROGRESS_SCHEMA
  next: number
  rendered: string[]
  plan?: { upsert: string[]; remove: string[] }
  completedAt?: string
}

interface CanonicalSeedManifest {
  schema: string
  markdownDatabaseIntegrationRevision: string
  archiveSha256: string
  files: Array<{ path: string; sha256: string; size: number }>
}

type Lease = RevisionLease

interface Runtime {
  php: PHP
  requestHandler: PHPRequestHandler
  wordpressVersion: string
  pointer: MarkdownPointer
}

interface CronInvocationEvidence {
  schema: "wp-codebox/cloudflare-cron/v1"
  scheduledTime: number
  startedAt: string
  completedAt: string
  events: Array<{ hook: string; timestamp: number; revision: string; publication: "queued" | "unchanged" }>
  status: "completed" | "bounded" | "no-canonical-state"
}

interface PublicationInvocationEvidence {
  schema: "wp-codebox/cloudflare-publication/v1"
  status: "rendered" | "promoted" | "pending" | "stale" | "failed"
  jobKey: string
  route?: string
}

let cachedRuntime: { baseRevision: string; promise: Promise<Runtime> } | undefined
const LEASE_ACQUISITION_TIMEOUT_MS = 100_000

async function resetCanonicalWordPress(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator): Promise<Response> {
  if (request.method !== "POST") return new Response("Canonical reset requires POST.", { status: 405 })
  const authorization = request.headers.get("authorization")
  if (!env.WORDPRESS_OPERATOR_TOKEN || !authorization || !await secretsMatch(authorization, `Bearer ${env.WORDPRESS_OPERATOR_TOKEN}`)) {
    return new Response("Canonical reset authorization failed.", { status: 401 })
  }
  await coordinator.reset()
  await discardCachedRuntime()
  return Response.json({ reset: true })
}

async function restoreCanonicalWordPress(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator): Promise<Response> {
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

async function servePublishedWordPressPage(request: Request, bucket: R2Bucket): Promise<Response | null> {
  if (!isCacheableWordPressPageRequest(request) || new URL(request.url).searchParams.has("phase")) return null
  if (["/wp-content/", "/wp-includes/"].some((prefix) => new URL(request.url).pathname.startsWith(prefix))) return null
  const route = canonicalPublicRoute(request)
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  const cacheRequest = publishedPageCacheRequest(request)
  const cached = cache ? await cache.match(cacheRequest) : null
  if (cached) return publishedPageResponse(cached, request.method === "HEAD", "edge")

  const current = await readCurrentPublication(bucket)
  if (!current) return null
  const publication = current.publication
  const publishedRoute = publication.routes.find((candidate) => candidate.route === route)
  if (!publishedRoute) return null
  const snapshotObject = await bucket.get(publishedRoute.objectKey)
  if (!snapshotObject) throw new Error(`Published page artifact is unavailable: ${publishedRoute.objectKey}.`)
  if (snapshotObject.size > MAX_PUBLISHED_PAGE_BYTES) throw new Error(`Published page artifact exceeds its size budget: ${publishedRoute.objectKey}.`)
  const snapshot = JSON.parse(await snapshotObject.text()) as WordPressPageSnapshot
  validateWordPressPageSnapshot(snapshot, publishedRoute.canonicalRevision, route)
  const response = new Response(snapshot.body, { status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers })
  const published = publishedPageResponse(response, request.method === "HEAD", "r2", publication.revision)
  if (cache && request.method === "GET") {
    try {
      await cache.put(cacheRequest, published.clone())
    } catch {
      // The immutable R2 publication remains authoritative when edge caching is unavailable.
    }
  }
  return published
}

async function publishCanonicalWordPressPages(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator): Promise<Response> {
  if (request.method !== "POST") return new Response("Canonical publication requires POST.", { status: 405 })
  const authorization = request.headers.get("authorization")
  if (!env.WORDPRESS_OPERATOR_TOKEN || !authorization || !await secretsMatch(authorization, `Bearer ${env.WORDPRESS_OPERATOR_TOKEN}`)) {
    return new Response("Canonical publication authorization failed.", { status: 401 })
  }
  let routes: string[]
  try {
    const body = await request.json<{ routes?: unknown }>()
    routes = normalizePublishedRoutes(body.routes)
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Canonical publication body is invalid.", { status: 400 })
  }
  const state = await coordinator.state()
  if (!state.pointer) return new Response("Canonical publication requires initialized state.", { status: 409 })
  let publishedRoutes: PublishedRevision["routes"]
  try {
    publishedRoutes = await Promise.all(routes.map(async (route) => {
      const objectKey = await publishedPageObjectKey(state.pointer!.revision, route)
      const object = await env.WORDPRESS_STATE_BUCKET.get(objectKey)
      if (!object) throw new Error(`Canonical publication route has not been rendered: ${route}.`)
      if (object.size > MAX_PUBLISHED_PAGE_BYTES) throw new Error(`Canonical publication route exceeds its size budget: ${route}.`)
      const snapshot = JSON.parse(await object.text()) as WordPressPageSnapshot
      validateWordPressPageSnapshot(snapshot, state.pointer!.revision, route)
      return { route, objectKey, canonicalRevision: state.pointer!.revision }
    }))
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Canonical publication artifacts are invalid.", { status: 409 })
  }
  const publication: PublishedRevision = {
    schema: PUBLISHED_REVISION_SCHEMA,
    revision: crypto.randomUUID(),
    canonicalRevision: state.pointer.revision,
    canonicalVersion: state.version,
    publishedAt: new Date().toISOString(),
    routes: publishedRoutes,
  }
  const serialized = JSON.stringify(publication)
  if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_REVISION_BYTES) return new Response("Canonical publication exceeds its size budget.", { status: 413 })
  await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publishedRevisionObjectKey(publication.revision), serialized)
  await env.WORDPRESS_STATE_BUCKET.put(R2_PUBLISHED_CURRENT_KEY, serialized, { httpMetadata: { contentType: "application/json" } })
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  if (cache) await Promise.all(routes.map((route) => cache.delete(publishedPageCacheRequest(new Request(new URL(route, request.url))))))
  return Response.json(publication)
}

async function readCurrentPublication(bucket: R2Bucket): Promise<CurrentPublication | null> {
  const object = await bucket.get(R2_PUBLISHED_CURRENT_KEY)
  if (!object) return null
  if (object.size > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Published revision exceeds its size budget.")
  return { publication: validatePublishedRevision(JSON.parse(await object.text())), etag: object.etag }
}

function initializePublicationChanges(php: PHP): void {
  php.writeFile(PUBLICATION_CHANGES_PATH, new TextEncoder().encode(JSON.stringify({ all: false, upsert: [], remove: [] })))
}

function readPublicationChanges(php: PHP): PublicationChanges {
  const value = JSON.parse(new TextDecoder().decode(php.readFileAsBuffer(PUBLICATION_CHANGES_PATH))) as PublicationChanges
  if (typeof value.all !== "boolean" || !Array.isArray(value.upsert) || !Array.isArray(value.remove)) throw new Error("WordPress returned invalid publication changes.")
  const normalize = (routes: unknown[]): string[] => [...new Set(routes.map((route) => {
    if (typeof route !== "string") throw new Error("WordPress returned an invalid publication route.")
    return canonicalPublicRoute(route)
  }))].sort()
  const upsert = normalize(value.upsert)
  const remove = normalize(value.remove)
  if (upsert.length + remove.length > MAX_PUBLISHED_ROUTES) throw new Error("WordPress publication changes exceed their route budget.")
  return { all: value.all, upsert, remove }
}

function publicationPlan(current: PublishedRevision, changes: PublicationChanges): { upsert: string[]; remove: string[] } {
  const existing = current.routes.map(({ route }) => route)
  const upsert = changes.all ? existing : changes.upsert
  const remove = changes.remove.filter((route) => !upsert.includes(route))
  if (new Set([...existing, ...upsert]).size > MAX_PUBLISHED_ROUTES) throw new Error("Incremental publication exceeds its route budget.")
  return { upsert, remove }
}

function publicationJobObjectKey(version: number, revision: string): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Publication job coordinator version is invalid.")
  if (!/^[a-f0-9-]{36}$/.test(revision)) throw new Error("Publication job canonical revision is invalid.")
  return `${R2_PUBLICATION_JOB_PREFIX}/${String(version).padStart(20, "0")}-${revision}.json`
}

function publicationProgressObjectKey(job: PublicationJob): string {
  return `${R2_PUBLICATION_PROGRESS_PREFIX}/${job.key.split("/").at(-1)}`
}

function publicationClaimObjectKey(job: PublicationJob): string {
  return `${R2_PUBLICATION_CLAIM_PREFIX}/${job.key.split("/").at(-1)}`
}

function publicationReceiptObjectKey(job: PublicationJob): string {
  return `${R2_PUBLICATION_RECEIPT_PREFIX}/${job.key.split("/").at(-1)}`
}

async function enqueuePublicationJob(bucket: R2Bucket, lease: Lease, canonical: MarkdownPointer, current: CurrentPublication | null, changes: PublicationChanges): Promise<PublicationJob | null> {
  if (!current) return null
  const plan = publicationPlan(current.publication, changes)
  if (!plan.upsert.length && !plan.remove.length) return null
  const coordinatorVersion = lease.version + 1
  const key = publicationJobObjectKey(coordinatorVersion, canonical.revision)
  const job: PublicationJob = {
    schema: PUBLICATION_JOB_SCHEMA,
    key,
    canonical,
    coordinatorVersion,
    changes,
    createdAt: new Date().toISOString(),
  }
  const serialized = JSON.stringify(job)
  if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Publication job exceeds its size budget.")
  // The coordinator's historical receipt makes this staged object discoverable only
  // after this exact version/pointer commits.
  await putImmutableJson(bucket, key, serialized)
  return job
}

async function readPublicationJob(bucket: R2Bucket, key: string): Promise<PublicationJob> {
  const object = await bucket.get(key)
  if (!object || object.size > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Publication job is unavailable or exceeds its size budget.")
  const job = JSON.parse(await object.text()) as PublicationJob
  if (job.schema !== PUBLICATION_JOB_SCHEMA || job.key !== key || job.key !== publicationJobObjectKey(job.coordinatorVersion, job.canonical?.revision ?? "")
    || !isCanonicalRestorePointer(job.canonical) || !validatePublicationChanges(job.changes)
    || !Number.isFinite(Date.parse(job.createdAt))) throw new Error("Publication job is invalid.")
  return job
}

function validatePublicationChanges(changes: unknown): changes is PublicationChanges {
  if (!changes || typeof changes !== "object") return false
  const value = changes as PublicationChanges
  return typeof value.all === "boolean" && Array.isArray(value.upsert) && Array.isArray(value.remove)
    && value.upsert.every((route) => typeof route === "string" && canonicalPublicRoute(route) === route)
    && value.remove.every((route) => typeof route === "string" && canonicalPublicRoute(route) === route)
}

function isPublicationPlan(plan: unknown): plan is { upsert: string[]; remove: string[] } {
  return !!plan && typeof plan === "object" && Array.isArray((plan as { upsert?: unknown }).upsert) && Array.isArray((plan as { remove?: unknown }).remove)
    && (plan as { upsert: unknown[] }).upsert.every((route) => typeof route === "string" && canonicalPublicRoute(route) === route)
    && (plan as { remove: unknown[] }).remove.every((route) => typeof route === "string" && canonicalPublicRoute(route) === route)
}

async function readPublicationProgress(bucket: R2Bucket, job: PublicationJob): Promise<PublicationProgress> {
  const object = await bucket.get(publicationProgressObjectKey(job))
  if (!object) return { schema: PUBLICATION_PROGRESS_SCHEMA, next: 0, rendered: [] }
  if (object.size > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Publication progress exceeds its size budget.")
  const progress = JSON.parse(await object.text()) as PublicationProgress
  if (progress.schema !== PUBLICATION_PROGRESS_SCHEMA || !Number.isSafeInteger(progress.next) || progress.next < 0
    || !Array.isArray(progress.rendered) || (progress.plan && !isPublicationPlan(progress.plan))
    || (progress.plan && (progress.next > progress.plan.upsert.length || progress.rendered.some((route) => !progress.plan!.upsert.includes(route))))) throw new Error("Publication progress is invalid.")
  return progress
}

async function writePublicationProgress(bucket: R2Bucket, job: PublicationJob, progress: PublicationProgress): Promise<void> {
  const serialized = JSON.stringify(progress)
  if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Publication progress exceeds its size budget.")
  await bucket.put(publicationProgressObjectKey(job), serialized, { httpMetadata: { contentType: "application/json" } })
}

async function claimPublicationJob(bucket: R2Bucket, job: PublicationJob): Promise<{ token: string; etag?: string } | null> {
  const key = publicationClaimObjectKey(job)
  const existing = await bucket.get(key)
  if (existing && existing.size <= 1_024) {
    const claim = JSON.parse(await existing.text()) as { expiresAt?: unknown }
    if (typeof claim.expiresAt === "number" && claim.expiresAt > Date.now()) return null
  }
  const token = crypto.randomUUID()
  const onlyIf = existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: "*" }
  const written = await bucket.put(key, JSON.stringify({ token, expiresAt: Date.now() + PUBLICATION_CLAIM_MS }), { onlyIf, httpMetadata: { contentType: "application/json" } })
  return written ? { token, etag: written.etag } : null
}

async function releasePublicationClaim(bucket: R2Bucket, job: PublicationJob, claim: { etag?: string }): Promise<void> {
  // Conditional expiry cannot delete a newer claimant after an expired invocation resumes.
  if (claim.etag) await bucket.put(publicationClaimObjectKey(job), JSON.stringify({ expiresAt: 0 }), { onlyIf: { etagMatches: claim.etag }, httpMetadata: { contentType: "application/json" } })
}

async function drainNextPublicationJob(env: RuntimeEnv, coordinator: RevisionCoordinator): Promise<PublicationInvocationEvidence | null> {
  const listed = await env.WORDPRESS_STATE_BUCKET.list({ prefix: `${R2_PUBLICATION_JOB_PREFIX}/`, limit: 16 })
  if (!listed.objects.length) return null
  const state = await coordinator.state()
  let job: PublicationJob | undefined
  for (const object of listed.objects) {
    const candidate = await readPublicationJob(env.WORDPRESS_STATE_BUCKET, object.key)
    const committed = await coordinator.committed(candidate.coordinatorVersion)
    if (committed?.revision === candidate.canonical.revision) {
      job = candidate
      break
    }
    if (state.version > candidate.coordinatorVersion || Date.now() - Date.parse(candidate.createdAt) > PUBLICATION_CLAIM_MS) {
      await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publicationReceiptObjectKey(candidate), JSON.stringify({ status: "orphaned", job: candidate.key, recordedAt: new Date().toISOString() }))
      await env.WORDPRESS_STATE_BUCKET.delete(candidate.key)
    }
  }
  if (!job) return listed.truncated ? { schema: "wp-codebox/cloudflare-publication/v1", status: "pending", jobKey: "scan" } : null
  const claim = await claimPublicationJob(env.WORDPRESS_STATE_BUCKET, job)
  if (!claim) return { schema: "wp-codebox/cloudflare-publication/v1", status: "pending", jobKey: job.key }
  let runtime: Runtime | undefined
  try {
    let progress = await readPublicationProgress(env.WORDPRESS_STATE_BUCKET, job)
    const current = await readCurrentPublication(env.WORDPRESS_STATE_BUCKET)
    if (!current || current.publication.canonicalVersion >= job.coordinatorVersion) {
      await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publicationReceiptObjectKey(job), JSON.stringify({ status: "superseded", job: job.key, recordedAt: new Date().toISOString() }))
      await env.WORDPRESS_STATE_BUCKET.delete([job.key, publicationProgressObjectKey(job)])
      return { schema: "wp-codebox/cloudflare-publication/v1", status: "stale", jobKey: job.key }
    }
    if (!progress.plan) {
      progress = { ...progress, plan: publicationPlan(current.publication, job.changes) }
      await writePublicationProgress(env.WORDPRESS_STATE_BUCKET, job, progress)
    }
    const plan = progress.plan
    if (!plan) throw new Error("Publication progress plan is unavailable.")
    if (progress.next < plan.upsert.length) {
      const route = plan.upsert[progress.next]
      runtime = await bootRuntime(env.WORDPRESS_STATE_BUCKET, job.canonical, SITE_URL, await canonicalWordPressAuthConstants(env))
      const compiled = await compilePublicationRoutes(runtime, [route], SITE_URL)
      const page = compiled[0]
      const objectKey = await publishedPageObjectKey(job.canonical.revision, page.route)
      const snapshot: WordPressPageSnapshot = { schema: PUBLISHED_PAGE_SCHEMA, canonicalRevision: job.canonical.revision, route: page.route, status: page.status, statusText: page.statusText, headers: page.headers, body: page.body }
      const serialized = JSON.stringify(snapshot)
      if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_PAGE_BYTES) throw new Error(`Affected publication artifact exceeds its size budget: ${page.route}.`)
      await putImmutableJson(env.WORDPRESS_STATE_BUCKET, objectKey, serialized)
      await writePublicationProgress(env.WORDPRESS_STATE_BUCKET, job, { ...progress, next: progress.next + 1, rendered: [...progress.rendered, route] })
      return { schema: "wp-codebox/cloudflare-publication/v1", status: "rendered", jobKey: job.key, route }
    }
    const routes = new Map(current.publication.routes.map((route) => [route.route, route]))
    for (const route of plan.remove) routes.delete(route)
    for (const route of plan.upsert) routes.set(route, { route, objectKey: await publishedPageObjectKey(job.canonical.revision, route), canonicalRevision: job.canonical.revision })
    const publication: PublishedRevision = { schema: PUBLISHED_REVISION_SCHEMA, revision: crypto.randomUUID(), canonicalRevision: job.canonical.revision, canonicalVersion: job.coordinatorVersion, publishedAt: new Date().toISOString(), routes: [...routes.values()].sort((left, right) => left.route.localeCompare(right.route)) }
    const serialized = JSON.stringify(publication)
    if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Incremental publication exceeds its size budget.")
    await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publishedRevisionObjectKey(publication.revision), serialized)
    if (!await promoteIncrementalPublication(env.WORDPRESS_STATE_BUCKET, current, { serialized, invalidatedRoutes: [...new Set([...plan.upsert, ...plan.remove])].sort() }, SITE_URL)) {
      return { schema: "wp-codebox/cloudflare-publication/v1", status: "stale", jobKey: job.key }
    }
    await writePublicationProgress(env.WORDPRESS_STATE_BUCKET, job, { ...progress, completedAt: new Date().toISOString() })
    await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publicationReceiptObjectKey(job), JSON.stringify({ status: "promoted", job: job.key, publication: publication.revision, recordedAt: new Date().toISOString() }))
    await env.WORDPRESS_STATE_BUCKET.delete([job.key, publicationProgressObjectKey(job)])
    return { schema: "wp-codebox/cloudflare-publication/v1", status: "promoted", jobKey: job.key }
  } catch (error) {
    console.error("Publication job failed.", error)
    return { schema: "wp-codebox/cloudflare-publication/v1", status: "failed", jobKey: job.key }
  } finally {
    if (runtime) await discardRuntime(runtime)
    await releasePublicationClaim(env.WORDPRESS_STATE_BUCKET, job, claim)
  }
}

async function compilePublicationRoutes(runtime: Runtime, routes: string[], origin: string): Promise<CompiledPublicationRoute[]> {
  const compiled: CompiledPublicationRoute[] = []
  for (const route of routes) {
    const request = new Request(new URL(route, origin))
    const response = toFetchResponse(request, await runtime.requestHandler.request(await toPHPRequest(request)))
    if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/html") || response.headers.has("set-cookie")) {
      throw new Error(`Affected publication route did not render cacheable HTML: ${route}.`)
    }
    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > MAX_PUBLISHED_PAGE_BYTES) throw new Error(`Affected publication route exceeds its size budget: ${route}.`)
    compiled.push({ route, status: response.status, statusText: response.statusText, headers: Array.from(response.headers.entries()), body })
  }
  return compiled
}

async function promoteIncrementalPublication(bucket: R2Bucket, current: CurrentPublication, staged: { serialized: string; invalidatedRoutes: string[] }, origin: string): Promise<boolean> {
  const promoted = await bucket.put(R2_PUBLISHED_CURRENT_KEY, staged.serialized, { onlyIf: { etagMatches: current.etag }, httpMetadata: { contentType: "application/json" } })
  if (!promoted) return false
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  if (cache) await Promise.all(staged.invalidatedRoutes.map((route) => cache.delete(publishedPageCacheRequest(new Request(new URL(route, origin))))))
  return true
}

function publishedPageCacheRequest(request: Request): Request {
  return new Request(`https://wp-codebox-publication.invalid${canonicalPublicRoute(request)}`, { method: "GET" })
}

function publishedPageResponse(response: Response, head: boolean, source: "edge" | "r2", revision?: string): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "public, max-age=60, s-maxage=60")
  headers.set("x-wp-codebox-page-cache", "hit")
  headers.set("x-wp-codebox-page-cache-source", `publication-${source}`)
  if (revision) headers.set("x-wp-codebox-publication-revision", revision)
  return new Response(head ? null : response.body, { status: response.status, statusText: response.statusText, headers })
}

function validateWordPressPageSnapshot(snapshot: WordPressPageSnapshot, canonicalRevision: string, route: string): void {
  if (snapshot.schema !== PUBLISHED_PAGE_SCHEMA || snapshot.canonicalRevision !== canonicalRevision || snapshot.route !== route
    || !Number.isInteger(snapshot.status) || snapshot.status < 100 || snapshot.status > 599 || typeof snapshot.statusText !== "string"
    || !Array.isArray(snapshot.headers) || snapshot.headers.some((header) => !Array.isArray(header) || header.length !== 2 || header.some((value) => typeof value !== "string"))
    || typeof snapshot.body !== "string") throw new Error("Published page artifact is invalid.")
}

async function runCoordinatedWordPressRequest(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator, route: "wordpress" | "health" | "r2-mutate"): Promise<Response> {
  if (route === "r2-mutate" && request.method !== "POST") return new Response("WordPress state mutation requires POST.", { status: 405 })
  if (route === "wordpress" && isCacheableWordPressPageRequest(request)) {
    const state = await coordinator.state()
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
    const diagnosticsStartedAt = Date.now()
    const retained = new MutationRetainedBytes()
    const currentPublication = mutatesCanonicalState ? await readCurrentPublication(env.WORDPRESS_STATE_BUCKET) : null
    let response: Response | undefined
    let phpResponse: PHPResponseData | undefined
    let responseBodyBytes = 0
    let canonicalChanges: MarkdownChanges | undefined
    let publicationChanges: PublicationChanges | undefined
    if (route === "r2-mutate") {
      initializePublicationChanges(runtime.php)
      const mutation = await runSyntheticMutation(runtime)
      response = mutation.response
      canonicalChanges = mutation.canonicalChanges
      publicationChanges = readPublicationChanges(runtime.php)
    } else if (route === "health") {
      response = await health(runtime)
    } else {
      if (mutatesCanonicalState) {
        runtime.php.writeFile(MARKDOWN_CHANGES_PATH, new TextEncoder().encode(JSON.stringify({ created: [], changed: [], deleted: [] })))
        initializePublicationChanges(runtime.php)
      }
      phpResponse = await runtime.requestHandler.request(await toPHPRequest(request))
      responseBodyBytes = phpResponse.bytes.byteLength
      if (mutatesCanonicalState) retained.retain(responseBodyBytes)
      if (!mutatesCanonicalState) response = toFetchResponse(request, phpResponse)
      if (mutatesCanonicalState) {
        canonicalChanges = readCanonicalChanges(runtime.php)
        publicationChanges = readPublicationChanges(runtime.php)
      }
    }
    if (mutatesCanonicalState) {
      if (!canonicalChanges || !publicationChanges) throw new Error("Canonical mutation completed without its persistence evidence.")
      logMutationPhase(diagnosticsStartedAt, "php-request", retained, { canonicalCreated: canonicalChanges.created.length, canonicalChanged: canonicalChanges.changed.length, canonicalDeleted: canonicalChanges.deleted.length })
      const next = await persistRuntime(env.WORDPRESS_STATE_BUCKET, runtime, canonicalChanges, diagnosticsStartedAt, retained)
      if (!response) {
        if (!phpResponse) throw new Error("WordPress mutation completed without a PHP response.")
        retained.retain(responseBodyBytes)
        response = toFetchResponse(request, phpResponse)
      }
      await discardRuntime(runtime)
      runtime = undefined
      if (phpResponse) retained.release(responseBodyBytes)
      const publicationJob = await enqueuePublicationJob(env.WORDPRESS_STATE_BUCKET, lease, next, currentPublication, publicationChanges)
      response.headers.set("x-wp-codebox-publication", publicationJob ? "queued" : "unchanged")
      if (publicationJob) response.headers.set("x-wp-codebox-publication-job", publicationJob.key)
      await commitLease(coordinator, request.url, lease, next)
      logMutationPhase(diagnosticsStartedAt, "commit", retained, { publication: publicationJob ? "queued" : "unchanged" })
    } else {
      await releaseLease(coordinator, request.url, lease)
    }
    finalized = true
    if (!mutatesCanonicalState && route === "wordpress" && response) response = await cacheWordPressPage(request, lease.pointer, response, env.WORDPRESS_STATE_BUCKET)
    if (!response) throw new Error("WordPress request completed without a response.")
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
    validateWordPressPageSnapshot(snapshot, pointer.revision, canonicalPublicRoute(request))
    if (snapshot.status !== 200) return null
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
      schema: PUBLISHED_PAGE_SCHEMA,
      canonicalRevision: pointer.revision,
      route: canonicalPublicRoute(request),
      status: cacheable.status,
      statusText: cacheable.statusText,
      headers: Array.from(cacheable.headers.entries()),
      body: await cacheable.clone().text(),
    }
    const serialized = JSON.stringify(snapshot)
    if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_PAGE_BYTES) return cacheable
    await Promise.all([
      cache ? cache.put(wordPressPageCacheKey(request, pointer), cacheable.clone()) : Promise.resolve(),
      putImmutableJson(bucket, await wordPressPageSnapshotKey(request, pointer), serialized),
    ])
  } catch {
    // Page caching is an optimization; canonical rendering remains authoritative.
  }
  return cacheable
}

async function putImmutableJson(bucket: R2Bucket, key: string, serialized: string): Promise<void> {
  const created = await bucket.put(key, serialized, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } })
  if (created) return
  const existing = await bucket.get(key)
  if (!existing || await existing.text() !== serialized) throw new Error(`Immutable R2 object conflicts with existing content: ${key}.`)
}

function wordPressPageCacheKey(request: Request, pointer: MarkdownPointer): Request {
  const url = new URL(request.url)
  url.searchParams.set("__wp_codebox_revision", pointer.revision)
  url.searchParams.set("__wp_codebox_page_cache", WORDPRESS_PAGE_CACHE_SCHEMA)
  return new Request(url, { method: "GET" })
}

async function wordPressPageSnapshotKey(request: Request, pointer: MarkdownPointer): Promise<string> {
  return publishedPageObjectKey(pointer.revision, canonicalPublicRoute(request))
}

function pageCacheResponse(response: Response, head: boolean, status: "hit" | "miss", source: "edge" | "r2" | "render"): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "public, max-age=60, s-maxage=31536000")
  headers.set("x-wp-codebox-page-cache", status)
  headers.set("x-wp-codebox-page-cache-source", source)
  return new Response(head ? null : response.body, { status: response.status, statusText: response.statusText, headers })
}

function isMutation(request: Request, route: "wordpress" | "health" | "r2-mutate"): boolean {
  if (route === "r2-mutate" || !["GET", "HEAD", "OPTIONS"].includes(request.method)) return true
  if (route !== "wordpress" || request.method !== "GET") return false
  const url = new URL(request.url)
  return url.pathname.startsWith("/wp-admin/") && !!url.searchParams.get("action") && url.searchParams.get("action") !== "-1"
}

async function acquireLease(coordinator: RevisionCoordinator, _requestUrl: string): Promise<Lease> {
  const deadline = Date.now() + LEASE_ACQUISITION_TIMEOUT_MS
  let lastError: RevisionConflict | undefined
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    try {
      return await coordinator.acquire()
    } catch (error) {
      if (!(error instanceof RevisionConflict)) throw error
      lastError = error
      const retryAfter = error.retryAt ? Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000)) : undefined
      await new Promise((resolve) => setTimeout(resolve, leaseRetryDelayMs(retryAfter, deadline - Date.now())))
    }
  }
  throw new Error(`Timed out waiting for the canonical WordPress lease${lastError ? `: ${lastError.message}` : "."}`)
}

async function releaseLease(coordinator: RevisionCoordinator, _requestUrl: string, lease: Lease): Promise<{ released: true }> {
  await coordinator.release(lease)
  return { released: true }
}

async function abortLease(coordinator: RevisionCoordinator, _requestUrl: string, lease: Lease): Promise<void> {
  try {
    await coordinator.abort(lease)
  } catch (error) {
    if (!(error instanceof RevisionConflict)) throw error
  }
}

function commitLease(coordinator: RevisionCoordinator, _requestUrl: string, lease: Lease, pointer: MarkdownPointer): Promise<{ pointer: MarkdownPointer; version: number }> {
  return coordinator.commit(lease, pointer)
}

async function getRuntime(env: RuntimeEnv, pointer: MarkdownPointer, origin: string): Promise<Runtime> {
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
    await disposeRequestHandler((await cached.promise).requestHandler)
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
  await disposeRequestHandler(runtime.requestHandler)
}

async function disposeRequestHandler(requestHandler: PHPRequestHandler): Promise<void> {
  const asyncDispose = (Symbol as unknown as { readonly asyncDispose: symbol }).asyncDispose
  const dispose = (requestHandler as unknown as Record<symbol, () => Promise<void>>)[asyncDispose]
  await dispose.call(requestHandler)
}

async function bootRuntime(bucket: R2Bucket, pointer: MarkdownPointer, origin: string, authConstants: Record<WordPressAuthConstant, string>): Promise<Runtime> {
  const revision = await readCanonicalRevision(bucket, pointer)
  return { ...await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, revision.markdown, new Uint8Array(markdownPrimaryBootstrapIndex), origin, authConstants, bucket, true, revision.uploads, revision.wpContent, revision.wpContentDeleted), pointer }
}

async function bootstrapCanonicalRuntime(env: RuntimeEnv, coordinator: RevisionCoordinator, requestUrl: string, lease: Lease): Promise<Runtime> {
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
async function canonicalWordPressAuthConstants(env: RuntimeEnv): Promise<Record<WordPressAuthConstant, string>> {
  return deriveWordPressAuthConstants(env.WORDPRESS_AUTH_SECRET ?? "", "default")
}

async function persistRuntime(bucket: R2Bucket, runtime: Runtime, changes: MarkdownChanges, diagnosticsStartedAt = Date.now(), retained = new MutationRetainedBytes()): Promise<MarkdownPointer> {
  validateMarkdownChanges(changes)
  const currentManifest = await readMarkdownManifest(bucket, runtime.pointer)
  if (!currentManifest) throw new Error(`R2 Markdown manifest is missing: ${runtime.pointer.manifestKey}`)
  validateUploadManifestFiles(currentManifest.uploads ?? [])
  validateWpContentManifestFiles(currentManifest.wpContent ?? [])
  validateWpContentDeletedPaths(currentManifest.wpContentDeleted ?? [])
  const changedPaths = [...changes.created, ...changes.changed].sort((left, right) => left.localeCompare(right))
  const uploads = await collectUploadFiles(runtime.php)
  logMutationPhase(diagnosticsStartedAt, "upload-inventory", retained, { files: uploads.length, bytes: sumMetadataBytes(uploads) })
  const uploadManifestFiles = await persistRuntimeObjects(bucket, runtime.php, UPLOADS_ROOT, uploads, currentManifest.uploads ?? [], R2_UPLOAD_OBJECT_PREFIX, retained)
  logMutationPhase(diagnosticsStartedAt, "upload-persist", retained, { files: uploadManifestFiles.length })
  const wpContent = await collectWpContentFiles(runtime.php)
  logMutationPhase(diagnosticsStartedAt, "wp-content-inventory", retained, { files: wpContent.files.length, bytes: sumMetadataBytes(wpContent.files), deleted: wpContent.deleted.length })
  const wpContentManifestFiles = await persistRuntimeObjects(bucket, runtime.php, "/wordpress/wp-content", wpContent.files, currentManifest.wpContent ?? [], R2_WP_CONTENT_OBJECT_PREFIX, retained)
  logMutationPhase(diagnosticsStartedAt, "wp-content-persist", retained, { files: wpContentManifestFiles.length })

  const manifestFiles = new Map(currentManifest.files.map((file) => [file.path, file]))
  for (const path of changes.deleted) manifestFiles.delete(path)
  for (const path of changedPaths) {
    if (!isCanonicalRelativePath(path)) throw new Error(`Invalid canonical runtime path: ${path}`)
    const absolute = `${MARKDOWN_ROOT}/${path}`
    if (runtime.php.isDir(absolute)) throw new Error(`Canonical runtime file is missing: ${path}`)
    const bytes = runtime.php.readFileAsBuffer(absolute)
    retained.retain(bytes.byteLength)
    try {
      const sha256 = await sha256Hex(bytes)
      const objectKey = `${R2_MARKDOWN_OBJECT_PREFIX}/${sha256}`
      await bucket.put(objectKey, bytes)
      manifestFiles.set(path, { path, objectKey, sha256, size: bytes.byteLength })
    } finally {
      retained.release(bytes.byteLength)
    }
  }
  logMutationPhase(diagnosticsStartedAt, "markdown-persist", retained, { files: changedPaths.length })

  const files = [...manifestFiles.values()].sort((left, right) => left.path.localeCompare(right.path))
  const unchanged = !changes.created.length && !changes.changed.length && !changes.deleted.length
    && JSON.stringify(currentManifest.uploads ?? []) === JSON.stringify(uploadManifestFiles)
    && JSON.stringify(currentManifest.wpContent ?? []) === JSON.stringify(wpContentManifestFiles)
    && JSON.stringify(currentManifest.wpContentDeleted ?? []) === JSON.stringify(wpContent.deleted)
  if (unchanged) return runtime.pointer
  return persistMarkdownManifest(bucket, files, uploadManifestFiles, wpContentManifestFiles, wpContent.deleted)
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
  return { response: Response.json({ schema: "wp-codebox/cloudflare-wordpress-mutation/v1", source: "entry-worker-primary-runtime", ...mutation, canonicalFiles: countRuntimeFiles(runtime.php, MARKDOWN_ROOT), markdownDatabaseIntegrationRevision: MARKDOWN_DATABASE_INTEGRATION_REVISION, sqlitePersisted: false }), canonicalChanges: mutation.canonicalChanges }
}

async function runScheduledWordPressCron(env: RuntimeEnv, coordinator: RevisionCoordinator, scheduledTime: number): Promise<CronInvocationEvidence> {
  const started = Date.now()
  const evidence: CronInvocationEvidence = {
    schema: "wp-codebox/cloudflare-cron/v1",
    scheduledTime,
    startedAt: new Date(started).toISOString(),
    completedAt: "",
    events: [],
    status: "completed",
  }
  const requestUrl = `${SITE_URL}/wp-cron.php?doing_wp_cron=${scheduledTime}`
  while (evidence.events.length < MAX_CRON_EVENTS_PER_INVOCATION && Date.now() - started < MAX_CRON_INVOCATION_MS) {
    const lease = await acquireLease(coordinator, requestUrl)
    if (!lease.pointer) {
      await releaseLease(coordinator, requestUrl, lease)
      evidence.status = "no-canonical-state"
      break
    }
    let runtime: Runtime | undefined
    let finalized = false
    try {
      runtime = await getRuntime(env, lease.pointer, SITE_URL)
      const event = await runNextCronEvent(runtime)
      if (!event.executed) {
        await releaseLease(coordinator, requestUrl, lease)
        finalized = true
        await discardRuntime(runtime)
        break
      }
      const next = await persistRuntime(env.WORDPRESS_STATE_BUCKET, runtime, event.canonicalChanges)
      const currentPublication = await readCurrentPublication(env.WORDPRESS_STATE_BUCKET)
      await discardRuntime(runtime)
      runtime = undefined
      const publicationJob = await enqueuePublicationJob(env.WORDPRESS_STATE_BUCKET, lease, next, currentPublication, event.publicationChanges)
      await commitLease(coordinator, requestUrl, lease, next)
      finalized = true
      evidence.events.push({ hook: event.hook, timestamp: event.timestamp, revision: next.revision, publication: publicationJob ? "queued" : "unchanged" })
    } catch (error) {
      if (!finalized) await abortLease(coordinator, requestUrl, lease)
      if (runtime) await discardRuntime(runtime)
      throw error
    }
  }
  if (evidence.events.length === MAX_CRON_EVENTS_PER_INVOCATION || Date.now() - started >= MAX_CRON_INVOCATION_MS) evidence.status = "bounded"
  evidence.completedAt = new Date().toISOString()
  return evidence
}

async function runNextCronEvent(runtime: Runtime): Promise<{ executed: false } | { executed: true; hook: string; timestamp: number; canonicalChanges: MarkdownChanges; publicationChanges: PublicationChanges }> {
  runtime.php.writeFile(MARKDOWN_CHANGES_PATH, new TextEncoder().encode(JSON.stringify({ created: [], changed: [], deleted: [] })))
  initializePublicationChanges(runtime.php)
  const output = (await runtime.php.run({ code: NEXT_CRON_EVENT_CODE })).text.trim()
  const event = JSON.parse(output) as { executed: boolean; hook?: string; timestamp?: number }
  if (!event.executed) return { executed: false }
  if (!event.hook || !Number.isSafeInteger(event.timestamp)) throw new Error("WordPress cron returned invalid event evidence.")
  return { executed: true, hook: event.hook, timestamp: event.timestamp!, canonicalChanges: readCanonicalChanges(runtime.php), publicationChanges: readPublicationChanges(runtime.php) }
}

async function health(runtime: Runtime): Promise<Response> {
  const phpVersion = (await runtime.php.run({ code: "<?php echo PHP_VERSION;" })).text.trim()
  return cloudflareRuntimeHealthResponse({ schema: CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, marker: CLOUDFLARE_RUNTIME_HEALTH_MARKER, wordpressVersion: runtime.wordpressVersion, phpVersion, runtime: { backend: "wordpress-playground", environment: "wordpress" }, evidence: { initialization: "completed", execution: "completed", initializationScope: "isolate" } })
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

async function readCanonicalRevision(bucket: R2Bucket, pointer: MarkdownPointer): Promise<{ markdown: RuntimeFile[]; uploads: RuntimeFile[]; wpContent: RuntimeFile[]; wpContentDeleted: string[] }> {
  const manifestObject = await bucket.get(pointer.manifestKey)
  if (!manifestObject) throw new Error(`R2 Markdown manifest is missing: ${pointer.manifestKey}`)
  const manifest = await manifestObject.json<MarkdownManifest>()
  validateUploadManifestFiles(manifest.uploads ?? [])
  validateWpContentManifestFiles(manifest.wpContent ?? [])
  validateWpContentDeletedPaths(manifest.wpContentDeleted ?? [])
  const [markdown, uploads, wpContent] = await Promise.all([
    readManifestFiles(bucket, manifest.files, "Markdown"),
    readManifestFiles(bucket, manifest.uploads ?? [], "upload"),
    readManifestFiles(bucket, manifest.wpContent ?? [], "wp-content"),
  ])
  return { markdown, uploads, wpContent, wpContentDeleted: manifest.wpContentDeleted ?? [] }
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

async function persistMarkdownRevision(bucket: R2Bucket, files: RuntimeFile[], current?: MarkdownPointer, changes?: MarkdownChanges, uploads: RuntimeFile[] = [], wpContent: RuntimeFile[] = [], wpContentDeleted: string[] = []): Promise<MarkdownPointer> {
  const currentManifest = current ? await readMarkdownManifest(bucket, current) : null
  if (current && !currentManifest) throw new Error(`R2 Markdown manifest is missing: ${current.manifestKey}`)
  validateUploadManifestFiles(currentManifest?.uploads ?? [])
  validateWpContentManifestFiles(currentManifest?.wpContent ?? [])
  validateWpContentDeletedPaths(currentManifest?.wpContentDeleted ?? [])
  validateWpContentDeletedPaths(wpContentDeleted)
  const uploadManifestFiles = await persistUploadObjects(bucket, uploads, currentManifest?.uploads ?? [])
  const wpContentManifestFiles = await persistWpContentObjects(bucket, wpContent, currentManifest?.wpContent ?? [])
  const uploadsUnchanged = JSON.stringify(currentManifest?.uploads ?? []) === JSON.stringify(uploadManifestFiles)
  const wpContentUnchanged = JSON.stringify(currentManifest?.wpContent ?? []) === JSON.stringify(wpContentManifestFiles)
  const wpContentDeletedUnchanged = JSON.stringify(currentManifest?.wpContentDeleted ?? []) === JSON.stringify(wpContentDeleted)
  if (current && currentManifest && changes) {
    validateMarkdownChanges(changes)
    if (!changes.created.length && !changes.changed.length && !changes.deleted.length && uploadsUnchanged && wpContentUnchanged && wpContentDeletedUnchanged) return current
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
    return persistMarkdownManifest(bucket, [...manifestFiles.values()].sort((left, right) => left.path.localeCompare(right.path)), uploadManifestFiles, wpContentManifestFiles, wpContentDeleted)
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
    if (JSON.stringify(currentManifest.files) === JSON.stringify(manifestFiles) && uploadsUnchanged && wpContentUnchanged && wpContentDeletedUnchanged) return current
  }

  return persistMarkdownManifest(bucket, manifestFiles, uploadManifestFiles, wpContentManifestFiles, wpContentDeleted)
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

async function persistWpContentObjects(bucket: R2Bucket, files: RuntimeFile[], current: MarkdownManifestFile[]): Promise<MarkdownManifestFile[]> {
  validateWpContentMetadata(files.map((file) => ({ path: file.path, size: file.bytes.byteLength })))
  const currentFiles = new Map(current.map((file) => [file.path, file]))
  const persisted: MarkdownManifestFile[] = []
  for (const file of files) {
    const sha256 = await sha256Hex(file.bytes)
    const existing = currentFiles.get(file.path)
    if (existing?.sha256 === sha256 && existing.size === file.bytes.byteLength) {
      persisted.push(existing)
      continue
    }
    const objectKey = `${R2_WP_CONTENT_OBJECT_PREFIX}/${sha256}`
    if (!await bucket.head(objectKey)) await bucket.put(objectKey, file.bytes)
    persisted.push({ path: file.path, objectKey, sha256, size: file.bytes.byteLength })
  }
  return persisted
}

function validateUploadFiles(files: RuntimeFile[]): void {
  validateUploadMetadata(files.map((file) => ({ path: file.path, size: file.bytes.byteLength })))
}

async function persistMarkdownManifest(bucket: R2Bucket, files: MarkdownManifestFile[], uploads: MarkdownManifestFile[] = [], wpContent: MarkdownManifestFile[] = [], wpContentDeleted: string[] = []): Promise<MarkdownPointer> {
  const revision = crypto.randomUUID()
  const manifestKey = `${R2_MARKDOWN_REVISION_PREFIX}/${revision}.json`
  const persistedAt = new Date().toISOString()
  const pointer: MarkdownPointer = { revision, manifestKey, persistedAt }
  const manifest: MarkdownManifest = { ...pointer, files, uploads, wpContent, wpContentDeleted }
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
    const archiveBytes = phase === "wordpress-archive"
      ? (await readWordPressRuntimeArtifact(bucket)).byteLength
      : (await readSqliteIntegrationArtifact(bucket)).size
    return probeResponse(phase, { archiveBytes })
  }

  if (phase === "archives") {
    const [wordpressBytes, sqliteZip] = await Promise.all([readWordPressRuntimeArtifact(bucket), readSqliteIntegrationArtifact(bucket)])
    return probeResponse(phase, { wordpressArchiveBytes: wordpressBytes.byteLength, sqliteArchiveBytes: sqliteZip.size })
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
    const archive = phase === "wordpress-archive-php" ? await readWordPressRuntimeArtifact(bucket) : undefined
    const php = new PHP(await createPhpRuntime())
    try {
      const wordpressZip = archive ?? await readWordPressRuntimeArtifact(bucket)
      const phpVersion = (await php.run({ code: "<?php echo PHP_VERSION;" })).text.trim()
      return probeResponse(phase, { phpVersion, archiveBytes: wordpressZip.byteLength })
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

  if (phase === "full") {
    const runtime = await bootWordPressRuntime(
      "do-not-attempt-installing",
      true,
      true,
      undefined,
      await packagedCanonicalMarkdownSeed(),
      new Uint8Array(markdownPrimaryBootstrapIndex),
      SITE_URL,
      {},
      bucket,
      true,
    )
    try {
      const phpVersion = (await runtime.php.run({ code: "<?php echo PHP_VERSION;" })).text.trim()
      return probeResponse(phase, { phpVersion, wordpressVersion: runtime.wordpressVersion, bootMode: "canonical-mdi" })
    } finally {
      runtime.php.exit()
    }
  }

  if (phase === "wordpress-files" || phase === "sqlite" || phase === "streamed-sqlite" || phase === "streamed-wordpress") {
    const runtime = await bootWordPressRuntime(
      phase === "streamed-wordpress" ? "install-from-existing-files" : "do-not-attempt-installing",
      phase !== "wordpress-files",
      true,
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
      runtime.php.exit()
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
  streamWordPressFiles = true,
  databaseSeed?: Uint8Array,
  markdownFiles?: RuntimeFile[],
  markdownIndexSeed?: Uint8Array,
  siteUrl = SITE_URL,
  authConstants: Partial<Record<WordPressAuthConstant, string>> = {},
  runtimeBucket?: R2Bucket,
  shouldPatchCanonicalRuntimePoliciesAtInit = false,
  uploadFiles?: RuntimeFile[],
  wpContentFiles?: RuntimeFile[],
  wpContentDeleted: string[] = [],
): Promise<{ php: PHP; requestHandler: PHPRequestHandler; wordpressVersion: string }> {
  if (includeSqlite && !runtimeBucket) throw new Error("SQLite integration artifact requires WORDPRESS_STATE_BUCKET.")
  validateWpContentDeletedPaths(wpContentDeleted)
  const sqliteIntegrationPluginZip = includeSqlite ? readSqliteIntegrationArtifact(runtimeBucket!) : undefined
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
    hooks: streamWordPressFiles || databaseSeed || markdownFiles || uploadFiles?.length || wpContentFiles?.length || wpContentDeleted.length ? {
      beforeWordPressFiles: streamWordPressFiles || markdownFiles || uploadFiles?.length || wpContentFiles?.length || wpContentDeleted.length ? async (php: PHP) => {
        if (streamWordPressFiles) await materializeWordPressServerFiles(php, runtimeBucket)
        if (markdownFiles) {
          await materializeMarkdownDatabaseIntegration(php)
          materializeCanonicalChangeAdapter(php)
          materializeRuntimeFiles(php, MARKDOWN_ROOT, markdownFiles)
          if (markdownIndexSeed) php.writeFile(MARKDOWN_RESOLVED_INDEX_PATH, markdownIndexSeed)
        }
        if (wpContentFiles?.length) materializeRuntimeFiles(php, "/wordpress/wp-content", wpContentFiles)
        if (wpContentDeleted.length) await materializeWpContentTombstones(php, wpContentDeleted)
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
    wordPressZip: undefined,
    sqliteIntegrationPluginZip,
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

async function materializeWpContentTombstones(php: PHP, paths: string[]): Promise<void> {
  validateWpContentDeletedPaths(paths)
  const encodedPaths = JSON.stringify(paths).replace(/</g, "\\u003c")
  await php.run({ code: `<?php
$root = '/wordpress/wp-content';
$paths = json_decode(${JSON.stringify(encodedPaths)}, true, 512, JSON_THROW_ON_ERROR);
foreach ($paths as $relative) {
    $path = $root . '/' . $relative;
    if (is_file($path) || is_link($path)) unlink($path);
}` })
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
// This runtime has an explicit scheduled handler, so cron events are canonical.
add_filter( 'markdown_database_integration_ephemeral_option_names', static function ( $names ) {
	return array_values( array_diff( $names, array( 'cron' ) ) );
} );
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

function countRuntimeFiles(php: PHP, root: string): number {
  let count = 0
  const visit = (directory: string): void => {
    for (const name of php.listFiles(directory)) {
      if (name === "." || name === "..") continue
      const path = `${directory}/${name}`
      if (php.isDir(path)) visit(path)
      else if (!name.includes(".tmp.") && !name.startsWith("markdown-index.sqlite")) count++
    }
  }
  visit(root)
  return count
}

async function collectUploadFiles(php: PHP): Promise<RuntimeFileMetadata[]> {
  if (!php.isDir(UPLOADS_ROOT)) return []
  const output = (await php.run({ code: `<?php
$root = '${UPLOADS_ROOT}';
$files = array();
$iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
foreach ($iterator as $file) {
    if (!$file->isFile()) continue;
    $path = str_replace('\\\\', '/', $file->getPathname());
    $files[] = array('path' => substr($path, strlen($root) + 1), 'size' => $file->getSize(), 'sha256' => hash_file('sha256', $path));
}
usort($files, static fn($left, $right) => strcmp($left['path'], $right['path']));
echo json_encode($files, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);` })).text.trim()
  const metadata: unknown = JSON.parse(output)
  validateUploadMetadata(metadata)
  validateRuntimeFileHashes(metadata)
  return metadata
}

async function collectWpContentFiles(php: PHP): Promise<{ files: RuntimeFileMetadata[]; deleted: string[] }> {
  const output = (await php.run({ code: `<?php
$base = '/wordpress/wp-content';
$files = array();
$total = 0;
foreach (array('plugins', 'themes', 'languages', 'mu-plugins') as $root) {
    $directory = $base . '/' . $root;
    if (!is_dir($directory)) continue;
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
    foreach ($iterator as $file) {
        if (!$file->isFile()) continue;
        $absolute = str_replace('\\\\', '/', $file->getPathname());
        $path = $root . '/' . substr($absolute, strlen($directory) + 1);
        if (str_starts_with($path, 'plugins/markdown-database-integration/') || str_starts_with($path, 'plugins/sqlite-database-integration/') || str_starts_with($path, 'mu-plugins/wp-codebox-cloudflare-canonical-changes.php')) continue;
        $size = $file->getSize();
        $total += $size;
        if ($size > ${MAX_WP_CONTENT_FILE_BYTES} || $total > ${MAX_WP_CONTENT_TOTAL_BYTES} || count($files) >= ${MAX_WP_CONTENT_FILES}) {
            throw new RuntimeException('Canonical wp-content files exceed their budget.');
        }
        $files[] = array('path' => $path, 'size' => $size, 'sha256' => hash_file('sha256', $absolute));
    }
}
usort($files, static fn($left, $right) => strcmp($left['path'], $right['path']));
echo json_encode($files, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);` })).text.trim()
  const metadata: unknown = JSON.parse(output)
  validateWpContentMetadata(metadata)
  validateRuntimeFileHashes(metadata)
  const persistent = metadata.filter((file) => wordpressWpContentBaselineHashes.get(file.path) !== file.sha256)
  const currentPaths = new Set(metadata.map((file) => file.path))
  const deleted = new Set([...wordpressWpContentRuntimeBaselinePaths].filter((path) => {
    const absolute = `/wordpress/wp-content/${path}`
    return !php.isDir(absolute) && !currentPaths.has(path)
  }))
  const baselineThemes = new Set([...wordpressWpContentBaselineHashes.keys()].filter((path) => path.startsWith("themes/")).map((path) => path.split("/")[1]))
  for (const theme of baselineThemes) {
    if (!php.isDir(`/wordpress/wp-content/themes/${theme}`)) {
      for (const path of wordpressWpContentBaselineHashes.keys()) if (path.startsWith(`themes/${theme}/`)) deleted.add(path)
    }
  }
  const sortedDeleted = [...deleted].sort((left, right) => left.localeCompare(right))
  validateWpContentDeletedPaths(sortedDeleted)
  return { files: persistent, deleted: sortedDeleted }
}

function validateRuntimeFileHashes(files: unknown): asserts files is RuntimeFileMetadata[] {
  if (!Array.isArray(files) || files.some((file) => !file || typeof file !== "object" || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error("Canonical runtime inventory contains an invalid digest.")
}

function sumMetadataBytes(files: RuntimeFileMetadata[]): number {
  return files.reduce((total, file) => total + file.size, 0)
}

async function persistRuntimeObjects(bucket: R2Bucket, php: PHP, root: string, files: RuntimeFileMetadata[], current: MarkdownManifestFile[], objectPrefix: string, retained: MutationRetainedBytes): Promise<MarkdownManifestFile[]> {
  const currentFiles = new Map(current.map((file) => [file.path, file]))
  const persisted: MarkdownManifestFile[] = []
  for (const file of files) {
    const existing = currentFiles.get(file.path)
    if (existing && existing.sha256 === file.sha256 && existing.size === file.size) {
      persisted.push(existing)
      continue
    }
    const bytes = php.readFileAsBuffer(`${root}/${file.path}`)
    retained.retain(bytes.byteLength)
    try {
      if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.sha256) throw new Error(`Canonical runtime file changed during persistence: ${file.path}`)
      const objectKey = `${objectPrefix}/${file.sha256}`
      if (!await bucket.head(objectKey)) await bucket.put(objectKey, bytes)
      persisted.push({ path: file.path, objectKey, sha256: file.sha256, size: file.size })
    } finally {
      retained.release(bytes.byteLength)
    }
  }
  return persisted
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
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
  const publicationSource = `
function wp_codebox_publication_read_changes() {
	$path = '${PUBLICATION_CHANGES_PATH}';
	if ( ! is_file( $path ) ) return array( 'all' => false, 'upsert' => array(), 'remove' => array() );
	$changes = json_decode( (string) file_get_contents( $path ), true );
	return is_array( $changes ) ? $changes : array( 'all' => false, 'upsert' => array(), 'remove' => array() );
}
function wp_codebox_publication_write_changes( $changes ) {
	$changes['upsert'] = array_values( array_unique( $changes['upsert'] ) );
	$changes['remove'] = array_values( array_unique( $changes['remove'] ) );
	sort( $changes['upsert'], SORT_STRING );
	sort( $changes['remove'], SORT_STRING );
	if ( false === file_put_contents( '${PUBLICATION_CHANGES_PATH}', wp_json_encode( $changes, JSON_UNESCAPED_SLASHES ), LOCK_EX ) ) {
		throw new RuntimeException( 'Failed to expose affected publication routes.' );
	}
}
function wp_codebox_publication_route( $url ) {
	$parts = wp_parse_url( $url );
	if ( ! is_array( $parts ) ) return null;
	$route = empty( $parts['path'] ) ? '/' : $parts['path'];
	if ( ! empty( $parts['query'] ) ) {
		parse_str( $parts['query'], $query );
		ksort( $query, SORT_STRING );
		$route .= '?' . http_build_query( $query, '', '&', PHP_QUERY_RFC3986 );
	}
	return $route;
}
function wp_codebox_publication_record_post( $post_id, $remove = false ) {
	if ( wp_is_post_revision( $post_id ) || wp_is_post_autosave( $post_id ) ) return;
	$post = get_post( $post_id );
	if ( ! $post || 'attachment' === $post->post_type ) return;
	$changes = wp_codebox_publication_read_changes();
	$changes['upsert'][] = '/';
	$route = wp_codebox_publication_route( get_permalink( $post ) );
	if ( $route ) {
		if ( $remove || 'publish' !== $post->post_status ) $changes['remove'][] = $route;
		else $changes['upsert'][] = $route;
	}
	if ( 'publish' === $post->post_status ) {
		$archive = get_post_type_archive_link( $post->post_type );
		if ( $archive ) $changes['upsert'][] = wp_codebox_publication_route( $archive );
		$author = get_author_posts_url( (int) $post->post_author );
		if ( $author ) $changes['upsert'][] = wp_codebox_publication_route( $author );
		foreach ( get_object_taxonomies( $post->post_type ) as $taxonomy ) {
			$terms = get_the_terms( $post, $taxonomy );
			if ( ! is_array( $terms ) ) continue;
			foreach ( $terms as $term ) {
				$link = get_term_link( $term );
				if ( ! is_wp_error( $link ) ) $changes['upsert'][] = wp_codebox_publication_route( $link );
			}
		}
	}
	wp_codebox_publication_write_changes( $changes );
}
add_action( 'pre_post_update', static function ( $post_id ) { wp_codebox_publication_record_post( $post_id, true ); }, 1 );
add_action( 'save_post', static function ( $post_id ) { wp_codebox_publication_record_post( $post_id ); }, PHP_INT_MAX );
add_action( 'before_delete_post', static function ( $post_id ) { wp_codebox_publication_record_post( $post_id, true ); }, 1 );
add_action( 'set_object_terms', static function ( $post_id ) { wp_codebox_publication_record_post( $post_id ); }, PHP_INT_MAX );
add_action( 'updated_option', static function ( $option ) {
	if ( in_array( $option, array( 'active_plugins', 'blogname', 'page_for_posts', 'page_on_front', 'permalink_structure', 'show_on_front', 'sidebars_widgets', 'stylesheet', 'template' ), true ) || str_starts_with( $option, 'theme_mods_' ) ) {
		$changes = wp_codebox_publication_read_changes();
		$changes['all'] = true;
		wp_codebox_publication_write_changes( $changes );
	}
}, PHP_INT_MAX );
add_action( 'wp_update_nav_menu', static function () {
	$changes = wp_codebox_publication_read_changes();
	$changes['all'] = true;
	wp_codebox_publication_write_changes( $changes );
}, PHP_INT_MAX );`
  php.mkdir(path.slice(0, path.lastIndexOf("/")))
  php.writeFile(path, new TextEncoder().encode(`${source}${publicationSource}`))
}

async function materializeWordPressServerFiles(php: PHP, bucket: R2Bucket | undefined): Promise<{ materializedFiles: number; materializedBytes: number }> {
  if (!bucket) throw new Error("WordPress runtime corpus artifact requires WORDPRESS_STATE_BUCKET.")
  return materializeWordPressRuntimeArtifact(php, bucket, wordpressRuntimeArtifactManifest as WordPressRuntimeArtifactManifest)
}

async function readWordPressRuntimeArtifact(bucket: R2Bucket): Promise<Uint8Array> {
  const manifest = wordpressRuntimeArtifactManifest as WordPressRuntimeArtifactManifest
  const object = await bucket.get(manifest.key)
  if (!object) throw new Error("WordPress runtime corpus artifact is unavailable.")
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.byteLength !== manifest.archive.size || await sha256Hex(bytes) !== manifest.archive.sha256) throw new Error("WordPress runtime corpus artifact integrity check failed.")
  return bytes
}

async function readSqliteIntegrationArtifact(bucket: R2Bucket): Promise<File> {
  const manifest = sqliteIntegrationArtifactManifest as RuntimeArchiveArtifactManifest
  const bytes = await readRuntimeArchiveArtifact(bucket, manifest)
  return new File([Uint8Array.from(bytes).buffer], "sqlite-database-integration.zip", { type: "application/zip" })
}

async function serveWordPressWpContent(request: Request, bucket: R2Bucket, coordinator: RevisionCoordinator): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/wp-content/") || !PUBLIC_WP_CONTENT_EXTENSION.test(url.pathname)) return null
  let path: string
  try {
    path = decodeURIComponent(url.pathname.slice("/wp-content/".length))
  } catch {
    return new Response("Invalid WordPress content path.", { status: 400 })
  }
  if (!isCanonicalWpContentPath(path)) return null
  const state = await coordinator.state()
  if (!state.pointer) return null
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  const cacheKey = wordPressRevisionCacheKey(request, state.pointer)
  if (request.method === "GET" && cache) {
    try {
      const cached = await cache.match(cacheKey)
      if (cached) return cached
    } catch {
      // R2 remains authoritative when the edge cache is unavailable.
    }
  }
  const manifest = await readMarkdownManifest(bucket, state.pointer)
  validateWpContentManifestFiles(manifest?.wpContent ?? [])
  validateWpContentDeletedPaths(manifest?.wpContentDeleted ?? [])
  if (manifest?.wpContentDeleted?.includes(path)) return new Response("WordPress content not found.", { status: 404 })
  const file = manifest?.wpContent?.find((candidate) => candidate.path === path)
  if (!file) return null
  const object = await bucket.get(file.objectKey)
  if (!object || object.size !== file.size) throw new Error(`R2 wp-content object is missing or inconsistent: ${file.objectKey}`)
  let body: Uint8Array | null = null
  if (request.method === "GET") {
    body = new Uint8Array(await object.arrayBuffer())
    if (await sha256Hex(body) !== file.sha256) throw new Error(`R2 wp-content object failed integrity validation: ${file.objectKey}`)
  }
  const response = new Response(body ? Uint8Array.from(body).buffer : null, {
    headers: {
      "cache-control": "public, max-age=60",
      "content-length": String(file.size),
      "content-type": wordPressContentType(path),
      etag: `"${file.sha256}"`,
      "x-wp-codebox-static": "r2-wp-content",
    },
  })
  if (request.method === "GET" && cache) {
    try {
      await cache.put(cacheKey, response.clone())
    } catch {
      // R2 remains authoritative when the edge cache is unavailable.
    }
  }
  return response
}

async function serveWordPressUpload(request: Request, bucket: R2Bucket, coordinator: RevisionCoordinator): Promise<Response | null> {
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
  const state = await coordinator.state()
  if (!state.pointer) return null
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  const cacheKey = wordPressRevisionCacheKey(request, state.pointer)
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
    "content-type": wordPressContentType(path),
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

function wordPressRevisionCacheKey(request: Request, pointer: MarkdownPointer): Request {
  const url = new URL(request.url)
  url.searchParams.set("__wp_codebox_revision", pointer.revision)
  return new Request(url, { method: "GET" })
}

function wordPressContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return ({
    avif: "image/avif",
    css: "text/css; charset=utf-8",
    eot: "application/vnd.ms-fontobject",
    gif: "image/gif",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    otf: "font/otf",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    ttf: "font/ttf",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    xml: "application/xml",
  } as Record<string, string>)[extension] ?? "application/octet-stream"
}

async function serveWordPressStaticAsset(request: Request, bucket: R2Bucket): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const archivePath = wordpressStaticArchivePath(new URL(request.url).pathname)
  if (!archivePath) return null
  const file = wordpressStaticFiles.get(archivePath)
  // Mutable custom-theme assets are served by Playground from canonical wp-content.
  if (!file) return null

  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  const cacheUrl = new URL(request.url)
  cacheUrl.searchParams.set("__wp_codebox_static_artifact", wordpressStaticArtifact.blob.sha256)
  const cacheRequest = new Request(cacheUrl, request)
  if (request.method === "GET" && cache) {
    try {
      const cached = await cache.match(cacheRequest)
      if (cached) return cached
    } catch {
      // Cache availability is an optimization, never a dependency.
    }
  }

  const object = file.size ? await bucket.get(wordpressStaticArtifact.key, { range: { offset: file.offset, length: file.size } }) : undefined
  if (file.size && !object) return new Response("WordPress static artifact is unavailable.", { status: 503 })
  const bytes = object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array()
  if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.sha256) return new Response("WordPress static artifact integrity check failed.", { status: 502 })
  const response = new Response(request.method === "HEAD" ? null : bytes, {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(file.size),
      "content-type": wordpressStaticContentType(archivePath),
      "etag": `"${file.sha256}"`,
      "x-wp-codebox-static": "r2-range",
    },
  })
  if (request.method === "GET" && cache) {
    try {
      await cache.put(cacheRequest, response.clone())
    } catch {
      // A full or unavailable Worker cache must not affect the R2 response.
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

function instantiatePrecompiledWasm(module: WebAssembly.Module) {
  return (imports: WebAssembly.Imports, receiveInstance: (instance: WebAssembly.Instance, wasmModule: WebAssembly.Module) => void) => receiveInstance(new WebAssembly.Instance(module, imports), module)
}

function probeResponse(phase: string, evidence: Record<string, number | string>): Response {
  return Response.json({ schema: "wp-codebox/cloudflare-boot-probe/v1", phase, completed: true, evidence })
}
