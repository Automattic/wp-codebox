import { loadPHPRuntime, PHP, type PHPRequestHandler } from "@php-wasm/universal"
import { decodeRemoteZip, decodeZip } from "@php-wasm/stream-compression"
import { bootWordPressAndRequestHandler, type WordPressInstallMode } from "@wp-playground/wordpress"
// The PHP-WASM package publishes this Emscripten loader without TypeScript declarations.
// @ts-expect-error The adjacent Wasm declaration covers the compiled binary import.
import { dependenciesTotalSize, init } from "../../../node_modules/@php-wasm/web-8-5/asyncify/php_8_5.js"
import phpWasmModule from "../../../node_modules/@php-wasm/web-8-5/asyncify/8_5_8/php_8_5.wasm"
import { CLOUDFLARE_RUNTIME_HEALTH_MARKER, CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, cloudflareRuntimeHealthResponse } from "./health-envelope.js"
import { routeWorkerRequest } from "./request-routing.js"
import { toFetchResponse, toPHPRequest } from "./request-translation.js"
import markdownDatabaseIntegrationRuntime from "../assets/markdown-database-integration-runtime.zip"
import canonicalMarkdownSeed from "../assets/markdown-database-integration-canonical-seed.zip"
import canonicalMarkdownSeedManifest from "../assets/markdown-database-integration-canonical-seed.json" with { type: "json" }
import markdownPrimaryBootstrapIndex from "../assets/markdown-primary-bootstrap-index.sqlite"
import wordpressInstallSeed from "../assets/wordpress-install-seed.sqlite"

const PHP_VERSION = "8.5.8"
const WORDPRESS_ARCHIVE_URL = "https://wordpress.org/latest.zip"
const SQLITE_INTEGRATION_ARCHIVE_URL = "https://github.com/WordPress/sqlite-database-integration/releases/download/v2.2.23/plugin-sqlite-database-integration.zip"
const MARKDOWN_DATABASE_INTEGRATION_REVISION = "1870fb41279e7eb5946e506c9c7406f1f1ea6dc3"
const SITE_URL = "https://wp-codebox-runtime.invalid"
const DATABASE_PATH = "/wordpress/wp-content/database/.ht.sqlite"
const MARKDOWN_ROOT = "/wordpress/wp-content/markdown"
const MARKDOWN_INDEX_PATH = "/tmp/markdown-index.sqlite"
const MARKDOWN_RESOLVED_INDEX_PATH = "/tmp/markdown-index-8133b4cf3c66.sqlite"
const R2_MARKDOWN_POINTER_KEY = "sites/default/markdown/current.json"
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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = routeWorkerRequest(request)
    if (route.kind === "probe") return runBootProbe(route.phase)
    return env.WORDPRESS_STATE.getByName("default").fetch(request)
  },
}

interface MarkdownPointer {
  revision: string
  manifestKey: string
  persistedAt: string
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

export class WordPressStateCoordinator implements DurableObject {
  private tail: Promise<void> = Promise.resolve()
  private runtimePromise: Promise<{ php: PHP; requestHandler: PHPRequestHandler; wordpressVersion: string; pointer: MarkdownPointer }> | undefined

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  fetch(request: Request): Promise<Response> {
    const response = this.tail
      .then(() => this.handleRequest(request))
      .catch((error: unknown) => Response.json({
        schema: "wp-codebox/cloudflare-wordpress-state-error/v1",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }, { status: 500 }))
    this.tail = response.then(() => undefined, () => undefined)
    return response
  }

  private async handleRequest(request: Request): Promise<Response> {
    const route = routeWorkerRequest(request)
    if (route.kind === "r2-state") {
      if (request.method !== "GET") return new Response("WordPress state read requires GET.", { status: 405 })
      const pointer = await readMarkdownPointer(this.env.WORDPRESS_STATE_BUCKET)
      return Response.json({
        schema: "wp-codebox/cloudflare-wordpress-state/v1",
        durableObjectId: this.state.id.toString(),
        pointer,
      })
    }
    if (route.kind === "r2-mutate") {
      if (request.method !== "POST") return new Response("WordPress state mutation requires POST.", { status: 405 })
      return this.runSyntheticMutation(new URL(request.url).origin)
    }
    const runtime = await this.getRuntime(new URL(request.url).origin)
    if (route.kind === "health") return this.health(runtime)
    const response = toFetchResponse(request, await runtime.requestHandler.request(await toPHPRequest(request)))
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) await this.persistRuntime(runtime)
    return response
  }

  private async getRuntime(origin: string) {
    const runtime = this.runtimePromise ?? this.bootRuntime(origin)
    this.runtimePromise = runtime
    try {
      return await runtime
    } catch (error) {
      if (this.runtimePromise === runtime) this.runtimePromise = undefined
      throw error
    }
  }

  private async bootRuntime(origin: string) {
    const pointer = await readMarkdownPointer(this.env.WORDPRESS_STATE_BUCKET)
    if (pointer && await isCompleteMarkdownRevision(this.env.WORDPRESS_STATE_BUCKET, pointer)) {
      return { ...await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, await readMarkdownRevision(this.env.WORDPRESS_STATE_BUCKET, pointer), new Uint8Array(markdownPrimaryBootstrapIndex), origin), pointer }
    }
    if (!this.env.WORDPRESS_ADMIN_PASSWORD) throw new Error("WORDPRESS_ADMIN_PASSWORD is required to bootstrap a complete canonical WordPress revision.")
    const files = await packagedCanonicalMarkdownSeed()
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, files, new Uint8Array(markdownPrimaryBootstrapIndex), origin)
    try {
      const passwordFile = "/tmp/wordpress-admin-password"
      runtime.php.writeFile(passwordFile, new TextEncoder().encode(this.env.WORDPRESS_ADMIN_PASSWORD))
      const output = (await runtime.php.run({ code: canonicalBootstrapSetupCode(passwordFile, origin) })).text.trim()
      if (output !== "flushed") throw new Error("MDI did not confirm canonical bootstrap flush.")
      const nextPointer = await persistMarkdownRevision(this.env.WORDPRESS_STATE_BUCKET, collectRuntimeFiles(runtime.php, MARKDOWN_ROOT))
      await this.env.WORDPRESS_STATE_BUCKET.put(R2_MARKDOWN_POINTER_KEY, JSON.stringify(nextPointer), { httpMetadata: { contentType: "application/json" } })
      return { ...runtime, pointer: nextPointer }
    } catch (error) {
      runtime.php.exit()
      throw error
    }
  }

  private async persistRuntime(runtime: { php: PHP; pointer: MarkdownPointer }): Promise<void> {
    const output = (await runtime.php.run({ code: "<?php require '/wordpress/wp-load.php'; $GLOBALS['wpdb']->flush_canonical_writes(); echo 'flushed';" })).text.trim()
    if (output !== "flushed") throw new Error("MDI did not confirm its canonical flush.")
    const next = await persistMarkdownRevision(this.env.WORDPRESS_STATE_BUCKET, collectRuntimeFiles(runtime.php, MARKDOWN_ROOT), runtime.pointer)
    if (next.revision !== runtime.pointer.revision) {
      await this.env.WORDPRESS_STATE_BUCKET.put(R2_MARKDOWN_POINTER_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } })
      runtime.pointer = next
    }
  }

  private async runSyntheticMutation(origin: string): Promise<Response> {
    const runtime = await this.getRuntime(origin)
    const mutationOutput = (await runtime.php.run({ code: SERIALIZED_MARKDOWN_MUTATION_CODE })).text.trim()
    const mutation = JSON.parse(mutationOutput) as { revisionValue: number; previousPostFound: boolean; postId: number; wordpressVersion: string; canonicalChanges: MarkdownChanges }
    validateMarkdownChanges(mutation.canonicalChanges)
    await this.persistRuntime(runtime)
    return Response.json({ schema: "wp-codebox/cloudflare-wordpress-mutation/v1", source: "durable-object-primary-runtime", ...mutation, canonicalFiles: collectRuntimeFiles(runtime.php, MARKDOWN_ROOT).length, markdownDatabaseIntegrationRevision: MARKDOWN_DATABASE_INTEGRATION_REVISION, sqlitePersisted: false, pointer: runtime.pointer })
  }

  private async health(runtime: { php: PHP; wordpressVersion: string }): Promise<Response> {
    const phpVersion = (await runtime.php.run({ code: "<?php echo PHP_VERSION;" })).text.trim()
    return cloudflareRuntimeHealthResponse({ schema: CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, marker: CLOUDFLARE_RUNTIME_HEALTH_MARKER, wordpressVersion: runtime.wordpressVersion, phpVersion, runtime: { backend: "wordpress-playground", environment: "wordpress" }, evidence: { initialization: "completed", execution: "completed", initializationScope: "isolate" } })
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

async function readMarkdownPointer(bucket: R2Bucket): Promise<MarkdownPointer | null> {
  const object = await bucket.get(R2_MARKDOWN_POINTER_KEY)
  return object ? object.json<MarkdownPointer>() : null
}

async function readMarkdownRevision(bucket: R2Bucket, pointer: MarkdownPointer): Promise<RuntimeFile[]> {
  const manifestObject = await bucket.get(pointer.manifestKey)
  if (!manifestObject) throw new Error(`R2 Markdown manifest is missing: ${pointer.manifestKey}`)
  const manifest = await manifestObject.json<MarkdownManifest>()
  const files: RuntimeFile[] = []
  for (const file of manifest.files) {
    const object = await bucket.get(file.objectKey)
    if (!object) throw new Error(`R2 Markdown object is missing: ${file.objectKey}`)
    files.push({ path: file.path, bytes: new Uint8Array(await object.arrayBuffer()) })
  }
  return files
}

async function persistMarkdownRevision(bucket: R2Bucket, files: RuntimeFile[], current?: MarkdownPointer): Promise<MarkdownPointer> {
  const manifestFiles: MarkdownManifestFile[] = []
  for (const file of files) {
    const sha256 = await sha256Hex(file.bytes)
    const objectKey = `${R2_MARKDOWN_OBJECT_PREFIX}/${sha256}`
    if (!await bucket.head(objectKey)) await bucket.put(objectKey, file.bytes)
    manifestFiles.push({ path: file.path, objectKey, sha256, size: file.bytes.byteLength })
  }
  if (current) {
    const currentManifest = await readMarkdownManifest(bucket, current)
    if (currentManifest && JSON.stringify(currentManifest.files) === JSON.stringify(manifestFiles)) return current
  }

  const revision = crypto.randomUUID()
  const manifestKey = `${R2_MARKDOWN_REVISION_PREFIX}/${revision}.json`
  const persistedAt = new Date().toISOString()
  const pointer: MarkdownPointer = { revision, manifestKey, persistedAt }
  const manifest: MarkdownManifest = { ...pointer, files: manifestFiles }
  await bucket.put(manifestKey, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  })
  return pointer
}

async function readMarkdownManifest(bucket: R2Bucket, pointer: MarkdownPointer): Promise<MarkdownManifest | null> {
  const object = await bucket.get(pointer.manifestKey)
  return object ? object.json<MarkdownManifest>() : null
}

async function isCompleteMarkdownRevision(bucket: R2Bucket, pointer: MarkdownPointer): Promise<boolean> {
  const manifest = await readMarkdownManifest(bucket, pointer)
  if (!manifest || manifest.revision !== pointer.revision) return false
  const paths = new Set(manifest.files.map((file) => file.path))
  if (!["_options/siteurl.json", "_options/home.json", "_tables/users.json", "_tables/usermeta.json", "_tables/terms.json", "_tables/term_taxonomy.json", "_tables/termmeta.json", "_tables/postmeta.json", "_tables/term_relationships.json", "_tables/comments.json", "_tables/commentmeta.json", "_tables/links.json"].every((path) => paths.has(path)) || !manifest.files.some((file) => file.path.endsWith(".md"))) return false
  const users = manifest.files.find((file) => file.path === "_tables/users.json")
  const usermeta = manifest.files.find((file) => file.path === "_tables/usermeta.json")
  if (!users || !usermeta) return false
  const [usersObject, usermetaObject] = await Promise.all([bucket.get(users.objectKey), bucket.get(usermeta.objectKey)])
  if (!usersObject || !usermetaObject) return false
  const [usersRows, usermetaRows] = await Promise.all([
    usersObject.json<Array<{ ID?: number; user_login?: string }>>(),
    usermetaObject.json<Array<{ user_id?: number }>>(),
  ])
  const admin = usersRows.find((row) => row.user_login === "admin")
  return Boolean(admin?.ID && usermetaRows.some((row) => row.user_id === admin.ID))
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

async function runBootProbe(phase: string): Promise<Response> {
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
      const evidence = await materializeWordPressServerFiles(php)
      const wordpressVersion = (await php.run({ code: "<?php require '/wordpress/wp-includes/version.php'; echo $wp_version;" })).text.trim()
      return probeResponse(phase, { ...evidence, wordpressVersion })
    } finally {
      php.exit()
    }
  }

  if (phase === "mdi-files") {
    const php = new PHP(await createPhpRuntime())
    try {
      const wordpress = await materializeWordPressServerFiles(php)
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
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, initialMarkdownFiles(), new Uint8Array(markdownPrimaryBootstrapIndex))
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
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, initialMarkdownFiles(), new Uint8Array(markdownPrimaryBootstrapIndex))
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
    const runtime = await bootWordPressRuntime("do-not-attempt-installing", true, true, undefined, initialMarkdownFiles(), new Uint8Array(markdownPrimaryBootstrapIndex))
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
): Promise<{ php: PHP; requestHandler: PHPRequestHandler; wordpressVersion: string }> {
  const requestHandler = await bootWordPressAndRequestHandler({
    createPhpRuntime,
    constants: {
      AUTOMATIC_UPDATER_DISABLED: true,
      DISABLE_WP_CRON: true,
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
    hooks: streamWordPressFiles || databaseSeed || markdownFiles ? {
      beforeWordPressFiles: streamWordPressFiles || markdownFiles ? async (php: PHP) => {
        if (streamWordPressFiles) await materializeWordPressServerFiles(php)
        if (markdownFiles) {
          await materializeMarkdownDatabaseIntegration(php)
          materializeRuntimeFiles(php, MARKDOWN_ROOT, markdownFiles)
          if (markdownIndexSeed) php.writeFile(MARKDOWN_RESOLVED_INDEX_PATH, markdownIndexSeed)
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

function collectRuntimeFiles(php: PHP, root: string): RuntimeFile[] {
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

function archiveRelativePath(path: string): string {
  const separator = path.indexOf("/")
  return separator === -1 ? "" : path.slice(separator + 1)
}

async function materializeWordPressServerFiles(php: PHP): Promise<{ materializedFiles: number; materializedBytes: number }> {
  const decoder = new TextDecoder()
  let materializedFiles = 0
  let materializedBytes = 0
  const stream = await decodeRemoteZip(WORDPRESS_ARCHIVE_URL, (entry: { path: Uint8Array }) => isWordPressServerFile(decoder.decode(entry.path)))
  const reader = stream.getReader()
  while (true) {
    const { done, value: entry } = await reader.read()
    if (done) break
    const path = entry instanceof File ? entry.name : decoder.decode(entry.path)
    if (!isWordPressServerFile(path) || path.endsWith("/")) continue

    const destination = `/${path}`
    const bytes = entry instanceof File ? new Uint8Array(await entry.arrayBuffer()) : entry.bytes
    php.mkdir(destination.slice(0, destination.lastIndexOf("/")))
    php.writeFile(destination, bytes)
    materializedFiles++
    materializedBytes += bytes.byteLength
  }
  return { materializedFiles, materializedBytes }
}

function isWordPressServerFile(path: string): boolean {
  if (path.startsWith("wordpress/wp-admin/")) return true
  return /\.(?:php|json|crt|html|css|js|mjs|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/.test(path)
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
