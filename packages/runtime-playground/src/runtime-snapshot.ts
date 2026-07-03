import { readFile } from "node:fs/promises"
import { RUNTIME_EPISODE_SNAPSHOT_SCHEMA, runtimeEpisodeDigest, type MountSpec, type RuntimeCreateSpec, type RuntimeInfo, type Snapshot } from "@automattic/wp-codebox-core"
import { isPlainObject as isRecord, sha256StableJson } from "@automattic/wp-codebox-core/internals"
import { playgroundRuntimeCommandIds } from "./command-router.js"
import type { PlaygroundCliServer } from "./preview-server.js"

export interface RuntimeSnapshotArtifact {
  schema: "wp-codebox/wordpress-runtime-snapshot/v1"
  version: 1
  id: string
  createdAt: string
  compatibility: {
    backend: "wordpress-playground"
    wordpressVersion: string
    phpVersion: string
  }
  metadata: {
    runtime: RuntimeInfo
    mounts: MountSpec[]
    mountedInputs: Array<Record<string, unknown>>
    activeTheme: string
    activePlugins: string[]
    wpContentPath: string
    skippedWpContentPaths?: string[]
  }
  database: {
    tables: Array<{
      name: string
      createSql: string
      rows: Array<Record<string, unknown>>
      rowCount: number
    }>
  }
  files: Array<{
    scope: "wp-content"
    path: string
    bytes: number
    sha256: string
    base64: string
  }>
  hashes: {
    database: { algorithm: "sha256"; value: string }
    files: { algorithm: "sha256"; value: string }
  }
}

export class PlaygroundSnapshotRestoreError extends Error {
  readonly code = "wp-codebox-playground-snapshot-restore-failed"

  constructor(message: string) {
    super(message)
    this.name = "PlaygroundSnapshotRestoreError"
  }
}

export function contentDigest(value: unknown): { algorithm: "sha256"; value: string } {
  return { algorithm: "sha256", value: sha256StableJson(value) }
}

export function snapshotDigest(snapshot: Snapshot): { algorithm: "sha256"; value: string } {
  return runtimeEpisodeDigest({
    schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    semantics: snapshot.semantics,
    metadata: snapshot.metadata,
    artifactRefs: snapshot.artifactRefs ?? [],
  })
}

export function runtimeSpecFromSnapshot(snapshot: Snapshot): RuntimeCreateSpec {
  const runtime = snapshot.metadata.runtime
  if (!isRuntimeInfo(runtime)) {
    throw new PlaygroundSnapshotRestoreError("Snapshot metadata does not include a compatible runtime description.")
  }

  return {
    backend: "wordpress-playground",
    environment: runtime.environment,
    policy: { network: "deny", filesystem: "readwrite-mounts", commands: [...playgroundRuntimeCommandIds()], secrets: "none", approvals: "never" },
  }
}

export function mountsFromSnapshot(snapshot: Snapshot): MountSpec[] {
  return Array.isArray(snapshot.metadata.mounts) ? snapshot.metadata.mounts.filter(isMountSpec) : []
}

export async function runtimeSnapshotPayload(snapshot: Snapshot): Promise<RuntimeSnapshotArtifact> {
  if (snapshot.schema && snapshot.schema !== RUNTIME_EPISODE_SNAPSHOT_SCHEMA) {
    throw new PlaygroundSnapshotRestoreError(`Unsupported snapshot schema: ${snapshot.schema}`)
  }

  if (snapshot.semantics !== "runtime-state-artifact") {
    throw new PlaygroundSnapshotRestoreError(`Snapshot is not a runtime-state artifact: ${snapshot.semantics ?? "metadata-only"}`)
  }

  const embedded = snapshot.metadata.payload
  if (isRuntimeSnapshotArtifact(embedded)) {
    return embedded
  }

  const artifact = snapshot.metadata.artifact
  if (isRecord(artifact) && typeof artifact.absolutePath === "string") {
    const payload = JSON.parse(await readFile(artifact.absolutePath, "utf8"))
    if (isRuntimeSnapshotArtifact(payload)) {
      return payload
    }
  }

  throw new PlaygroundSnapshotRestoreError("Snapshot does not include a readable runtime snapshot artifact payload.")
}

export interface RuntimeSnapshotExportOptions {
  excludedWpContentPaths?: string[]
  includedWpContentPaths?: string[]
  includedDatabaseTables?: string[]
  excludedDatabaseTables?: string[]
  includedOptionNames?: string[]
  includedPostTypes?: string[]
}

export type RuntimeSnapshotArtifactBody = Omit<RuntimeSnapshotArtifact, "schema" | "version" | "id" | "createdAt" | "hashes">
type RuntimeSnapshotTable = RuntimeSnapshotArtifact["database"]["tables"][number]
type RuntimeSnapshotFile = RuntimeSnapshotArtifact["files"][number]

interface RuntimeSnapshotExportManifest {
  schema: "wp-codebox/wordpress-runtime-snapshot-export-manifest/v1"
  compatibility: RuntimeSnapshotArtifact["compatibility"]
  metadata: Omit<RuntimeSnapshotArtifact["metadata"], "runtime" | "mounts" | "mountedInputs">
  database: {
    tables: Array<{
      name: string
      createSql: string
      rowCount: number
      chunks: string[]
    }>
  }
  files: {
    ndjsonPath: string
  }
}

export async function runtimeSnapshotExportPayload(server: PlaygroundCliServer, responseText: string): Promise<RuntimeSnapshotArtifactBody> {
  const manifest = parseRuntimeSnapshotExportManifest(responseText)
  const readFileAsText = server.playground.readFileAsText
  if (!readFileAsText) {
    throw new PlaygroundSnapshotRestoreError("Runtime snapshot export requires Playground readFileAsText support.")
  }

  const tables: RuntimeSnapshotTable[] = []
  for (const table of manifest.database.tables) {
    const rows: RuntimeSnapshotTable["rows"] = []
    for (const chunkPath of table.chunks) {
      const chunkRows = JSON.parse(await readFileAsText(chunkPath))
      if (!Array.isArray(chunkRows)) {
        throw new PlaygroundSnapshotRestoreError(`Runtime snapshot table chunk is not an array: ${chunkPath}`)
      }
      rows.push(...chunkRows.filter(isRecord))
    }
    tables.push({ name: table.name, createSql: table.createSql, rows, rowCount: table.rowCount })
  }

  const files: RuntimeSnapshotFile[] = []
  const fileLines = (await readFileAsText(manifest.files.ndjsonPath)).split("\n")
  for (const line of fileLines) {
    if (line.trim().length === 0) {
      continue
    }
    const file = JSON.parse(line)
    if (!isRuntimeSnapshotFile(file)) {
      throw new PlaygroundSnapshotRestoreError("Runtime snapshot file manifest contains an invalid file entry.")
    }
    files.push(file)
  }

  return {
    compatibility: manifest.compatibility,
    metadata: {
      ...manifest.metadata,
      runtime: null as never,
      mounts: [],
      mountedInputs: [],
    },
    database: { tables },
    files,
  }
}

function isRuntimeSnapshotFile(value: unknown): value is RuntimeSnapshotFile {
  return isRecord(value)
    && value.scope === "wp-content"
    && typeof value.path === "string"
    && typeof value.bytes === "number"
    && typeof value.sha256 === "string"
    && typeof value.base64 === "string"
}

function parseRuntimeSnapshotExportManifest(responseText: string): RuntimeSnapshotExportManifest {
  const manifest = JSON.parse(responseText || "{}") as RuntimeSnapshotExportManifest
  if (!isRuntimeSnapshotExportManifest(manifest)) {
    throw new PlaygroundSnapshotRestoreError("Runtime snapshot export did not return a supported manifest.")
  }

  return manifest
}

function isRuntimeSnapshotExportManifest(value: unknown): value is RuntimeSnapshotExportManifest {
  if (!isRecord(value) || value.schema !== "wp-codebox/wordpress-runtime-snapshot-export-manifest/v1") {
    return false
  }

  if (!isRecord(value.compatibility) || value.compatibility.backend !== "wordpress-playground") {
    return false
  }

  if (!isRecord(value.metadata) || !isRecord(value.database) || !Array.isArray(value.database.tables) || !isRecord(value.files) || typeof value.files.ndjsonPath !== "string") {
    return false
  }

  return value.database.tables.every((table) => isRecord(table)
    && typeof table.name === "string"
    && typeof table.createSql === "string"
    && typeof table.rowCount === "number"
    && Array.isArray(table.chunks)
    && table.chunks.every((chunkPath) => typeof chunkPath === "string"))
}

export function runtimeSnapshotExportPhp(options: RuntimeSnapshotExportOptions = {}): string {
  const excludedWpContentPaths = JSON.stringify(normalizeWpContentPathList(["database", ...(options.excludedWpContentPaths ?? [])]))
  const includedWpContentPaths = JSON.stringify(normalizeWpContentPathList(options.includedWpContentPaths ?? []))
  const includedDatabaseTables = JSON.stringify(normalizeStringList(options.includedDatabaseTables ?? []))
  const excludedDatabaseTables = JSON.stringify(normalizeStringList(options.excludedDatabaseTables ?? []))
  const includedOptionNames = JSON.stringify(normalizeStringList(options.includedOptionNames ?? []))
  const includedPostTypes = JSON.stringify(normalizeStringList(options.includedPostTypes ?? []))
  return [String.raw`
@ini_set( 'memory_limit', '512M' );

global $wpdb;

$wp_codebox_snapshot_excluded_wp_content_paths = json_decode(<<<'WP_CODEBOX_EXCLUDED_WP_CONTENT_PATHS'
`, excludedWpContentPaths, String.raw`
WP_CODEBOX_EXCLUDED_WP_CONTENT_PATHS
, true );
if ( ! is_array( $wp_codebox_snapshot_excluded_wp_content_paths ) ) {
    $wp_codebox_snapshot_excluded_wp_content_paths = array();
}

$wp_codebox_snapshot_included_wp_content_paths = json_decode(<<<'WP_CODEBOX_INCLUDED_WP_CONTENT_PATHS'
`, includedWpContentPaths, String.raw`
WP_CODEBOX_INCLUDED_WP_CONTENT_PATHS
, true );
if ( ! is_array( $wp_codebox_snapshot_included_wp_content_paths ) ) {
    $wp_codebox_snapshot_included_wp_content_paths = array();
}

$wp_codebox_snapshot_included_database_tables = json_decode(<<<'WP_CODEBOX_INCLUDED_DATABASE_TABLES'
`, includedDatabaseTables, String.raw`
WP_CODEBOX_INCLUDED_DATABASE_TABLES
, true );
if ( ! is_array( $wp_codebox_snapshot_included_database_tables ) ) {
    $wp_codebox_snapshot_included_database_tables = array();
}

$wp_codebox_snapshot_excluded_database_tables = json_decode(<<<'WP_CODEBOX_EXCLUDED_DATABASE_TABLES'
`, excludedDatabaseTables, String.raw`
WP_CODEBOX_EXCLUDED_DATABASE_TABLES
, true );
if ( ! is_array( $wp_codebox_snapshot_excluded_database_tables ) ) {
    $wp_codebox_snapshot_excluded_database_tables = array();
}

$wp_codebox_snapshot_included_option_names = json_decode(<<<'WP_CODEBOX_INCLUDED_OPTION_NAMES'
`, includedOptionNames, String.raw`
WP_CODEBOX_INCLUDED_OPTION_NAMES
, true );
if ( ! is_array( $wp_codebox_snapshot_included_option_names ) ) {
    $wp_codebox_snapshot_included_option_names = array();
}

$wp_codebox_snapshot_included_post_types = json_decode(<<<'WP_CODEBOX_INCLUDED_POST_TYPES'
`, includedPostTypes, String.raw`
WP_CODEBOX_INCLUDED_POST_TYPES
, true );
if ( ! is_array( $wp_codebox_snapshot_included_post_types ) ) {
    $wp_codebox_snapshot_included_post_types = array();
}

function wp_codebox_snapshot_hash_file_contents( string $contents ): string {
    return hash( 'sha256', $contents );
}

function wp_codebox_snapshot_json_encode( $value ): string {
    $json = json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE );
    if ( false === $json ) {
        throw new RuntimeException( 'Failed to encode runtime snapshot JSON: ' . json_last_error_msg() );
    }
    return $json;
}

function wp_codebox_snapshot_relative_path( string $base, string $path ): string {
    $base = rtrim( str_replace( '\\', '/', realpath( $base ) ?: $base ), '/' ) . '/';
    $path = str_replace( '\\', '/', $path );
    return ltrim( substr( $path, strlen( $base ) ), '/' );
}

function wp_codebox_snapshot_is_excluded_path( string $relative_path, array $excluded_paths ): bool {
    $relative_path = trim( str_replace( '\\', '/', $relative_path ), '/' );
    foreach ( $excluded_paths as $excluded_path ) {
        if ( ! is_string( $excluded_path ) || '' === $excluded_path ) {
            continue;
        }
        $excluded_path = trim( str_replace( '\\', '/', $excluded_path ), '/' );
        if ( $relative_path === $excluded_path || str_starts_with( $relative_path, $excluded_path . '/' ) ) {
            return true;
        }
    }
    return false;
}

function wp_codebox_snapshot_is_included_path( string $relative_path, array $included_paths ): bool {
    if ( empty( $included_paths ) ) {
        return true;
    }

    $relative_path = trim( str_replace( '\\', '/', $relative_path ), '/' );
    foreach ( $included_paths as $included_path ) {
        if ( ! is_string( $included_path ) || '' === $included_path ) {
            continue;
        }
        $included_path = trim( str_replace( '\\', '/', $included_path ), '/' );
        if ( $relative_path === $included_path || str_starts_with( $relative_path, $included_path . '/' ) ) {
            return true;
        }
    }
    return false;
}

function wp_codebox_snapshot_table_base_name( string $table_name, string $prefix ): string {
    return str_starts_with( $table_name, $prefix ) ? substr( $table_name, strlen( $prefix ) ) : $table_name;
}

function wp_codebox_snapshot_table_allowed( string $table_name, string $prefix, array $included_tables, array $excluded_tables ): bool {
    $base_name = wp_codebox_snapshot_table_base_name( $table_name, $prefix );
    if ( ! empty( $included_tables ) && ! in_array( $base_name, $included_tables, true ) && ! in_array( $table_name, $included_tables, true ) ) {
        return false;
    }
    return ! in_array( $base_name, $excluded_tables, true ) && ! in_array( $table_name, $excluded_tables, true );
}

function wp_codebox_snapshot_sql_string_list( array $values ): string {
    global $wpdb;
    return implode( ', ', array_map( static fn( $value ) => $wpdb->prepare( '%s', (string) $value ), $values ) );
}

function wp_codebox_snapshot_where_clause( string $base_name, array $option_names, array $post_types ): string {
    global $wpdb;
    if ( 'options' === $base_name && ! empty( $option_names ) ) {
        $clauses = array();
        foreach ( $option_names as $name ) {
            $name = (string) $name;
            $clauses[] = str_contains( $name, '*' ) || str_contains( $name, '%' )
                ? $wpdb->prepare( 'option_name LIKE %s', str_replace( '*', '%', $name ) )
                : $wpdb->prepare( 'option_name = %s', $name );
        }
        return ' WHERE ' . implode( ' OR ', $clauses );
    }

    if ( 'posts' === $base_name && ! empty( $post_types ) ) {
        return ' WHERE post_type IN (' . wp_codebox_snapshot_sql_string_list( $post_types ) . ')';
    }

    if ( 'postmeta' === $base_name && ! empty( $post_types ) ) {
        $posts_table = $wpdb->posts;
        return ' WHERE post_id IN (SELECT ID FROM ' . $posts_table . ' WHERE post_type IN (' . wp_codebox_snapshot_sql_string_list( $post_types ) . '))';
    }

    return '';
}

function wp_codebox_snapshot_write_files( string $root, array $included_paths, array $excluded_paths, string $target_path ): void {
    $handle = fopen( $target_path, 'wb' );
    if ( false === $handle ) {
        throw new RuntimeException( 'Failed to create runtime snapshot file manifest.' );
    }

    try {
        if ( ! is_dir( $root ) ) {
            return;
        }

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ),
            RecursiveIteratorIterator::LEAVES_ONLY
        );

        foreach ( $iterator as $file ) {
            if ( ! $file->isFile() ) {
                continue;
            }

            $path = $file->getPathname();
            $relative = wp_codebox_snapshot_relative_path( $root, $path );
            if ( ! wp_codebox_snapshot_is_included_path( $relative, $included_paths ) ) {
                continue;
            }
            if ( wp_codebox_snapshot_is_excluded_path( $relative, $excluded_paths ) ) {
                continue;
            }

            $contents = file_get_contents( $path );
            if ( false === $contents ) {
                continue;
            }

            fwrite( $handle, wp_codebox_snapshot_json_encode( array(
                'scope' => 'wp-content',
                'path' => $relative,
                'bytes' => strlen( $contents ),
                'sha256' => wp_codebox_snapshot_hash_file_contents( $contents ),
                'base64' => base64_encode( $contents ),
            ) ) . "\n" );
            unset( $contents );
        }
    } finally {
        fclose( $handle );
    }
}

$tables = array();
$export_dir = sys_get_temp_dir() . '/wp-codebox-runtime-snapshot-' . bin2hex( random_bytes( 8 ) );
if ( ! mkdir( $export_dir, 0700, true ) && ! is_dir( $export_dir ) ) {
    throw new RuntimeException( 'Failed to create runtime snapshot export directory.' );
}

$table_index = 0;
foreach ( $wpdb->get_col( 'SHOW TABLES' ) as $table_name ) {
    $base_name = wp_codebox_snapshot_table_base_name( $table_name, $wpdb->prefix );
    if ( ! wp_codebox_snapshot_table_allowed( $table_name, $wpdb->prefix, $wp_codebox_snapshot_included_database_tables, $wp_codebox_snapshot_excluded_database_tables ) ) {
        continue;
    }

    $quoted_table = chr( 96 ) . str_replace( chr( 96 ), chr( 96 ) . chr( 96 ), $table_name ) . chr( 96 );
    $create_row = $wpdb->get_row( 'SHOW CREATE TABLE ' . $quoted_table, ARRAY_N );
    $where = wp_codebox_snapshot_where_clause( $base_name, $wp_codebox_snapshot_included_option_names, $wp_codebox_snapshot_included_post_types );
    $row_count = (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . $quoted_table . $where );
    $chunks = array();
    $offset = 0;
    $chunk_index = 0;
    $chunk_size = 100;

    while ( $offset < $row_count ) {
        $rows = $wpdb->get_results( 'SELECT * FROM ' . $quoted_table . $where . ' LIMIT ' . (int) $chunk_size . ' OFFSET ' . (int) $offset, ARRAY_A );
        $chunk_path = $export_dir . '/table-' . $table_index . '-chunk-' . $chunk_index . '.json';
        file_put_contents( $chunk_path, wp_codebox_snapshot_json_encode( $rows ?: array() ) );
        $chunks[] = $chunk_path;
        $offset += $chunk_size;
        ++$chunk_index;
        unset( $rows );
    }

    $tables[] = array(
        'name' => $table_name,
        'createSql' => $create_row[1] ?? '',
        'rowCount' => $row_count,
        'chunks' => $chunks,
    );
    ++$table_index;
}

usort( $tables, fn( $left, $right ) => strcmp( $left['name'], $right['name'] ) );

$files_path = $export_dir . '/files.ndjson';
wp_codebox_snapshot_write_files( WP_CONTENT_DIR, $wp_codebox_snapshot_included_wp_content_paths, $wp_codebox_snapshot_excluded_wp_content_paths, $files_path );

echo wp_codebox_snapshot_json_encode( array(
    'schema' => 'wp-codebox/wordpress-runtime-snapshot-export-manifest/v1',
    'compatibility' => array(
        'backend' => 'wordpress-playground',
        'wordpressVersion' => get_bloginfo( 'version' ),
        'phpVersion' => PHP_VERSION,
    ),
    'metadata' => array(
        'runtime' => null,
        'mounts' => array(),
        'mountedInputs' => array(),
        'activeTheme' => wp_get_theme()->get_stylesheet(),
        'activePlugins' => array_values( (array) get_option( 'active_plugins', array() ) ),
        'wpContentPath' => WP_CONTENT_DIR,
        'includedWpContentPaths' => array_values( $wp_codebox_snapshot_included_wp_content_paths ),
        'skippedWpContentPaths' => array_values( $wp_codebox_snapshot_excluded_wp_content_paths ),
        'includedDatabaseTables' => array_values( $wp_codebox_snapshot_included_database_tables ),
        'excludedDatabaseTables' => array_values( $wp_codebox_snapshot_excluded_database_tables ),
        'includedOptionNames' => array_values( $wp_codebox_snapshot_included_option_names ),
        'includedPostTypes' => array_values( $wp_codebox_snapshot_included_post_types ),
    ),
    'database' => array( 'tables' => $tables ),
    'files' => array( 'ndjsonPath' => $files_path ),
) );`].join("")
}

export function runtimeSnapshotRestorePhp(payload: RuntimeSnapshotArtifact): string {
  return runtimeSnapshotRestorePhpForPayload(`${String.raw`
$payload = json_decode(<<<'WP_CODEBOX_SNAPSHOT_JSON'
`}${JSON.stringify(payload)}${String.raw`
WP_CODEBOX_SNAPSHOT_JSON
, true );
`}`)
}

export function runtimeSnapshotRestorePhpFromFile(path: string): string {
  const encodedPath = JSON.stringify(path)
  return runtimeSnapshotRestorePhpForPayload(`${String.raw`
$wp_codebox_snapshot_path = `}${encodedPath}${String.raw`;
$wp_codebox_snapshot_json = file_get_contents( $wp_codebox_snapshot_path );
if ( false === $wp_codebox_snapshot_json ) {
    throw new RuntimeException( 'Failed to read WordPress runtime snapshot payload: ' . $wp_codebox_snapshot_path );
}
$payload = json_decode( $wp_codebox_snapshot_json, true );
`}`)
}

function runtimeSnapshotRestorePhpForPayload(payloadLoaderPhp: string): string {
  return `${payloadLoaderPhp}${String.raw`

if ( ! is_array( $payload ) || ( $payload['schema'] ?? '' ) !== 'wp-codebox/wordpress-runtime-snapshot/v1' ) {
    throw new RuntimeException( 'Invalid WordPress runtime snapshot payload.' );
}

global $wpdb;

function wp_codebox_snapshot_restore_relative_path( string $base, string $path ): string {
    $base = rtrim( str_replace( '\\', '/', realpath( $base ) ?: $base ), '/' ) . '/';
    $path = str_replace( '\\', '/', $path );
    return ltrim( substr( $path, strlen( $base ) ), '/' );
}

function wp_codebox_snapshot_restore_should_preserve_path( string $relative_path, array $preserved_paths ): bool {
    $relative_path = trim( str_replace( '\\', '/', $relative_path ), '/' );
    foreach ( $preserved_paths as $preserved_path ) {
        if ( ! is_string( $preserved_path ) || '' === $preserved_path ) {
            continue;
        }
        $preserved_path = trim( str_replace( '\\', '/', $preserved_path ), '/' );
        if (
            $relative_path === $preserved_path
            || str_starts_with( $relative_path, $preserved_path . '/' )
            || str_starts_with( $preserved_path, $relative_path . '/' )
        ) {
            return true;
        }
    }
    return false;
}

function wp_codebox_snapshot_clear_wp_content( string $root, array $preserved_paths ): void {
    if ( ! file_exists( $root ) ) {
        return;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ( $iterator as $item ) {
        $path = $item->getPathname();
        $relative = wp_codebox_snapshot_restore_relative_path( $root, $path );
        if ( wp_codebox_snapshot_restore_should_preserve_path( $relative, $preserved_paths ) ) {
            continue;
        }
        $item->isDir() ? rmdir( $path ) : unlink( $path );
    }
}

foreach ( $wpdb->get_col( 'SHOW TABLES' ) as $table_name ) {
    $quoted_table = chr( 96 ) . str_replace( chr( 96 ), chr( 96 ) . chr( 96 ), $table_name ) . chr( 96 );
    $wpdb->query( 'DROP TABLE IF EXISTS ' . $quoted_table );
}

foreach ( $payload['database']['tables'] as $table ) {
    if ( ! empty( $table['createSql'] ) ) {
        $wpdb->query( $table['createSql'] );
    }
    foreach ( $table['rows'] as $row ) {
        $wpdb->insert( $table['name'], $row );
    }
}

$preserved_wp_content_paths = array_values( array_unique( array_merge(
    array( 'database' ),
    (array) ( $payload['metadata']['skippedWpContentPaths'] ?? array() )
) ) );
wp_codebox_snapshot_clear_wp_content( WP_CONTENT_DIR, $preserved_wp_content_paths );
wp_mkdir_p( WP_CONTENT_DIR );

foreach ( $payload['files'] as $file ) {
    if ( ( $file['scope'] ?? '' ) !== 'wp-content' ) {
        continue;
    }
    $relative = ltrim( str_replace( '\\', '/', $file['path'] ), '/' );
    if ( str_contains( $relative, '..' ) ) {
        throw new RuntimeException( 'Snapshot file path is not safe: ' . $relative );
    }
    $target = WP_CONTENT_DIR . '/' . $relative;
    wp_mkdir_p( dirname( $target ) );
    $contents = base64_decode( $file['base64'], true );
    if ( false === $contents ) {
        throw new RuntimeException( 'Snapshot file payload is not valid base64: ' . $relative );
    }
    if ( false === file_put_contents( $target, $contents ) ) {
        throw new RuntimeException( 'Failed to restore snapshot file: ' . $relative );
    }
}

echo wp_json_encode( array(
    'restored' => true,
    'tables' => count( $payload['database']['tables'] ),
    'files' => count( $payload['files'] ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
`}`
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  return isRecord(value)
    && value.backend === "wordpress-playground"
    && isRecord(value.environment)
}

function isMountSpec(value: unknown): value is MountSpec {
  return isRecord(value)
    && typeof value.source === "string"
    && typeof value.target === "string"
    && (value.mode === "readonly" || value.mode === "readwrite")
}

function isRuntimeSnapshotArtifact(value: unknown): value is RuntimeSnapshotArtifact {
  return isRecord(value)
    && value.schema === "wp-codebox/wordpress-runtime-snapshot/v1"
    && value.version === 1
    && isRecord(value.compatibility)
    && value.compatibility.backend === "wordpress-playground"
    && isRecord(value.database)
    && Array.isArray(value.database.tables)
    && Array.isArray(value.files)
}

function normalizeWpContentPathList(paths: string[]): string[] {
  return [...new Set(paths
    .map((path) => path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter((path) => path.length > 0 && !path.includes("..")))]
    .sort()
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim())
    .filter((value) => value.length > 0))]
    .sort()
}
