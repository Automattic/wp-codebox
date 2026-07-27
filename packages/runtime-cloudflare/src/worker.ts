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
import { selectOperatorCoordinator } from "./operator-coordinator.js"
import { canonicalPublicRoute, MAX_PUBLISHED_PAGE_BYTES, MAX_PUBLISHED_REVISION_BYTES, MAX_PUBLISHED_ROUTES, normalizePublishedRoutes, PUBLISHED_PAGE_SCHEMA, PUBLISHED_REVISION_SCHEMA, publishedPageObjectKey, publishedRevisionObjectKey, validatePublishedRevision, type PublishedRevision } from "./published-reader.js"
import { RevisionConflict, type MarkdownPointer, type MutationFence, type RevisionCoordinator, type RevisionLease } from "./revision-coordinator.js"
import { routeWorkerRequest } from "./request-routing.js"
import { readStaticArtifactImport, STATIC_ARTIFACT_IMPORT_RESULT_SCHEMA, StaticArtifactImportError, type StaticArtifactImport } from "./static-artifact-import.js"
import { D1OperationRepository, OperationConflict, STATIC_ARTIFACT_OPERATION_SCHEMA, shouldRecoverPreparedCommit } from "./d1-operation-repository.js"
import { parseRuntimeQueueMessage, parseRuntimeQueuePolicy, type RuntimeQueue, type RuntimeQueueMessage } from "./queue-dispatch.js"
import { dispatchQueueBatch, type ParsedQueueDelivery, type QueueDelivery } from "./queue-batch.js"
import { resumeProvisioningAllocation, routeProvisioningApi } from "./provisioning-api.js"
import { allocationIdentity, CloudflareAllocationLifecycle } from "./allocation-lifecycle.js"
import { toFetchResponse, toPHPRequest } from "./request-translation.js"
import { DEFAULT_SITE_CONTEXT, parseSiteContexts, previewDomain, resolvePreviewSiteContextFromRequest, resolveSiteContextFromRequest, siteStorageKeys, type SiteContext } from "./site-context.js"
import { validateUploadManifestFiles, validateUploadMetadata } from "./upload-persistence.js"
import { deriveSiteCredential, deriveWordPressAuthConstants, type WordPressAuthConstant } from "./wordpress-auth.js"
import { isWordPressRuntimeFile, wordpressStaticArchivePath, wordpressStaticContentType } from "./wordpress-runtime-corpus.js"
import { materializeWordPressRuntimeArtifact, type WordPressRuntimeArtifactManifest } from "./wordpress-runtime-artifact.js"
import { validateWordPressStaticArtifactManifest, type WordPressStaticArtifactManifest } from "./wordpress-static-artifact.js"
import { readRuntimeArchiveArtifact, type RuntimeArchiveArtifactManifest } from "./runtime-archive-artifact.js"
import { isCanonicalWpContentPath, MAX_WP_CONTENT_FILES, MAX_WP_CONTENT_FILE_BYTES, MAX_WP_CONTENT_TOTAL_BYTES, validateWpContentDeletedPaths, validateWpContentManifestFiles, validateWpContentMetadata } from "./wp-content-persistence.js"
import markdownDatabaseIntegrationRuntime from "../assets/markdown-database-integration-runtime.zip"
import canonicalMarkdownSeed from "../assets/markdown-database-integration-canonical-seed.zip"
import canonicalMarkdownSeedManifest from "../assets/markdown-database-integration-canonical-seed.json" with { type: "json" }
import markdownPrimaryBootstrapIndex from "../assets/markdown-primary-bootstrap-index.sqlite"
import wordpressInstallSeed from "../assets/wordpress-install-seed.sqlite"
import wordpressRuntimeArtifactManifest from "../assets/wordpress-runtime-artifact.json" with { type: "json" }
import wordpressStaticArtifactManifest from "../assets/wordpress-static-artifact.json" with { type: "json" }
import sqliteIntegrationArtifactManifest from "../assets/sqlite-database-integration-artifact.json" with { type: "json" }
import staticSiteImporterArtifactManifest from "../assets/static-site-importer-artifact.json" with { type: "json" }

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
const PROBE_SITE_URL = "https://wp-codebox-runtime.invalid"
const DATABASE_PATH = "/wordpress/wp-content/database/.ht.sqlite"
const MARKDOWN_ROOT = "/wordpress/wp-content/markdown"
const STATIC_SITE_IMPORTER_ROOT = "/wordpress/wp-content/plugins/static-site-importer"
const STATIC_SITE_IMPORTER_MU_LOADER = "/wordpress/wp-content/mu-plugins/wp-codebox-static-site-importer.php"
const MAX_STATIC_SITE_IMPORTER_FILES = 10_000
const MAX_STATIC_SITE_IMPORTER_BYTES = 64 * 1024 * 1024
const UPLOADS_ROOT = "/wordpress/wp-content/uploads"
const MARKDOWN_INDEX_PATH = "/tmp/markdown-index.sqlite"
const MARKDOWN_RESOLVED_INDEX_PATH = "/tmp/markdown-index-8133b4cf3c66.sqlite"
const MARKDOWN_CHANGES_PATH = "/tmp/wp-codebox-canonical-changes.json"
const PUBLICATION_CHANGES_PATH = "/tmp/wp-codebox-publication-changes.json"
const WORDPRESS_PAGE_CACHE_SCHEMA = "v3"
const PUBLIC_WP_CONTENT_EXTENSION = /\.(?:css|js|mjs|json|txt|xml|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/i
const MAX_CRON_EVENTS_PER_INVOCATION = 5
const MAX_CRON_INVOCATION_MS = 25_000
const PUBLICATION_JOB_SCHEMA = "wp-codebox/publication-job/v1"
const PUBLICATION_PROGRESS_SCHEMA = "wp-codebox/publication-progress/v1"
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
const STATIC_ARTIFACT_IMPORT_PATH = "/tmp/wp-codebox-static-artifact.json"
const STATIC_ARTIFACT_IMPORT_INPUT_PATH = "/tmp/wp-codebox-static-artifact-input.json"
const STATIC_ARTIFACT_IMPORT_CODE = `<?php
require '/wordpress/wp-load.php';
wp_set_current_user(1);
$artifact = json_decode((string) file_get_contents('${STATIC_ARTIFACT_IMPORT_PATH}'), true, 512, JSON_THROW_ON_ERROR);
$input = json_decode((string) file_get_contents('${STATIC_ARTIFACT_IMPORT_INPUT_PATH}'), true, 512, JSON_THROW_ON_ERROR);
$records = get_option('wp_codebox_static_artifact_imports', array());
if (!is_array($records)) $records = array();
$key = $input['idempotencyKey'];
if (isset($records[$key])) {
    if (!hash_equals((string) ($records[$key]['fingerprint'] ?? ''), $input['fingerprint'])) {
        echo wp_json_encode(array('status' => 'conflict'), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        return;
    }
    echo wp_json_encode(array_merge(array('status' => 'duplicate'), $records[$key]), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    return;
}
if (count($records) >= 20) {
    echo wp_json_encode(array('status' => 'failed', 'error' => array('code' => 'idempotency_capacity', 'message' => 'Static artifact import idempotency history is full.')), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    return;
}
$ability = function_exists('wp_get_ability') ? wp_get_ability('static-site-importer/import-website-artifact') : null;
if (!$ability) {
    echo wp_json_encode(array('status' => 'failed', 'error' => array('code' => 'ability_unavailable', 'message' => 'Static Site Importer ability is unavailable.')), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    return;
}
$ability_input = array(
    'artifact' => $artifact,
    'slug' => $input['slug'],
    'name' => $input['name'],
    'site_title' => $input['siteTitle'],
    'activate' => true,
    'overwrite' => true,
    'fail_on_quality' => true,
    'source_metadata' => array('provider' => 'wp-codebox-cloudflare', 'artifact_sha256' => $input['artifact']['sha256'], 'artifact_r2_key' => $input['artifact']['r2Key']),
);
$result = $ability->execute($ability_input);
if (is_wp_error($result)) $result = array('success' => false, 'error' => array('code' => $result->get_error_code(), 'message' => $result->get_error_message()));
if (!is_array($result) || empty($result['success']) || !isset($result['result']) || !is_array($result['result'])) {
    $error = is_array($result) && isset($result['error']) && is_array($result['error']) ? $result['error'] : array('code' => 'import_failed', 'message' => 'Static Site Importer failed without a structured error.');
    echo wp_json_encode(array('status' => 'failed', 'error' => $error), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    return;
}
$import = $result['result'];
$quality = isset($import['quality']) && is_array($import['quality']) ? $import['quality'] : array();
$counts = array(
    'fallbackBlocks' => (int) ($quality['fallback_count'] ?? 0),
    'coreHtmlBlocks' => (int) ($quality['core_html_block_count'] ?? 0),
    'freeformBlocks' => (int) ($quality['freeform_block_count'] ?? 0),
    'invalidBlocks' => (int) ($quality['invalid_block_count'] ?? 0),
);
if (empty($quality['pass']) || array_sum($counts) !== 0) {
    echo wp_json_encode(array('status' => 'quality-failed', 'quality' => $counts), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    return;
}
$record = array(
    'idempotencyKey' => $key,
    'fingerprint' => $input['fingerprint'],
    'artifact' => $input['artifact'],
    'themeSlug' => (string) ($import['theme_slug'] ?? ''),
    'pages' => isset($import['pages']) && is_array($import['pages']) ? $import['pages'] : array(),
    'quality' => $counts,
    'importedAt' => gmdate('c'),
    'ability' => 'static-site-importer/import-website-artifact',
    'staticSiteImporterVersion' => defined('STATIC_SITE_IMPORTER_VERSION') ? STATIC_SITE_IMPORTER_VERSION : '',
);
$records[$key] = $record;
update_option('wp_codebox_static_artifact_imports', $records, false);
$GLOBALS['wpdb']->flush_canonical_writes();
echo wp_json_encode(array_merge(array('status' => 'imported'), $record), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);`
export interface RuntimeEnv {
  WORDPRESS_STATE_BUCKET: R2Bucket
  WORDPRESS_SITE_CONTEXTS?: string
  WORDPRESS_PREVIEW_DOMAIN?: string
  WORDPRESS_PREVIEW_HOST_SECRET?: string
  WORDPRESS_ADMIN_PASSWORD?: string
  WORDPRESS_AUTH_SECRET?: string
  WORDPRESS_OPERATOR_TOKEN?: string
  WORDPRESS_API_TOKENS?: string
  WORDPRESS_STATE_DATABASE?: D1Database
  WORDPRESS_RUNTIME_QUEUE?: RuntimeQueue
  WORDPRESS_QUEUE_POLICY?: string
}

export function createCloudflareRuntime<Env extends RuntimeEnv>(
  resolveCoordinator: (env: Env, site: SiteContext) => RevisionCoordinator,
  resolveOperatorCoordinator?: (env: Env, site: SiteContext, selector: string) => RevisionCoordinator | undefined,
  resolveOperations?: (env: Env) => D1OperationRepository | undefined,
) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      // The versioned control API is host-independent and must never boot WordPress.
      if (new URL(request.url).pathname === "/v1" || new URL(request.url).pathname.startsWith("/v1/")) {
        const operations = resolveOperations?.(env)
        if (!operations || !("WORDPRESS_STATE_DATABASE" in env)) return Response.json({ schema: "wp-codebox/provisioning-api/v1", error: { code: "not_found", message: "The API resource is unavailable." } }, { status: 404 })
        return routeProvisioningApi(request, env as Env & { WORDPRESS_STATE_DATABASE: D1Database }, operations)
      }
      let site: SiteContext
      try {
        const contexts = parseSiteContexts(env.WORDPRESS_SITE_CONTEXTS)
        try {
          site = resolveSiteContextFromRequest(request, contexts)
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Unknown site hostname.") throw error
          site = await resolvePreviewSiteContextFromRequest(request, previewDomain(env.WORDPRESS_PREVIEW_DOMAIN, env.WORDPRESS_PREVIEW_HOST_SECRET))
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Unknown site hostname.") return new Response(error.message, { status: 421 })
        throw error
      }
      if (new URL(request.url).pathname === "/wp-cron.php") return new Response("WordPress cron is managed by the Cloudflare scheduled handler.", { status: 404 })
      const publishedResponse = await servePublishedWordPressPage(request, env.WORDPRESS_STATE_BUCKET, site)
      if (publishedResponse) return publishedResponse
      const route = routeWorkerRequest(request)
      const selector = new URL(request.url).searchParams.get("coordinator")
      const selection = selectOperatorCoordinator(resolveCoordinator(env, site), route, selector, (selected) => resolveOperatorCoordinator?.(env, site, selected))
      if (!selection) return new Response("Unsupported operator coordinator selector.", { status: 400 })
      const coordinator = selection.coordinator
      const wpContentResponse = await serveWordPressWpContent(request, env.WORDPRESS_STATE_BUCKET, coordinator, site)
      if (wpContentResponse) return wpContentResponse
      const staticResponse = await serveWordPressStaticAsset(request, env.WORDPRESS_STATE_BUCKET)
      if (staticResponse) return staticResponse
      const uploadResponse = await serveWordPressUpload(request, env.WORDPRESS_STATE_BUCKET, coordinator, site)
      if (uploadResponse) return uploadResponse
      if (env.WORDPRESS_STATE_DATABASE && lifecycleProtectedRoute(route.kind)) {
        try {
          await new CloudflareAllocationLifecycle(env.WORDPRESS_STATE_DATABASE).assertActive(allocationIdentity(site.id))
        } catch {
          return new Response("The allocation is no longer active.", { status: 410 })
        }
      }
      if (route.kind === "operator-reset") return resetCanonicalWordPress(request, env, coordinator, site)
      if (route.kind === "operator-restore") return restoreCanonicalWordPress(request, env, coordinator, site)
      if (route.kind === "operator-adopt") return adoptCanonicalWordPress(request, env, coordinator, site, selection.selected)
      if (route.kind === "operator-fence") return operateCanonicalMutationFence(request, env, coordinator, site, route.action)
      if (route.kind === "operator-static-artifact-import") return importCanonicalStaticArtifact(request, env, coordinator, site, resolveOperations?.(env))
      if (route.kind === "operator-static-artifact-operation") return readStaticArtifactOperation(request, env, site, route.operationId, resolveOperations?.(env))
      if (route.kind === "operator-publish") return publishCanonicalWordPressPages(request, env, coordinator, site)
      if (route.kind === "probe") {
        return runBootProbe(route.phase, env.WORDPRESS_STATE_BUCKET)
      }
      if (route.kind === "r2-state") {
        if (request.method !== "GET") return new Response("WordPress state read requires GET.", { status: 405 })
        return Response.json(await coordinator.state())
      }
      try {
        return await runCoordinatedWordPressRequest(request, env, coordinator, site, route.kind)
      } catch (error) {
        if (error instanceof RevisionConflict) return coordinatorConflictResponse(error)
        throw error
      }
    },
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      if (env.WORDPRESS_STATE_DATABASE) {
        const lifecycle = new CloudflareAllocationLifecycle(env.WORDPRESS_STATE_DATABASE)
        await lifecycle.expire(controller.scheduledTime, 1)
        const deleting = (await lifecycle.pendingDeletions(1, controller.scheduledTime))[0]
        if (deleting) await lifecycle.reclaim(env.WORDPRESS_STATE_BUCKET, deleting.identity, deleting.operationFence, 100, controller.scheduledTime)
      }
      const operations = resolveOperations?.(env)
      // Cron repairs non-transactional producer sends and runs bounded lifecycle work;
      // normal mutations and publications are only entered by Queue delivery.
      if (operations && env.WORDPRESS_RUNTIME_QUEUE) {
        await operations.repairMissingDispatches(32, controller.scheduledTime)
        for (const message of await operations.pendingDispatches(parseRuntimeQueuePolicy(env.WORDPRESS_QUEUE_POLICY), 32)) {
        try { await env.WORDPRESS_RUNTIME_QUEUE.send(message); await operations.deliveredDispatch(message) } catch (error) { await operations.failedDispatch(message, error); console.error("Runtime queue reconciliation is backpressured.", error) }
        }
      }
      // WordPress due events remain a bounded cron responsibility. They do not
      // drain provisioning or publication work, which is Queue-only above.
      const configured = parseSiteContexts(env.WORDPRESS_SITE_CONTEXTS)
      const registered = operations ? await operations.activeSites() : []
      const sites = [...new Map([...configured, ...registered].map((site) => [site.id, site])).values()].sort((left, right) => left.id.localeCompare(right.id))
      if (sites.length) {
        const site = sites[Math.floor(controller.scheduledTime / 60_000) % sites.length]
        console.log(JSON.stringify({ siteId: site.id, ...await runScheduledWordPressCron(env, resolveCoordinator(env, site), site, controller.scheduledTime) }))
      }
    },
    async queue(batch: { messages: QueueDelivery[] }, env: Env): Promise<void> {
      const operations = resolveOperations?.(env)
      if (!operations) { for (const message of batch.messages) message.ack(); return }
      await dispatchQueueBatch(batch.messages, parseRuntimeQueueMessage, async (siteId, messages) => {
        const selected = await operations.selectLaneDispatch(siteId, messages.map(({ value }) => value))
        return selected ? messages.find(({ value }) => value.kind === selected.kind && value.identity === selected.identity) ?? null : null
      }, async ({ raw, value }: ParsedQueueDelivery) => {
        const siteId = value.siteId
        const configured = parseSiteContexts(env.WORDPRESS_SITE_CONTEXTS)
        const registered = await operations.activeSites()
        const site = [...configured, ...registered].find((candidate) => candidate.id === siteId)
        try {
          if (!site || !await operations.matchesGeneration(value.siteId, value.generation)) return "ack"
          if (!await operations.processingDispatch(value)) return "ack"
          const coordinator = resolveCoordinator(env, site)
          const principal = await operations.dispatchPrincipal(value)
          if (!principal) return "ack"
          const result = value.kind === "operation" ? await runStaticArtifactOperation(env, coordinator, site, operations, value.identity, principal) : await drainPublicationJob(env, coordinator, site, operations, value.identity)
          if (result && (result.status === "retryable" || result.status === "pending" || result.status === "rendered")) {
            await operations.retryDispatch(value, new Error(`Dispatch ${result.status}.`))
            return result.status === "rendered" ? "retry" : { retryAfterSeconds: 30 }
          }
          await operations.completeDispatch(value)
          return "ack"
        } catch (error) {
          if (raw.attempts >= 3) { await operations.deadDispatch(value, raw.attempts, error); return "retry" }
          await operations.retryDispatch(value, error)
          return { retryAfterSeconds: 30 }
        }
      })
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
  status: "rendered" | "promoted" | "pending" | "stale" | "failed" | "fenced"
  jobKey: string
  route?: string
}

const cachedRuntimes = new Map<string, { baseRevision: string; promise: Promise<Runtime> }>()
const LEASE_ACQUISITION_TIMEOUT_MS = 100_000

async function resetCanonicalWordPress(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Canonical reset requires POST.", { status: 405 })
  if (!await isAuthorizedOperator(request, env, site)) {
    return new Response("Canonical reset authorization failed.", { status: 401 })
  }
  try {
    await coordinator.reset()
  } catch (error) {
    if (!(error instanceof RevisionConflict)) throw error
    return coordinatorConflictResponse(error)
  }
  await discardCachedRuntime(site.id)
  return Response.json({ reset: true, siteId: site.id })
}

async function restoreCanonicalWordPress(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Canonical restore requires POST.", { status: 405 })
  if (!await isAuthorizedOperator(request, env, site)) {
    return new Response("Canonical restore authorization failed.", { status: 401 })
  }
  let pointer: MarkdownPointer
  try {
    pointer = await request.json<MarkdownPointer>()
  } catch {
    return new Response("Canonical restore requires a JSON pointer.", { status: 400 })
  }
  if (!isCanonicalRestorePointer(pointer, site)) return new Response("Canonical restore pointer is invalid.", { status: 400 })
  const manifest = await readMarkdownManifest(env.WORDPRESS_STATE_BUCKET, pointer, site)
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
    await discardCachedRuntime(site.id)
    return Response.json({ restored: true, ...restored })
  } catch (error) {
    await abortLease(coordinator, request.url, lease)
    throw error
  }
}

async function adoptCanonicalWordPress(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext, requireFence = false): Promise<Response> {
  if (request.method !== "POST") return new Response("Canonical adoption requires POST.", { status: 405 })
  if (!await isAuthorizedOperator(request, env, site)) {
    return new Response("Canonical adoption authorization failed.", { status: 401 })
  }
  let pointer: MarkdownPointer
  let version: number
  let fenceToken: string | undefined
  try {
    const body = await request.json<{ pointer?: unknown; version?: unknown; fenceToken?: unknown }>()
    pointer = body.pointer as MarkdownPointer
    version = body.version as number
    fenceToken = typeof body.fenceToken === "string" ? body.fenceToken : undefined
  } catch {
    return new Response("Canonical adoption requires JSON state.", { status: 400 })
  }
  if (requireFence && !fenceToken) return new Response("Selected coordinator adoption requires its active fence token.", { status: 400 })
  if (!isCanonicalRestorePointer(pointer, site) || !Number.isSafeInteger(version) || version < 1) return new Response("Canonical adoption state is invalid.", { status: 400 })
  const manifest = await readMarkdownManifest(env.WORDPRESS_STATE_BUCKET, pointer, site)
  if (!manifest || manifest.revision !== pointer.revision || manifest.manifestKey !== pointer.manifestKey || manifest.persistedAt !== pointer.persistedAt || !Array.isArray(manifest.files)) {
    return new Response("Canonical adoption manifest is unavailable or inconsistent.", { status: 409 })
  }
  let adopted: { pointer: MarkdownPointer; version: number }
  try {
    adopted = await coordinator.adopt(pointer, version, fenceToken, requireFence)
  } catch (error) {
    if (!(error instanceof RevisionConflict)) throw error
    return coordinatorConflictResponse(error)
  }
  await discardCachedRuntime(site.id)
  return Response.json({ adopted: true, ...adopted })
}

async function operateCanonicalMutationFence(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext, action: "status" | "acquire" | "renew" | "release"): Promise<Response> {
  if ((action === "status" && request.method !== "GET") || (action !== "status" && request.method !== "POST")) {
    return new Response(`Canonical mutation fence ${action} requires ${action === "status" ? "GET" : "POST"}.`, { status: 405 })
  }
  if (!await isAuthorizedOperator(request, env, site)) {
    return new Response("Canonical mutation fence authorization failed.", { status: 401 })
  }
  try {
    if (action === "status") return cutoverStatus(env.WORDPRESS_STATE_BUCKET, coordinator, site)
    const body = await request.json<{ token?: unknown; ttlSeconds?: unknown }>()
    if (action === "release") {
      if (typeof body.token !== "string") return new Response("Canonical mutation fence release requires a token.", { status: 400 })
      await coordinator.releaseFence(body.token)
      return Response.json({ released: true })
    }
    if (!Number.isSafeInteger(body.ttlSeconds)) return new Response("Canonical mutation fence requires an integer ttlSeconds.", { status: 400 })
    const ttlMs = (body.ttlSeconds as number) * 1_000
    let fence: MutationFence
    if (action === "acquire") fence = await coordinator.acquireFence(ttlMs)
    else {
      if (typeof body.token !== "string") return new Response("Canonical mutation fence renewal requires a token.", { status: 400 })
      fence = await coordinator.renewFence(body.token, ttlMs)
    }
    return Response.json({ schema: "wp-codebox/cloudflare-cutover-fence/v1", active: true, token: fence.token, expiresAt: fence.expiresAt })
  } catch (error) {
    if (error instanceof RevisionConflict) return coordinatorConflictResponse(error)
    if (error instanceof SyntaxError) return new Response("Canonical mutation fence requires a JSON body.", { status: 400 })
    throw error
  }
}

async function cutoverStatus(bucket: R2Bucket, coordinator: RevisionCoordinator, site: SiteContext): Promise<Response> {
  const [state, fence] = await Promise.all([coordinator.state(), coordinator.fenceStatus()])
  const receipt = state.pointer && state.version > 0 ? await coordinator.committed(state.version) : null
  const manifest = state.pointer ? await readMarkdownManifest(bucket, state.pointer, site) : null
  let validationError: string | undefined
  let coherent = !state.pointer
  if (state.pointer && receipt && samePointer(receipt, state.pointer) && manifest && samePointer(manifest, state.pointer)) {
    try {
      await readCanonicalRevision(bucket, state.pointer, site)
      coherent = true
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error)
    }
  }
  return Response.json({ schema: "wp-codebox/cloudflare-cutover-status/v1", siteId: site.id, state, receipt, manifest: manifest ? { revision: manifest.revision, manifestKey: manifest.manifestKey, persistedAt: manifest.persistedAt } : null, fence, coherent, validationError }, { status: coherent ? 200 : 409 })
}

function coordinatorConflictResponse(error: RevisionConflict): Response {
  const headers = new Headers()
  if (error.retryAt) headers.set("retry-after", String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))))
  return Response.json({ schema: "wp-codebox/cloudflare-coordinator-conflict/v1", message: error.message, retryAt: error.retryAt }, { status: 409, headers })
}

function samePointer(left: MarkdownPointer, right: MarkdownPointer): boolean {
  return left.revision === right.revision && left.manifestKey === right.manifestKey && left.persistedAt === right.persistedAt
}

async function importCanonicalStaticArtifact(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext, operations?: D1OperationRepository): Promise<Response> {
  if (request.method !== "POST") return new Response("Static artifact import requires POST.", { status: 405 })
  if (!await isAuthorizedOperator(request, env, site)) {
    return new Response("Static artifact import authorization failed.", { status: 401 })
  }
  let input: StaticArtifactImport
  try {
    input = await readStaticArtifactImport(request, env.WORDPRESS_STATE_BUCKET, site)
  } catch (error) {
    if (error instanceof StaticArtifactImportError) return Response.json({ schema: STATIC_ARTIFACT_IMPORT_RESULT_SCHEMA, status: "rejected", error: error.message }, { status: error.status })
    throw error
  }
  if (operations) {
    try {
      const created = await operations.createOrConverge(site, { ...input, artifact: input.artifactReference })
      const dispatch = await dispatchRuntimeWork(env, operations, site, "operation", created.operation.operationId, `operator:${site.id}`)
      return Response.json(await operations.get(site.id, created.operation.operationId) ?? created.operation, { status: 202, headers: { location: `?phase=operator-static-artifact-operation&operationId=${created.operation.operationId}`, "x-wp-codebox-dispatch": dispatch } })
    } catch (error) {
      if (error instanceof OperationConflict) return Response.json({ schema: STATIC_ARTIFACT_IMPORT_RESULT_SCHEMA, status: "conflict", error: error.message }, { status: 409 })
      throw error
    }
  }
  try {
    return await runCoordinatedWordPressRequest(request, env, coordinator, site, "static-artifact-import", input)
  } catch (error) {
    if (!(error instanceof RevisionConflict)) throw error
    const headers = new Headers()
    if (error.retryAt) headers.set("retry-after", String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))))
    return Response.json({ schema: STATIC_ARTIFACT_IMPORT_RESULT_SCHEMA, status: "conflict", error: error.message }, { status: 409, headers })
  }
}

async function readStaticArtifactOperation(request: Request, env: RuntimeEnv, site: SiteContext, operationId: string, operations?: D1OperationRepository): Promise<Response> {
  if (request.method !== "GET") return new Response("Static artifact operation status requires GET.", { status: 405 })
  if (!await isAuthorizedOperator(request, env, site)) return new Response("Static artifact operation authorization failed.", { status: 401 })
  if (!operations) return new Response("Static artifact operation status is unavailable.", { status: 404 })
  const operation = await operations.get(site.id, operationId)
  return operation ? Response.json(operation) : new Response("Static artifact operation is unavailable.", { status: 404 })
}

async function runStaticArtifactOperation(env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext, operations: D1OperationRepository, operationId: string, principal: string): Promise<{ schema: string; status: string; operationId: string } | null> {
  const claimed = await operations.claimOperation(site.id, operationId)
  if (!claimed) {
    const operation = await operations.get(site.id, operationId)
    return operation && ["queued", "running", "retryable"].includes(operation.state) ? { schema: STATIC_ARTIFACT_OPERATION_SCHEMA, status: "pending", operationId } : null
  }
  try {
    if (claimed.prepared) {
      const receipt = await coordinator.committed(claimed.prepared.version)
      if (shouldRecoverPreparedCommit(claimed.prepared, receipt)) {
        await operations.complete(site.id, claimed.operationId, claimed.claimToken, undefined, undefined, site.origin)
        return { schema: STATIC_ARTIFACT_OPERATION_SCHEMA, status: "recovered", operationId: claimed.operationId }
      }
    }
    const heartbeat = async (stage: string, progress: number) => {
      await operations.renew(site.id, claimed.operationId, claimed.claimToken)
      await operations.checkpoint(site.id, claimed.operationId, claimed.claimToken, stage, progress)
    }
    await heartbeat("executing", 10)
    const body = { schema: "wp-codebox/cloudflare-static-artifact-import-request/v1", idempotencyKey: claimed.input.idempotencyKey, artifact: claimed.input.artifact, import: claimed.input.options }
    const input = await readStaticArtifactImport(new Request("https://scheduled.invalid/?phase=operator-static-artifact-import", { method: "POST", body: JSON.stringify(body) }), env.WORDPRESS_STATE_BUCKET, site)
    const response = await runCoordinatedWordPressRequest(new Request("https://scheduled.invalid/?phase=operator-static-artifact-import", { method: "POST" }), env, coordinator, site, "static-artifact-import", input, async () => operations.recordCommit(site.id, claimed.operationId, claimed.claimToken), async (prepared) => operations.prepareCommit(site.id, claimed.operationId, claimed.claimToken, prepared.version, prepared.pointer, prepared.ssiResult, prepared.publicationJobKey), heartbeat)
    const result = await response.json()
    if (!result || typeof result !== "object" || (result as { status?: unknown }).status !== "imported") throw new Error("Static artifact import did not produce an import receipt.")
    const publicationJob = response.headers.get("x-wp-codebox-publication-job") ?? undefined
    await operations.complete(site.id, claimed.operationId, claimed.claimToken, result, publicationJob, site.origin)
    // The operation receipt and coordinator commit are durable before the queue wake-up.
    if (publicationJob) await dispatchRuntimeWork(env, operations, site, "publication", publicationJob, principal)
    return { schema: STATIC_ARTIFACT_OPERATION_SCHEMA, status: "completed", operationId: claimed.operationId }
  } catch (error) {
    try {
      if (error instanceof StaticArtifactImportError || claimed.attempts >= 3) {
        await operations.fail(site.id, claimed.operationId, claimed.claimToken, error)
        return { schema: STATIC_ARTIFACT_OPERATION_SCHEMA, status: "failed", operationId: claimed.operationId }
      }
      await operations.retry(site.id, claimed.operationId, claimed.claimToken, error, Date.now() + 30_000)
      return { schema: STATIC_ARTIFACT_OPERATION_SCHEMA, status: "retryable", operationId: claimed.operationId }
    } catch (transitionError) {
      if (transitionError instanceof OperationConflict) return { schema: STATIC_ARTIFACT_OPERATION_SCHEMA, status: "claim-lost", operationId: claimed.operationId }
      throw transitionError
    }
  }
}

async function dispatchRuntimeWork(env: RuntimeEnv, operations: D1OperationRepository, site: SiteContext, kind: RuntimeQueueMessage["kind"], identity: string, principal: string): Promise<"queued" | "backpressured"> {
  let message: RuntimeQueueMessage | undefined
  try {
    message = await operations.stageDispatch(site, kind, identity, principal)
    if (!await operations.admitDispatch(message, parseRuntimeQueuePolicy(env.WORDPRESS_QUEUE_POLICY))) return "backpressured"
    if (!env.WORDPRESS_RUNTIME_QUEUE) throw new Error("Runtime queue binding is unavailable.")
    await env.WORDPRESS_RUNTIME_QUEUE.send(message)
    await operations.deliveredDispatch(message)
    return "queued"
  } catch (error) {
    if (message) await operations.failedDispatch(message, error)
    console.error("Runtime queue producer is backpressured; reconciliation will retry.", error)
    return "backpressured"
  }
}

function isCanonicalRestorePointer(pointer: unknown, site: SiteContext): pointer is MarkdownPointer {
  if (!pointer || typeof pointer !== "object") return false
  const candidate = pointer as Partial<MarkdownPointer>
  return typeof candidate.revision === "string" && /^[a-f0-9-]{36}$/.test(candidate.revision)
    && candidate.manifestKey === `${siteStorageKeys(site).markdownRevisionPrefix}/${candidate.revision}.json`
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

async function isAuthorizedOperator(request: Request, env: RuntimeEnv, site: SiteContext): Promise<boolean> {
  const authorization = request.headers.get("authorization")
  if (!env.WORDPRESS_OPERATOR_TOKEN || !authorization) return false
  const token = await deriveSiteCredential(env.WORDPRESS_OPERATOR_TOKEN, site.id, "operator-token")
  return secretsMatch(authorization, `Bearer ${token}`)
}

async function servePublishedWordPressPage(request: Request, bucket: R2Bucket, site: SiteContext): Promise<Response | null> {
  if (!isCacheableWordPressPageRequest(request) || new URL(request.url).searchParams.has("phase")) return null
  if (["/wp-content/", "/wp-includes/"].some((prefix) => new URL(request.url).pathname.startsWith(prefix))) return null
  const route = canonicalPublicRoute(request)
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  const cacheRequest = publishedPageCacheRequest(request, site)
  const cached = cache ? await cache.match(cacheRequest) : null
  if (cached) return publishedPageResponse(cached, request.method === "HEAD", "edge")

  const current = await readCurrentPublication(bucket, site)
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

async function publishCanonicalWordPressPages(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Canonical publication requires POST.", { status: 405 })
  if (!await isAuthorizedOperator(request, env, site)) {
    return new Response("Canonical publication authorization failed.", { status: 401 })
  }
  let routes: string[]
  try {
    const body = await request.json<{ routes?: unknown }>()
    routes = normalizePublishedRoutes(body.routes)
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Canonical publication body is invalid.", { status: 400 })
  }
  let lease: RevisionLease
  try {
    lease = await coordinator.acquire()
  } catch (error) {
    if (!(error instanceof RevisionConflict)) throw error
    return coordinatorConflictResponse(error)
  }
  try {
    if (!lease.pointer) return new Response("Canonical publication requires initialized state.", { status: 409 })
    let publishedRoutes: PublishedRevision["routes"]
    publishedRoutes = await Promise.all(routes.map(async (route) => {
      const objectKey = await publishedPageObjectKey(lease.pointer!.revision, route, site)
      const object = await env.WORDPRESS_STATE_BUCKET.get(objectKey)
      if (!object) throw new Error(`Canonical publication route has not been rendered: ${route}.`)
      if (object.size > MAX_PUBLISHED_PAGE_BYTES) throw new Error(`Canonical publication route exceeds its size budget: ${route}.`)
      const snapshot = JSON.parse(await object.text()) as WordPressPageSnapshot
      validateWordPressPageSnapshot(snapshot, lease.pointer!.revision, route)
      return { route, objectKey, canonicalRevision: lease.pointer!.revision }
    }))
    const publication: PublishedRevision = {
      schema: PUBLISHED_REVISION_SCHEMA,
      state: "complete",
      revision: crypto.randomUUID(),
      canonicalRevision: lease.pointer.revision,
      canonicalVersion: lease.version,
      publishedAt: new Date().toISOString(),
      routes: publishedRoutes,
    }
    const serialized = JSON.stringify(publication)
    if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_REVISION_BYTES) return new Response("Canonical publication exceeds its size budget.", { status: 413 })
    lease = await coordinator.renew(lease)
    await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publishedRevisionObjectKey(publication.revision, site), serialized)
    lease = await coordinator.renew(lease)
    await env.WORDPRESS_STATE_BUCKET.put(siteStorageKeys(site).publishedCurrent, serialized, { httpMetadata: { contentType: "application/json" } })
    const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
    if (cache) await Promise.all(routes.map((route) => cache.delete(publishedPageCacheRequest(new Request(new URL(route, site.origin)), site))))
    return Response.json(publication)
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Canonical publication artifacts are invalid.", { status: 409 })
  } finally {
    await abortLease(coordinator, request.url, lease)
  }
}

async function readCurrentPublication(bucket: R2Bucket, site: SiteContext): Promise<CurrentPublication | null> {
  const object = await bucket.get(siteStorageKeys(site).publishedCurrent)
  if (!object) return null
  if (object.size > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Published revision exceeds its size budget.")
  return { publication: validatePublishedRevision(JSON.parse(await object.text()), site), etag: object.etag }
}

async function initializeProvisioningPublication(bucket: R2Bucket, lease: Lease, site: SiteContext): Promise<CurrentPublication> {
  const existing = await readCurrentPublication(bucket, site)
  if (existing) return existing
  if (!lease.pointer) throw new Error("Provisioning publication requires a committed canonical revision.")
  const publication: PublishedRevision = {
    schema: PUBLISHED_REVISION_SCHEMA,
    state: "building",
    revision: crypto.randomUUID(),
    canonicalRevision: lease.pointer.revision,
    canonicalVersion: lease.version,
    publishedAt: new Date().toISOString(),
    routes: [],
  }
  const serialized = JSON.stringify(publication)
  await putImmutableJson(bucket, publishedRevisionObjectKey(publication.revision, site), serialized)
  const created = await bucket.put(siteStorageKeys(site).publishedCurrent, serialized, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } })
  if (created) return { publication, etag: created.etag }
  const winner = await readCurrentPublication(bucket, site)
  if (!winner) throw new Error("Provisioning publication did not produce a current revision.")
  return winner
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
  const upsert = changes.all ? [...new Set([...existing, ...changes.upsert])].sort() : changes.upsert
  const remove = changes.remove.filter((route) => !upsert.includes(route))
  if (new Set([...existing, ...upsert]).size > MAX_PUBLISHED_ROUTES) throw new Error("Incremental publication exceeds its route budget.")
  return { upsert, remove }
}

function publicationJobObjectKey(version: number, revision: string, site: SiteContext): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Publication job coordinator version is invalid.")
  if (!/^[a-f0-9-]{36}$/.test(revision)) throw new Error("Publication job canonical revision is invalid.")
  return `${siteStorageKeys(site).publicationJobPrefix}/${String(version).padStart(20, "0")}-${revision}.json`
}

function publicationProgressObjectKey(job: PublicationJob, site: SiteContext): string {
  return `${siteStorageKeys(site).publicationProgressPrefix}/${job.key.split("/").at(-1)}`
}

function publicationClaimObjectKey(job: PublicationJob, site: SiteContext): string {
  return `${siteStorageKeys(site).publicationClaimPrefix}/${job.key.split("/").at(-1)}`
}

function publicationReceiptObjectKey(job: PublicationJob, site: SiteContext): string {
  return publicationReceiptObjectKeyForJob(job.key, site)
}

function publicationReceiptObjectKeyForJob(jobKey: string, site: SiteContext): string {
  return `${siteStorageKeys(site).publicationReceiptPrefix}/${jobKey.split("/").at(-1)}`
}

async function enqueuePublicationJob(bucket: R2Bucket, lease: Lease, canonical: MarkdownPointer, current: CurrentPublication | null, changes: PublicationChanges, site: SiteContext): Promise<PublicationJob | null> {
  if (!current) return null
  const plan = publicationPlan(current.publication, changes)
  if (!plan.upsert.length && !plan.remove.length) return null
  const coordinatorVersion = lease.version + 1
  const key = publicationJobObjectKey(coordinatorVersion, canonical.revision, site)
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

async function readPublicationJob(bucket: R2Bucket, key: string, site: SiteContext): Promise<PublicationJob> {
  const object = await bucket.get(key)
  if (!object || object.size > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Publication job is unavailable or exceeds its size budget.")
  const job = JSON.parse(await object.text()) as PublicationJob
  if (job.schema !== PUBLICATION_JOB_SCHEMA || job.key !== key || job.key !== publicationJobObjectKey(job.coordinatorVersion, job.canonical?.revision ?? "", site)
    || !isCanonicalRestorePointer(job.canonical, site) || !validatePublicationChanges(job.changes)
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

async function readPublicationProgress(bucket: R2Bucket, job: PublicationJob, site: SiteContext): Promise<PublicationProgress> {
  const object = await bucket.get(publicationProgressObjectKey(job, site))
  if (!object) return { schema: PUBLICATION_PROGRESS_SCHEMA, next: 0, rendered: [] }
  if (object.size > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Publication progress exceeds its size budget.")
  const progress = JSON.parse(await object.text()) as PublicationProgress
  if (progress.schema !== PUBLICATION_PROGRESS_SCHEMA || !Number.isSafeInteger(progress.next) || progress.next < 0
    || !Array.isArray(progress.rendered) || (progress.plan && !isPublicationPlan(progress.plan))
    || (progress.plan && (progress.next > progress.plan.upsert.length || progress.rendered.some((route) => !progress.plan!.upsert.includes(route))))) throw new Error("Publication progress is invalid.")
  return progress
}

async function writePublicationProgress(bucket: R2Bucket, job: PublicationJob, progress: PublicationProgress, site: SiteContext): Promise<void> {
  const serialized = JSON.stringify(progress)
  if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Publication progress exceeds its size budget.")
  await bucket.put(publicationProgressObjectKey(job, site), serialized, { httpMetadata: { contentType: "application/json" } })
}

async function claimPublicationJob(bucket: R2Bucket, job: PublicationJob, site: SiteContext, renewLease: () => Promise<void>): Promise<{ token: string; etag?: string } | null> {
  const key = publicationClaimObjectKey(job, site)
  const existing = await bucket.get(key)
  if (existing && existing.size <= 1_024) {
    const claim = JSON.parse(await existing.text()) as { expiresAt?: unknown }
    if (typeof claim.expiresAt === "number" && claim.expiresAt > Date.now()) return null
  }
  const token = crypto.randomUUID()
  const onlyIf = existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: "*" }
  await renewLease()
  const written = await bucket.put(key, JSON.stringify({ token, expiresAt: Date.now() + PUBLICATION_CLAIM_MS }), { onlyIf, httpMetadata: { contentType: "application/json" } })
  return written ? { token, etag: written.etag } : null
}

async function releasePublicationClaim(bucket: R2Bucket, job: PublicationJob, site: SiteContext, claim: { etag?: string }): Promise<void> {
  // Conditional expiry cannot delete a newer claimant after an expired invocation resumes.
  if (claim.etag) await bucket.put(publicationClaimObjectKey(job, site), JSON.stringify({ expiresAt: 0 }), { onlyIf: { etagMatches: claim.etag }, httpMetadata: { contentType: "application/json" } })
}

async function drainPublicationJob(env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext, operations: D1OperationRepository, jobKey: string): Promise<PublicationInvocationEvidence | null> {
  await reconcilePublicationReceipts(env.WORDPRESS_STATE_BUCKET, site, operations)
  let publicationLease: RevisionLease
  try {
    publicationLease = await coordinator.acquire()
  } catch (error) {
    if (!(error instanceof RevisionConflict)) throw error
    const fence = await coordinator.fenceStatus()
    return { schema: "wp-codebox/cloudflare-publication/v1", status: fence.active ? "fenced" : "pending", jobKey: "coordinator" }
  }
  try {
    return await drainPublicationJobWhileLeased(env, coordinator, site, jobKey, async () => {
      publicationLease = await coordinator.renew(publicationLease)
    }, operations)
  } finally {
    await abortLease(coordinator, site.origin, publicationLease)
  }
}

async function reconcilePublicationReceipts(bucket: R2Bucket, site: SiteContext, operations?: D1OperationRepository): Promise<void> {
  if (!operations) return
  const pending = await operations.pendingPublicationJobs(site.id)
  for (const jobKey of pending) {
    const object = await bucket.get(publicationReceiptObjectKeyForJob(jobKey, site))
    if (!object || object.size > MAX_PUBLISHED_REVISION_BYTES) continue
    let receipt: { status?: unknown; job?: unknown; publication?: unknown }
    try {
      receipt = JSON.parse(await object.text()) as { status?: unknown; job?: unknown; publication?: unknown }
    } catch {
      continue
    }
    if (receipt.job !== jobKey || !["promoted", "superseded", "orphaned"].includes(receipt.status as string)) continue
    await operations.reconcilePublication(site.id, receipt.job, receipt.status as "promoted" | "superseded" | "orphaned", typeof receipt.publication === "string" ? receipt.publication : undefined)
  }
}

async function drainPublicationJobWhileLeased(env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext, jobKey: string, renewLease: () => Promise<void>, operations?: D1OperationRepository): Promise<PublicationInvocationEvidence | null> {
  await assertActiveAllocation(env, site)
  // A Queue body is an authority-bearing immutable job key, never permission to drain another job.
  let exact: PublicationJob
  try { exact = await readPublicationJob(env.WORDPRESS_STATE_BUCKET, jobKey, site) } catch { return null }
  const state = await coordinator.state()
  const committed = await coordinator.committed(exact.coordinatorVersion)
  if (committed?.revision !== exact.canonical.revision || committed.manifestKey !== exact.canonical.manifestKey || committed.persistedAt !== exact.canonical.persistedAt) {
    if (state.version > exact.coordinatorVersion || Date.now() - Date.parse(exact.createdAt) > PUBLICATION_CLAIM_MS) {
      await renewLease()
      await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publicationReceiptObjectKey(exact, site), JSON.stringify({ status: "orphaned", job: exact.key, recordedAt: new Date().toISOString() }))
      await operations?.reconcilePublication(site.id, exact.key, "orphaned")
      await renewLease()
      await env.WORDPRESS_STATE_BUCKET.delete(exact.key)
      return { schema: "wp-codebox/cloudflare-publication/v1", status: "stale", jobKey: exact.key }
    }
    return { schema: "wp-codebox/cloudflare-publication/v1", status: "pending", jobKey: exact.key }
  }
  const job = exact
  const claim = await claimPublicationJob(env.WORDPRESS_STATE_BUCKET, job, site, renewLease)
  if (!claim) return { schema: "wp-codebox/cloudflare-publication/v1", status: "pending", jobKey: job.key }
  let runtime: Runtime | undefined
  try {
    let progress = await readPublicationProgress(env.WORDPRESS_STATE_BUCKET, job, site)
    const current = await readCurrentPublication(env.WORDPRESS_STATE_BUCKET, site)
    const recoveredPromotion = current?.publication.canonicalVersion === job.coordinatorVersion
      && current.publication.canonicalRevision === job.canonical.revision
      && current.publication.sourceJob === job.key
    if (recoveredPromotion) {
      await renewLease()
      await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publicationReceiptObjectKey(job, site), JSON.stringify({ status: "promoted", job: job.key, publication: current.publication.revision, recordedAt: new Date().toISOString() }))
      await operations?.reconcilePublication(site.id, job.key, "promoted", current.publication.revision)
      await renewLease()
      await env.WORDPRESS_STATE_BUCKET.delete([job.key, publicationProgressObjectKey(job, site)])
      return { schema: "wp-codebox/cloudflare-publication/v1", status: "promoted", jobKey: job.key }
    }
    if (!current || current.publication.canonicalVersion >= job.coordinatorVersion) {
      await renewLease()
      await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publicationReceiptObjectKey(job, site), JSON.stringify({ status: "superseded", job: job.key, recordedAt: new Date().toISOString() }))
      await operations?.reconcilePublication(site.id, job.key, "superseded")
      await renewLease()
      await env.WORDPRESS_STATE_BUCKET.delete([job.key, publicationProgressObjectKey(job, site)])
      return { schema: "wp-codebox/cloudflare-publication/v1", status: "stale", jobKey: job.key }
    }
    if (!progress.plan) {
      progress = { ...progress, plan: publicationPlan(current.publication, job.changes) }
      await renewLease()
      await writePublicationProgress(env.WORDPRESS_STATE_BUCKET, job, progress, site)
    }
    const plan = progress.plan
    if (!plan) throw new Error("Publication progress plan is unavailable.")
    if (progress.next < plan.upsert.length) {
      const route = plan.upsert[progress.next]
      const objectKey = await publishedPageObjectKey(job.canonical.revision, route, site)
      let snapshot = await readWordPressPageSnapshot(env.WORDPRESS_STATE_BUCKET, objectKey, job.canonical.revision, route)
      if (!snapshot) {
        runtime = await bootRuntime(env.WORDPRESS_STATE_BUCKET, job.canonical, site.origin, await canonicalWordPressAuthConstants(env, site), false, site)
        const page = (await compilePublicationRoutes(runtime, [route], site.origin))[0]
        snapshot = { schema: PUBLISHED_PAGE_SCHEMA, canonicalRevision: job.canonical.revision, route: page.route, status: page.status, statusText: page.statusText, headers: page.headers, body: page.body }
        const serialized = JSON.stringify(snapshot)
        if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_PAGE_BYTES) throw new Error(`Affected publication artifact exceeds its size budget: ${page.route}.`)
        try {
          await renewLease()
          await putImmutableJson(env.WORDPRESS_STATE_BUCKET, objectKey, serialized)
        } catch (error) {
          if (!await readWordPressPageSnapshot(env.WORDPRESS_STATE_BUCKET, objectKey, job.canonical.revision, route)) throw error
        }
      }
      await renewLease()
      await writePublicationProgress(env.WORDPRESS_STATE_BUCKET, job, { ...progress, next: progress.next + 1, rendered: [...progress.rendered, route] }, site)
      return { schema: "wp-codebox/cloudflare-publication/v1", status: "rendered", jobKey: job.key, route }
    }
    const routes = new Map(current.publication.routes.map((route) => [route.route, route]))
    for (const route of plan.remove) routes.delete(route)
    for (const route of plan.upsert) routes.set(route, { route, objectKey: await publishedPageObjectKey(job.canonical.revision, route, site), canonicalRevision: job.canonical.revision })
    const publication: PublishedRevision = { schema: PUBLISHED_REVISION_SCHEMA, state: "complete", revision: crypto.randomUUID(), canonicalRevision: job.canonical.revision, canonicalVersion: job.coordinatorVersion, sourceJob: job.key, publishedAt: new Date().toISOString(), routes: [...routes.values()].sort((left, right) => left.route.localeCompare(right.route)) }
    const serialized = JSON.stringify(publication)
    if (new TextEncoder().encode(serialized).byteLength > MAX_PUBLISHED_REVISION_BYTES) throw new Error("Incremental publication exceeds its size budget.")
    await renewLease()
    await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publishedRevisionObjectKey(publication.revision, site), serialized)
    await renewLease()
    await assertActiveAllocation(env, site)
    if (!await promoteIncrementalPublication(env.WORDPRESS_STATE_BUCKET, current, { serialized, invalidatedRoutes: [...new Set([...plan.upsert, ...plan.remove])].sort() }, site)) {
      return { schema: "wp-codebox/cloudflare-publication/v1", status: "stale", jobKey: job.key }
    }
    await renewLease()
    await writePublicationProgress(env.WORDPRESS_STATE_BUCKET, job, { ...progress, completedAt: new Date().toISOString() }, site)
    await renewLease()
    await putImmutableJson(env.WORDPRESS_STATE_BUCKET, publicationReceiptObjectKey(job, site), JSON.stringify({ status: "promoted", job: job.key, publication: publication.revision, recordedAt: new Date().toISOString() }))
    await operations?.reconcilePublication(site.id, job.key, "promoted", publication.revision)
    await renewLease()
    await env.WORDPRESS_STATE_BUCKET.delete([job.key, publicationProgressObjectKey(job, site)])
    return { schema: "wp-codebox/cloudflare-publication/v1", status: "promoted", jobKey: job.key }
  } catch (error) {
    console.error("Publication job failed.", error)
    throw error
  } finally {
    if (runtime) await discardRuntime(runtime, site)
    try {
      await renewLease()
      await releasePublicationClaim(env.WORDPRESS_STATE_BUCKET, job, site, claim)
    } catch (error) {
      if (!(error instanceof RevisionConflict)) throw error
    }
  }
}

function lifecycleProtectedRoute(kind: string): boolean {
  return ["wordpress", "r2-mutate", "operator-reset", "operator-restore", "operator-adopt", "operator-fence", "operator-static-artifact-import", "operator-publish"].includes(kind)
}

async function assertActiveAllocation(env: RuntimeEnv, site: SiteContext): Promise<void> {
  if (env.WORDPRESS_STATE_DATABASE) await new CloudflareAllocationLifecycle(env.WORDPRESS_STATE_DATABASE).assertActive(allocationIdentity(site.id))
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

async function promoteIncrementalPublication(bucket: R2Bucket, current: CurrentPublication, staged: { serialized: string; invalidatedRoutes: string[] }, site: SiteContext): Promise<boolean> {
  const promoted = await bucket.put(siteStorageKeys(site).publishedCurrent, staged.serialized, { onlyIf: { etagMatches: current.etag }, httpMetadata: { contentType: "application/json" } })
  if (!promoted) return false
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  if (cache) await Promise.all(staged.invalidatedRoutes.map((route) => cache.delete(publishedPageCacheRequest(new Request(new URL(route, site.origin)), site))))
  return true
}

function publishedPageCacheRequest(request: Request, site: SiteContext): Request {
  return new Request(`https://wp-codebox-publication.invalid/${site.id}${canonicalPublicRoute(request)}`, { method: "GET" })
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

async function runCoordinatedWordPressRequest(request: Request, env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext, route: "wordpress" | "health" | "r2-mutate" | "static-artifact-import", staticArtifactImport?: StaticArtifactImport, onCommitted?: (committed: { pointer: MarkdownPointer; version: number }) => Promise<void>, onPreparedCommit?: (prepared: { pointer: MarkdownPointer; version: number; ssiResult: unknown; publicationJobKey: string | null }) => Promise<void>, heartbeat?: (stage: string, progress: number) => Promise<void>): Promise<Response> {
  if (route === "r2-mutate" && request.method !== "POST") return new Response("WordPress state mutation requires POST.", { status: 405 })
  if (route === "wordpress" && isCacheableWordPressPageRequest(request)) {
    const state = await coordinator.state()
    if (state.pointer) {
      const cachedPage = await matchWordPressPageCache(request, state.pointer, env.WORDPRESS_STATE_BUCKET, site)
      if (cachedPage) return cachedPage
    }
  }
  let lease = await acquireLease(coordinator, request.url)
  let runtime: Runtime | undefined
  let finalized = false
  try {
    if (!lease.pointer) {
      const bootstrapped = await bootstrapCanonicalRuntime(env, coordinator, site, request.url, lease)
      // Bootstrap promotion consumes its lease before login or any other request observes it.
      lease = await acquireLease(coordinator, request.url)
      if (!lease.pointer || lease.pointer.revision !== bootstrapped.pointer.revision) throw new Error("Canonical bootstrap promotion was not observed by its next lease.")
      cacheRuntime(lease.pointer, bootstrapped, site)
    }
    const cachedPage = route === "wordpress" ? await matchWordPressPageCache(request, lease.pointer, env.WORDPRESS_STATE_BUCKET, site) : null
    if (cachedPage) {
      await releaseLease(coordinator, request.url, lease)
      finalized = true
      return cachedPage
    }
    if (route === "static-artifact-import") await heartbeat?.("booting-runtime", 20)
    runtime = await getRuntime(env, lease.pointer, site, route === "static-artifact-import")
    if (route === "static-artifact-import") await heartbeat?.("runtime-ready", 35)
    const mutatesCanonicalState = isMutation(request, route)
    const diagnosticsStartedAt = Date.now()
    const retained = new MutationRetainedBytes()
    let currentPublication = mutatesCanonicalState ? await readCurrentPublication(env.WORDPRESS_STATE_BUCKET, site) : null
    let response: Response | undefined
    let phpResponse: PHPResponseData | undefined
    let responseBodyBytes = 0
    let canonicalChanges: MarkdownChanges | undefined
    let publicationChanges: PublicationChanges | undefined
    if (route === "static-artifact-import") {
      if (!staticArtifactImport) throw new Error("Static artifact import input is unavailable.")
      await heartbeat?.("executing-ssi", 45)
      initializePublicationChanges(runtime.php)
      runtime.php.writeFile(MARKDOWN_CHANGES_PATH, new TextEncoder().encode(JSON.stringify({ created: [], changed: [], deleted: [] })))
      const imported = await runStaticArtifactImport(runtime, staticArtifactImport)
      await heartbeat?.("ssi-completed", 60)
      if (imported.status !== "imported") {
        await discardRuntime(runtime, site)
        runtime = undefined
        await releaseLease(coordinator, request.url, lease)
        finalized = true
        const status = imported.status === "duplicate" ? 200 : imported.status === "conflict" ? 409 : 422
        return Response.json({ schema: STATIC_ARTIFACT_IMPORT_RESULT_SCHEMA, ...imported }, { status })
      }
      response = Response.json({ schema: STATIC_ARTIFACT_IMPORT_RESULT_SCHEMA, ...imported }, { status: 201 })
      canonicalChanges = readCanonicalChanges(runtime.php)
      publicationChanges = readPublicationChanges(runtime.php)
      console.log(JSON.stringify({ schema: "wp-codebox/cloudflare-static-artifact-persistence/v1", canonicalChanges, publicationChanges }))
    } else if (route === "r2-mutate") {
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
      if (route === "static-artifact-import") await heartbeat?.("persisting-canonical", 70)
      const next = await persistRuntime(env.WORDPRESS_STATE_BUCKET, runtime, canonicalChanges, site, diagnosticsStartedAt, retained)
      if (route === "static-artifact-import") await heartbeat?.("canonical-prepared", 80)
      if (!response) {
        if (!phpResponse) throw new Error("WordPress mutation completed without a PHP response.")
        retained.retain(responseBodyBytes)
        response = toFetchResponse(request, phpResponse)
      }
      await discardRuntime(runtime, site)
      runtime = undefined
      if (phpResponse) retained.release(responseBodyBytes)
      if (route === "static-artifact-import" && !currentPublication) currentPublication = await initializeProvisioningPublication(env.WORDPRESS_STATE_BUCKET, lease, site)
      const publicationJob = await enqueuePublicationJob(env.WORDPRESS_STATE_BUCKET, lease, next, currentPublication, publicationChanges, site)
      response.headers.set("x-wp-codebox-publication", publicationJob ? "queued" : "unchanged")
      if (publicationJob) response.headers.set("x-wp-codebox-publication-job", publicationJob.key)
      if (route === "static-artifact-import") {
        await heartbeat?.("preparing-commit", 85)
        await onPreparedCommit?.({ pointer: next, version: lease.version + 1, ssiResult: await response.clone().json(), publicationJobKey: publicationJob?.key ?? null })
        await heartbeat?.("committing", 90)
      }
      const committed = await commitLease(coordinator, request.url, lease, next)
      await onCommitted?.(committed)
      // A pre-commit R2 job is inert; only the observable coordinator receipt may wake it.
      if (publicationJob && env.WORDPRESS_STATE_DATABASE) {
        const operations = new D1OperationRepository(env.WORDPRESS_STATE_DATABASE)
        await dispatchRuntimeWork(env, operations, site, "publication", publicationJob.key, `system:${site.id}`)
      }
      response.headers.set("x-wp-codebox-canonical-revision", committed.pointer.revision)
      response.headers.set("x-wp-codebox-canonical-version", String(committed.version))
      logMutationPhase(diagnosticsStartedAt, "commit", retained, { publication: publicationJob ? "queued" : "unchanged" })
    } else {
      await releaseLease(coordinator, request.url, lease)
    }
    finalized = true
    if (!mutatesCanonicalState && route === "wordpress" && response) response = await cacheWordPressPage(request, lease.pointer, response, env.WORDPRESS_STATE_BUCKET, site)
    if (!response) throw new Error("WordPress request completed without a response.")
    return response
  } catch (error) {
    if (!finalized) await abortLease(coordinator, request.url, lease)
    if (runtime) await discardRuntime(runtime, site)
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

async function matchWordPressPageCache(request: Request, pointer: MarkdownPointer, bucket: R2Bucket, site: SiteContext): Promise<Response | null> {
  if (!isCacheableWordPressPageRequest(request)) return null
  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  try {
    const cached = cache ? await cache.match(wordPressPageCacheKey(request, pointer, site)) : null
    if (cached) return pageCacheResponse(cached, request.method === "HEAD", "hit", "edge")
    const route = canonicalPublicRoute(request)
    const snapshot = await readWordPressPageSnapshot(bucket, await wordPressPageSnapshotKey(request, pointer, site), pointer.revision, route)
    if (!snapshot) return null
    if (snapshot.status !== 200) return null
    const response = new Response(snapshot.body, { status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers })
    if (cache) await cache.put(wordPressPageCacheKey(request, pointer, site), response.clone())
    return pageCacheResponse(response, request.method === "HEAD", "hit", "r2")
  } catch {
    return null
  }
}

async function readWordPressPageSnapshot(bucket: R2Bucket, objectKey: string, canonicalRevision: string, route: string): Promise<WordPressPageSnapshot | null> {
  const object = await bucket.get(objectKey)
  if (!object) return null
  if (object.size > MAX_PUBLISHED_PAGE_BYTES) throw new Error(`Published page artifact exceeds its size budget: ${objectKey}.`)
  const snapshot = JSON.parse(await object.text()) as WordPressPageSnapshot
  validateWordPressPageSnapshot(snapshot, canonicalRevision, route)
  return snapshot
}

async function cacheWordPressPage(request: Request, pointer: MarkdownPointer, response: Response, bucket: R2Bucket, site: SiteContext): Promise<Response> {
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
      cache ? cache.put(wordPressPageCacheKey(request, pointer, site), cacheable.clone()) : Promise.resolve(),
      putImmutableJson(bucket, await wordPressPageSnapshotKey(request, pointer, site), serialized),
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

function wordPressPageCacheKey(request: Request, pointer: MarkdownPointer, site: SiteContext): Request {
  const url = new URL(request.url)
  url.searchParams.set("__wp_codebox_revision", pointer.revision)
  url.searchParams.set("__wp_codebox_page_cache", WORDPRESS_PAGE_CACHE_SCHEMA)
  url.searchParams.set("__wp_codebox_site", site.id)
  return new Request(url, { method: "GET" })
}

async function wordPressPageSnapshotKey(request: Request, pointer: MarkdownPointer, site: SiteContext): Promise<string> {
  return publishedPageObjectKey(pointer.revision, canonicalPublicRoute(request), site)
}

function pageCacheResponse(response: Response, head: boolean, status: "hit" | "miss", source: "edge" | "r2" | "render"): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "public, max-age=60, s-maxage=31536000")
  headers.set("x-wp-codebox-page-cache", status)
  headers.set("x-wp-codebox-page-cache-source", source)
  return new Response(head ? null : response.body, { status: response.status, statusText: response.statusText, headers })
}

function isMutation(request: Request, route: "wordpress" | "health" | "r2-mutate" | "static-artifact-import"): boolean {
  if (route === "r2-mutate" || route === "static-artifact-import" || !["GET", "HEAD", "OPTIONS"].includes(request.method)) return true
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
      if ((await coordinator.fenceStatus()).active) throw error
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

async function getRuntime(env: RuntimeEnv, pointer: MarkdownPointer, site: SiteContext, includeStaticSiteImporter = false): Promise<Runtime> {
  let cachedRuntime = cachedRuntimes.get(site.id)
  if (cachedRuntime && (cachedRuntime.baseRevision !== pointer.revision || includeStaticSiteImporter)) {
    await discardCachedRuntime(site.id)
    cachedRuntime = undefined
  }
  if (!cachedRuntime) {
    const promise = bootRuntime(env.WORDPRESS_STATE_BUCKET, pointer, site.origin, await canonicalWordPressAuthConstants(env, site), includeStaticSiteImporter, site)
    cachedRuntime = { baseRevision: pointer.revision, promise }
    cachedRuntimes.set(site.id, cachedRuntime)
    promise.catch(() => {
      if (cachedRuntimes.get(site.id)?.promise === promise) cachedRuntimes.delete(site.id)
    })
  }
  return cachedRuntime.promise
}

function cacheRuntime(pointer: MarkdownPointer, runtime: Runtime, site: SiteContext): void {
  cachedRuntimes.set(site.id, { baseRevision: pointer.revision, promise: Promise.resolve(runtime) })
}

async function discardCachedRuntime(siteId: string): Promise<void> {
  const cached = cachedRuntimes.get(siteId)
  cachedRuntimes.delete(siteId)
  if (!cached) return
  try {
    await disposeRequestHandler((await cached.promise).requestHandler)
  } catch {
    // A rejected boot has no live runtime to dispose.
  }
}

async function discardRuntime(runtime: Runtime, site: SiteContext): Promise<void> {
  const cachedRuntime = cachedRuntimes.get(site.id)
  if (cachedRuntime?.promise) {
    try {
      if (await cachedRuntime.promise === runtime) cachedRuntimes.delete(site.id)
    } catch {
      cachedRuntimes.delete(site.id)
    }
  }
  await disposeRequestHandler(runtime.requestHandler)
}

async function disposeRequestHandler(requestHandler: PHPRequestHandler): Promise<void> {
  const asyncDispose = (Symbol as unknown as { readonly asyncDispose: symbol }).asyncDispose
  const dispose = (requestHandler as unknown as Record<symbol, () => Promise<void>>)[asyncDispose]
  await dispose.call(requestHandler)
}

async function bootRuntime(bucket: R2Bucket, pointer: MarkdownPointer, origin: string, authConstants: Record<WordPressAuthConstant, string>, includeStaticSiteImporter = false, site: SiteContext = DEFAULT_SITE_CONTEXT): Promise<Runtime> {
  const revision = await readCanonicalRevision(bucket, pointer, site)
  return { ...await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, revision.markdown, new Uint8Array(markdownPrimaryBootstrapIndex), origin, authConstants, bucket, true, revision.uploads, revision.wpContent, revision.wpContentDeleted, includeStaticSiteImporter), pointer }
}

async function bootstrapCanonicalRuntime(env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext, requestUrl: string, lease: Lease): Promise<Runtime> {
  if (!env.WORDPRESS_ADMIN_PASSWORD) throw new Error("WORDPRESS_ADMIN_PASSWORD is required to bootstrap a complete canonical WordPress revision.")
  const origin = site.origin
  const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, await packagedCanonicalMarkdownSeed(), new Uint8Array(markdownPrimaryBootstrapIndex), origin, await canonicalWordPressAuthConstants(env, site), env.WORDPRESS_STATE_BUCKET, true)
  try {
    const passwordFile = "/tmp/wordpress-admin-password"
    const adminPassword = await deriveSiteCredential(env.WORDPRESS_ADMIN_PASSWORD, site.id, "admin-password")
    runtime.php.writeFile(passwordFile, new TextEncoder().encode(adminPassword))
    const passwordOutput = (await runtime.php.run({ code: canonicalBootstrapPasswordCode(passwordFile) })).text.trim()
    if (passwordOutput !== "password-updated") throw new Error("Canonical bootstrap did not update the admin password.")
    const urlOutput = (await runtime.php.run({ code: canonicalBootstrapUrlCode(origin) })).text.trim()
    if (urlOutput !== "urls-updated") throw new Error("Canonical bootstrap did not update the site URLs.")
    const flushOutput = (await runtime.php.run({ code: canonicalBootstrapFlushCode() })).text.trim()
    if (flushOutput !== "flushed") throw new Error("MDI did not confirm canonical bootstrap flush.")
    const pointer = await persistMarkdownRevision(env.WORDPRESS_STATE_BUCKET, collectRuntimeFiles(runtime.php, MARKDOWN_ROOT), site)
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
async function canonicalWordPressAuthConstants(env: RuntimeEnv, site: SiteContext): Promise<Record<WordPressAuthConstant, string>> {
  return deriveWordPressAuthConstants(env.WORDPRESS_AUTH_SECRET ?? "", site.id)
}

async function persistRuntime(bucket: R2Bucket, runtime: Runtime, changes: MarkdownChanges, site: SiteContext, diagnosticsStartedAt = Date.now(), retained = new MutationRetainedBytes()): Promise<MarkdownPointer> {
  validateMarkdownChanges(changes)
  const currentManifest = await readMarkdownManifest(bucket, runtime.pointer, site)
  if (!currentManifest) throw new Error(`R2 Markdown manifest is missing: ${runtime.pointer.manifestKey}`)
  validateUploadManifestFiles(currentManifest.uploads ?? [], site)
  validateWpContentManifestFiles(currentManifest.wpContent ?? [], site)
  validateWpContentDeletedPaths(currentManifest.wpContentDeleted ?? [])
  const changedPaths = [...changes.created, ...changes.changed].sort((left, right) => left.localeCompare(right))
  const uploads = await collectUploadFiles(runtime.php)
  logMutationPhase(diagnosticsStartedAt, "upload-inventory", retained, { files: uploads.length, bytes: sumMetadataBytes(uploads) })
  const uploadManifestFiles = await persistRuntimeObjects(bucket, runtime.php, UPLOADS_ROOT, uploads, currentManifest.uploads ?? [], siteStorageKeys(site).uploadObjectPrefix, retained)
  logMutationPhase(diagnosticsStartedAt, "upload-persist", retained, { files: uploadManifestFiles.length })
  const wpContent = await collectWpContentFiles(runtime.php)
  logMutationPhase(diagnosticsStartedAt, "wp-content-inventory", retained, { files: wpContent.files.length, bytes: sumMetadataBytes(wpContent.files), deleted: wpContent.deleted.length })
  const wpContentManifestFiles = await persistRuntimeObjects(bucket, runtime.php, "/wordpress/wp-content", wpContent.files, currentManifest.wpContent ?? [], siteStorageKeys(site).wpContentObjectPrefix, retained)
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
      const objectKey = `${siteStorageKeys(site).markdownObjectPrefix}/${sha256}`
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
  return persistMarkdownManifest(bucket, files, site, uploadManifestFiles, wpContentManifestFiles, wpContent.deleted)
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

interface StaticArtifactRuntimeResult {
  status: "imported" | "duplicate" | "conflict" | "failed" | "quality-failed"
  fingerprint?: string
  artifact?: { r2Key: string; sha256: string; size: number }
  themeSlug?: string
  pages?: Record<string, number>
  quality?: { fallbackBlocks: number; coreHtmlBlocks: number; freeformBlocks: number; invalidBlocks: number }
  importedAt?: string
  ability?: string
  staticSiteImporterVersion?: string
  error?: { code?: string; message?: string }
}

async function runStaticArtifactImport(runtime: Runtime, input: StaticArtifactImport): Promise<StaticArtifactRuntimeResult> {
  runtime.php.writeFile(STATIC_ARTIFACT_IMPORT_PATH, new TextEncoder().encode(JSON.stringify(input.artifact)))
  runtime.php.writeFile(STATIC_ARTIFACT_IMPORT_INPUT_PATH, new TextEncoder().encode(JSON.stringify({
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
    artifact: input.artifactReference,
    slug: input.options.slug,
    name: input.options.name,
    siteTitle: input.options.siteTitle,
  })))
  const output = (await runtime.php.run({ code: STATIC_ARTIFACT_IMPORT_CODE })).text.trim()
  const result = JSON.parse(output) as StaticArtifactRuntimeResult
  if (!["imported", "duplicate", "conflict", "failed", "quality-failed"].includes(result.status)) throw new Error("Static Site Importer returned an invalid status envelope.")
  return result
}

async function runScheduledWordPressCron(env: RuntimeEnv, coordinator: RevisionCoordinator, site: SiteContext, scheduledTime: number): Promise<CronInvocationEvidence> {
  const started = Date.now()
  const evidence: CronInvocationEvidence = {
    schema: "wp-codebox/cloudflare-cron/v1",
    scheduledTime,
    startedAt: new Date(started).toISOString(),
    completedAt: "",
    events: [],
    status: "completed",
  }
  const requestUrl = `${site.origin}/wp-cron.php?doing_wp_cron=${scheduledTime}`
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
      runtime = await getRuntime(env, lease.pointer, site)
      const event = await runNextCronEvent(runtime)
      if (!event.executed) {
        await releaseLease(coordinator, requestUrl, lease)
        finalized = true
        await discardRuntime(runtime, site)
        break
      }
      const next = await persistRuntime(env.WORDPRESS_STATE_BUCKET, runtime, event.canonicalChanges, site)
      const currentPublication = await readCurrentPublication(env.WORDPRESS_STATE_BUCKET, site)
      await discardRuntime(runtime, site)
      runtime = undefined
      const publicationJob = await enqueuePublicationJob(env.WORDPRESS_STATE_BUCKET, lease, next, currentPublication, event.publicationChanges, site)
      await commitLease(coordinator, requestUrl, lease, next)
      if (publicationJob && env.WORDPRESS_STATE_DATABASE) await dispatchRuntimeWork(env, new D1OperationRepository(env.WORDPRESS_STATE_DATABASE), site, "publication", publicationJob.key, `system:${site.id}`)
      finalized = true
      evidence.events.push({ hook: event.hook, timestamp: event.timestamp, revision: next.revision, publication: publicationJob ? "queued" : "unchanged" })
    } catch (error) {
      if (!finalized) await abortLease(coordinator, requestUrl, lease)
      if (runtime) await discardRuntime(runtime, site)
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

async function readCanonicalRevision(bucket: R2Bucket, pointer: MarkdownPointer, site: SiteContext): Promise<{ markdown: RuntimeFile[]; uploads: RuntimeFile[]; wpContent: RuntimeFile[]; wpContentDeleted: string[] }> {
  if (!isCanonicalRestorePointer(pointer, site)) throw new Error("Canonical pointer belongs to a different site namespace.")
  const manifestObject = await bucket.get(pointer.manifestKey)
  if (!manifestObject) throw new Error(`R2 Markdown manifest is missing: ${pointer.manifestKey}`)
  const manifest = await manifestObject.json<MarkdownManifest>()
  if (!samePointer(manifest, pointer) || !Array.isArray(manifest.files)) throw new Error("Canonical manifest identity is invalid.")
  validateMarkdownManifestFiles(manifest.files, site)
  validateUploadManifestFiles(manifest.uploads ?? [], site)
  validateWpContentManifestFiles(manifest.wpContent ?? [], site)
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

async function persistMarkdownRevision(bucket: R2Bucket, files: RuntimeFile[], site: SiteContext = DEFAULT_SITE_CONTEXT, current?: MarkdownPointer, changes?: MarkdownChanges, uploads: RuntimeFile[] = [], wpContent: RuntimeFile[] = [], wpContentDeleted: string[] = []): Promise<MarkdownPointer> {
  const currentManifest = current ? await readMarkdownManifest(bucket, current, site) : null
  if (current && !currentManifest) throw new Error(`R2 Markdown manifest is missing: ${current.manifestKey}`)
  validateUploadManifestFiles(currentManifest?.uploads ?? [], site)
  validateWpContentManifestFiles(currentManifest?.wpContent ?? [], site)
  validateWpContentDeletedPaths(currentManifest?.wpContentDeleted ?? [])
  validateWpContentDeletedPaths(wpContentDeleted)
  const uploadManifestFiles = await persistUploadObjects(bucket, uploads, currentManifest?.uploads ?? [], site)
  const wpContentManifestFiles = await persistWpContentObjects(bucket, wpContent, currentManifest?.wpContent ?? [], site)
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
      const objectKey = `${siteStorageKeys(site).markdownObjectPrefix}/${sha256}`
      await bucket.put(objectKey, file.bytes)
      manifestFiles.set(path, { path, objectKey, sha256, size: file.bytes.byteLength })
    }
    return persistMarkdownManifest(bucket, [...manifestFiles.values()].sort((left, right) => left.path.localeCompare(right.path)), site, uploadManifestFiles, wpContentManifestFiles, wpContentDeleted)
  }
  const currentFiles = new Map(currentManifest?.files.map((file) => [file.path, file]) ?? [])
  const manifestFiles = await Promise.all(files.map(async (file): Promise<MarkdownManifestFile> => {
    const sha256 = await sha256Hex(file.bytes)
    const existing = currentFiles.get(file.path)
    if (existing?.sha256 === sha256 && existing.size === file.bytes.byteLength) return existing
    const objectKey = `${siteStorageKeys(site).markdownObjectPrefix}/${sha256}`
    if (current || !await bucket.head(objectKey)) await bucket.put(objectKey, file.bytes)
    return { path: file.path, objectKey, sha256, size: file.bytes.byteLength }
  }))
  if (current && currentManifest) {
    if (JSON.stringify(currentManifest.files) === JSON.stringify(manifestFiles) && uploadsUnchanged && wpContentUnchanged && wpContentDeletedUnchanged) return current
  }

  return persistMarkdownManifest(bucket, manifestFiles, site, uploadManifestFiles, wpContentManifestFiles, wpContentDeleted)
}

async function persistUploadObjects(bucket: R2Bucket, files: RuntimeFile[], current: MarkdownManifestFile[], site: SiteContext): Promise<MarkdownManifestFile[]> {
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
    const objectKey = `${siteStorageKeys(site).uploadObjectPrefix}/${sha256}`
    if (!await bucket.head(objectKey)) await bucket.put(objectKey, file.bytes)
    persisted.push({ path: file.path, objectKey, sha256, size: file.bytes.byteLength })
  }
  return persisted
}

async function persistWpContentObjects(bucket: R2Bucket, files: RuntimeFile[], current: MarkdownManifestFile[], site: SiteContext): Promise<MarkdownManifestFile[]> {
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
    const objectKey = `${siteStorageKeys(site).wpContentObjectPrefix}/${sha256}`
    if (!await bucket.head(objectKey)) await bucket.put(objectKey, file.bytes)
    persisted.push({ path: file.path, objectKey, sha256, size: file.bytes.byteLength })
  }
  return persisted
}

function validateUploadFiles(files: RuntimeFile[]): void {
  validateUploadMetadata(files.map((file) => ({ path: file.path, size: file.bytes.byteLength })))
}

async function persistMarkdownManifest(bucket: R2Bucket, files: MarkdownManifestFile[], site: SiteContext, uploads: MarkdownManifestFile[] = [], wpContent: MarkdownManifestFile[] = [], wpContentDeleted: string[] = []): Promise<MarkdownPointer> {
  const revision = crypto.randomUUID()
  const manifestKey = `${siteStorageKeys(site).markdownRevisionPrefix}/${revision}.json`
  const persistedAt = new Date().toISOString()
  const pointer: MarkdownPointer = { revision, manifestKey, persistedAt }
  const manifest: MarkdownManifest = { ...pointer, files, uploads, wpContent, wpContentDeleted }
  await bucket.put(manifestKey, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  })
  return pointer
}

async function readMarkdownManifest(bucket: R2Bucket, pointer: MarkdownPointer, site: SiteContext): Promise<MarkdownManifest | null> {
  if (!isCanonicalRestorePointer(pointer, site)) return null
  const object = await bucket.get(pointer.manifestKey)
  if (!object) return null
  const manifest = await object.json<MarkdownManifest>()
  if (!samePointer(manifest, pointer) || !Array.isArray(manifest.files)) throw new Error("Canonical manifest identity is invalid.")
  validateMarkdownManifestFiles(manifest.files, site)
  validateUploadManifestFiles(manifest.uploads ?? [], site)
  validateWpContentManifestFiles(manifest.wpContent ?? [], site)
  validateWpContentDeletedPaths(manifest.wpContentDeleted ?? [])
  return manifest
}

function validateMarkdownManifestFiles(files: MarkdownManifestFile[], site: SiteContext): void {
  const prefix = `${siteStorageKeys(site).markdownObjectPrefix}/`
  const paths = new Set<string>()
  for (const file of files) {
    if (!file || typeof file !== "object" || !isCanonicalRelativePath(file.path) || paths.has(file.path)
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
      || file.objectKey !== `${prefix}${file.sha256}` || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error("Canonical Markdown manifest files are invalid.")
    }
    paths.add(file.path)
  }
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
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, initialMarkdownFiles(), new Uint8Array(markdownPrimaryBootstrapIndex), PROBE_SITE_URL, {}, bucket)
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
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, initialMarkdownFiles(), new Uint8Array(markdownPrimaryBootstrapIndex), PROBE_SITE_URL, {}, bucket)
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
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, initialMarkdownFiles(), new Uint8Array(markdownPrimaryBootstrapIndex), PROBE_SITE_URL, {}, bucket)
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
      PROBE_SITE_URL,
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
      PROBE_SITE_URL,
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
      PROBE_SITE_URL,
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
  siteUrl = PROBE_SITE_URL,
  authConstants: Partial<Record<WordPressAuthConstant, string>> = {},
  runtimeBucket?: R2Bucket,
  shouldPatchCanonicalRuntimePoliciesAtInit = false,
  uploadFiles?: RuntimeFile[],
  wpContentFiles?: RuntimeFile[],
  wpContentDeleted: string[] = [],
  includeStaticSiteImporter = false,
): Promise<{ php: PHP; requestHandler: PHPRequestHandler; wordpressVersion: string }> {
  if (includeSqlite && !runtimeBucket) throw new Error("SQLite integration artifact requires WORDPRESS_STATE_BUCKET.")
  validateWpContentDeletedPaths(wpContentDeleted)
  const sqliteIntegrationPluginZip = includeSqlite ? readSqliteIntegrationArtifact(runtimeBucket!) : undefined
  const staticSiteImporterZip = includeStaticSiteImporter ? readStaticSiteImporterArtifact(runtimeBucket!) : undefined
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
    hooks: streamWordPressFiles || databaseSeed || markdownFiles || uploadFiles?.length || wpContentFiles?.length || wpContentDeleted.length || includeStaticSiteImporter ? {
      beforeWordPressFiles: streamWordPressFiles || markdownFiles || uploadFiles?.length || wpContentFiles?.length || wpContentDeleted.length || includeStaticSiteImporter ? async (php: PHP) => {
        if (streamWordPressFiles) await materializeWordPressServerFiles(php, runtimeBucket)
        if (staticSiteImporterZip) await materializeStaticSiteImporter(php, await staticSiteImporterZip)
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

function initialMarkdownFiles(siteUrl = PROBE_SITE_URL): RuntimeFile[] {
  const options = [
    { option_id: 1, option_name: "siteurl", option_value: siteUrl, autoload: "on" },
    { option_id: 2, option_name: "home", option_value: siteUrl, autoload: "on" },
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
        if (str_starts_with($path, 'plugins/markdown-database-integration/') || str_starts_with($path, 'plugins/sqlite-database-integration/') || str_starts_with($path, 'plugins/static-site-importer/') || str_starts_with($path, 'mu-plugins/wp-codebox-cloudflare-canonical-changes.php') || str_starts_with($path, 'mu-plugins/wp-codebox-static-site-importer.php')) continue;
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

async function materializeStaticSiteImporter(php: PHP, archive: Uint8Array): Promise<void> {
  const required = new Set([
    "static-site-importer/static-site-importer.php",
    "static-site-importer/vendor/autoload.php",
  ])
  let count = 0
  let total = 0
  for await (const entry of decodeZip(new Blob([Uint8Array.from(archive).buffer]).stream())) {
    if (entry.name.endsWith("/")) continue
    if (!entry.name.startsWith("static-site-importer/") || entry.name.includes("\\") || entry.name.split("/").some((segment: string) => !segment || segment === "." || segment === "..")) {
      throw new Error("Static Site Importer archive contains an invalid path.")
    }
    const bytes = new Uint8Array(await entry.arrayBuffer())
    count++
    total += bytes.byteLength
    if (count > MAX_STATIC_SITE_IMPORTER_FILES || total > MAX_STATIC_SITE_IMPORTER_BYTES) throw new Error("Static Site Importer archive exceeds its extraction budget.")
    const relative = entry.name.slice("static-site-importer/".length)
    const destination = `${STATIC_SITE_IMPORTER_ROOT}/${relative}`
    php.mkdir(destination.slice(0, destination.lastIndexOf("/")))
    php.writeFile(destination, bytes)
    required.delete(entry.name)
  }
  if (required.size) throw new Error(`Static Site Importer archive is missing required files: ${[...required].join(", ")}.`)
  php.mkdir(STATIC_SITE_IMPORTER_MU_LOADER.slice(0, STATIC_SITE_IMPORTER_MU_LOADER.lastIndexOf("/")))
  php.writeFile(STATIC_SITE_IMPORTER_MU_LOADER, new TextEncoder().encode(`<?php
require_once '/wordpress/wp-content/plugins/static-site-importer/static-site-importer.php';`))
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
function wp_codebox_publication_page_route( $post_id ) {
	$uri = get_page_uri( $post_id );
	if ( ! is_string( $uri ) || '' === trim( $uri, '/' ) ) return null;
	return wp_codebox_publication_route( home_url( '/' . user_trailingslashit( trim( $uri, '/' ), 'page' ) ) );
}
function wp_codebox_publication_reconcile_front_page( &$changes, $old_front_id, $new_front_id ) {
	$old_front_id = (int) $old_front_id;
	$new_front_id = (int) $new_front_id;
	if ( $old_front_id && $old_front_id !== $new_front_id ) {
		$old_route = wp_codebox_publication_page_route( $old_front_id );
		if ( $old_route ) $changes['upsert'][] = $old_route;
	}
	if ( $new_front_id ) {
		$new_route = wp_codebox_publication_page_route( $new_front_id );
		if ( $new_route ) {
			$changes['upsert'] = array_values( array_diff( $changes['upsert'], array( $new_route ) ) );
			$changes['remove'][] = $new_route;
		}
		$changes['upsert'][] = '/';
	}
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
add_action( 'updated_option', static function ( $option, $old_value, $value ) {
	if ( in_array( $option, array( 'active_plugins', 'blogname', 'page_for_posts', 'page_on_front', 'permalink_structure', 'show_on_front', 'sidebars_widgets', 'stylesheet', 'template' ), true ) || str_starts_with( $option, 'theme_mods_' ) ) {
		$changes = wp_codebox_publication_read_changes();
		$changes['all'] = true;
		if ( 'page_on_front' === $option && 'page' === get_option( 'show_on_front' ) ) {
			wp_codebox_publication_reconcile_front_page( $changes, $old_value, $value );
		} elseif ( 'show_on_front' === $option ) {
			$front_id = (int) get_option( 'page_on_front' );
			wp_codebox_publication_reconcile_front_page( $changes, 'page' === $old_value ? $front_id : 0, 'page' === $value ? $front_id : 0 );
		}
		wp_codebox_publication_write_changes( $changes );
	}
}, PHP_INT_MAX, 3 );
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

async function readStaticSiteImporterArtifact(bucket: R2Bucket): Promise<Uint8Array> {
  return readRuntimeArchiveArtifact(bucket, staticSiteImporterArtifactManifest as RuntimeArchiveArtifactManifest)
}

async function serveWordPressWpContent(request: Request, bucket: R2Bucket, coordinator: RevisionCoordinator, site: SiteContext): Promise<Response | null> {
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
  const cacheKey = wordPressRevisionCacheKey(request, state.pointer, site)
  if (request.method === "GET" && cache) {
    try {
      const cached = await cache.match(cacheKey)
      if (cached) return cached
    } catch {
      // R2 remains authoritative when the edge cache is unavailable.
    }
  }
  const manifest = await readMarkdownManifest(bucket, state.pointer, site)
  validateWpContentManifestFiles(manifest?.wpContent ?? [], site)
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

async function serveWordPressUpload(request: Request, bucket: R2Bucket, coordinator: RevisionCoordinator, site: SiteContext): Promise<Response | null> {
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
  const cacheKey = wordPressRevisionCacheKey(request, state.pointer, site)
  if (request.method === "GET" && cache) {
    try {
      const cached = await cache.match(cacheKey)
      if (cached) return cached
    } catch {
      // R2 remains authoritative when the edge cache is unavailable.
    }
  }
  const manifest = await readMarkdownManifest(bucket, state.pointer, site)
  validateUploadManifestFiles(manifest?.uploads ?? [], site)
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

function wordPressRevisionCacheKey(request: Request, pointer: MarkdownPointer, site: SiteContext): Request {
  const url = new URL(request.url)
  url.searchParams.set("__wp_codebox_revision", pointer.revision)
  url.searchParams.set("__wp_codebox_site", site.id)
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
