<?php
declare( strict_types=1 );

const MDI_REVISION = '7cf025f2d64aa933d937f1a18a129e278c231783';
const REQUIRED_PATHS = array(
	'_options/siteurl.json', '_options/home.json', '_tables/users.json', '_tables/usermeta.json',
	'_tables/terms.json', '_tables/term_taxonomy.json', '_tables/termmeta.json', '_tables/postmeta.json',
	'_tables/term_relationships.json', '_tables/comments.json', '_tables/commentmeta.json', '_tables/links.json',
);

define( 'ABSPATH', __DIR__ . '/' );

class WP_SQLite_Connection {
	public function __construct( private PDO $pdo ) {}
	public function get_pdo(): PDO { return $this->pdo; }
}

class WP_SQLite_Driver {
	public function __construct( private WP_SQLite_Connection $connection, string $database ) { unset( $database ); }
	public function get_connection(): WP_SQLite_Connection { return $this->connection; }
	public function get_insert_id(): int { return (int) $this->connection->get_pdo()->lastInsertId(); }
	public function query( string $sql, $fetch_mode = PDO::FETCH_OBJ, ...$args ) {
		unset( $args );
		$statement = $this->connection->get_pdo()->query( $sql );
		return false === $statement ? array() : $statement->fetchAll( $fetch_mode );
	}
}

function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed { unset( $hook, $args ); return $value; }
function cloudflare_seed_rm( string $path ): void {
	if ( ! is_dir( $path ) ) { return; }
	foreach ( scandir( $path ) ?: array() as $entry ) {
		if ( '.' === $entry || '..' === $entry ) { continue; }
		$child = $path . '/' . $entry;
		is_dir( $child ) ? cloudflare_seed_rm( $child ) : unlink( $child );
	}
	rmdir( $path );
}
function cloudflare_seed_files( string $root ): array {
	$files = array();
	$iterator = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ) );
	foreach ( $iterator as $file ) {
		if ( ! $file->isFile() || str_contains( $file->getFilename(), '.tmp.' ) || str_starts_with( $file->getFilename(), 'markdown-index.sqlite' ) ) { continue; }
		$path = substr( $file->getPathname(), strlen( $root ) + 1 );
		$files[ str_replace( DIRECTORY_SEPARATOR, '/', $path ) ] = $file->getPathname();
	}
	ksort( $files, SORT_STRING );
	return $files;
}

$repository = dirname( __DIR__ );
$assets = $repository . '/packages/runtime-cloudflare/assets';
$runtime_zip = $assets . '/markdown-database-integration-runtime.zip';
$sqlite_seed = $assets . '/wordpress-install-seed.sqlite';
$output_zip = $assets . '/markdown-database-integration-canonical-seed.zip';
$output_manifest = $assets . '/markdown-database-integration-canonical-seed.json';
$root = sys_get_temp_dir() . '/wp-codebox-canonical-mdi-' . getmypid() . '-' . bin2hex( random_bytes( 4 ) );

try {
	mkdir( $root, 0755, true );
	$runtime_root = $root . '/runtime';
	$markdown_root = $root . '/markdown';
	$database = $root . '/wordpress.sqlite';
	if ( ! copy( $sqlite_seed, $database ) ) { throw new RuntimeException( 'Unable to copy wordpress-install-seed.sqlite.' ); }
	$zip = new ZipArchive();
	if ( true !== $zip->open( $runtime_zip ) || ! $zip->extractTo( $runtime_root ) ) { throw new RuntimeException( 'Unable to extract the pinned MDI runtime archive.' ); }
	$zip->close();
	foreach ( array( 'class-wp-markdown-frontmatter-profiles.php', 'class-wp-markdown-storage.php', 'class-wp-markdown-search.php', 'class-wp-markdown-write-engine.php', 'class-wp-markdown-driver.php', 'class-wp-markdown-loader.php', 'class-wp-markdown-primary-storage-runtime.php' ) as $file ) {
		require_once $runtime_root . '/inc/' . $file;
	}
	$pdo = new PDO( 'sqlite:' . $database );
	$pdo->setAttribute( PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION );
	$runtime = WP_Markdown_Primary_Storage_Runtime::bootstrap_existing_cache( array( 'content_root' => $markdown_root, 'state_root' => $markdown_root ), new WP_SQLite_Connection( $pdo ), 'wordpress' );
	$driver = $runtime->get_driver();
	foreach ( $pdo->query( 'SELECT ID FROM wp_posts ORDER BY ID' )->fetchAll( PDO::FETCH_COLUMN ) as $post_id ) {
		$driver->query( 'UPDATE wp_posts SET post_modified = post_modified WHERE ID = ' . (int) $post_id );
	}
	$tables = array( 'options' => 'option_id', 'users' => 'ID', 'usermeta' => 'umeta_id', 'postmeta' => 'meta_id', 'terms' => 'term_id', 'term_taxonomy' => 'term_taxonomy_id', 'termmeta' => 'meta_id', 'term_relationships' => 'object_id', 'comments' => 'comment_ID', 'commentmeta' => 'meta_id', 'links' => 'link_id' );
	foreach ( $tables as $table => $column ) {
		try { $driver->query( 'UPDATE wp_' . $table . ' SET ' . $column . ' = ' . $column ); } catch ( Throwable $ignored ) {}
	}
	$runtime->flush();
	$files = cloudflare_seed_files( $markdown_root );
	$missing = array_diff( REQUIRED_PATHS, array_keys( $files ) );
	if ( $missing || ! array_filter( array_keys( $files ), static fn( string $path ): bool => str_ends_with( $path, '.md' ) ) ) {
		$seed_tables = $pdo->query( "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" )->fetchAll( PDO::FETCH_COLUMN );
		throw new RuntimeException( 'Canonical MDI seed is incomplete: ' . implode( ', ', $missing ) . '; SQLite tables: ' . implode( ', ', $seed_tables ) );
	}
	$zip = new ZipArchive();
	if ( true !== $zip->open( $output_zip, ZipArchive::CREATE | ZipArchive::OVERWRITE ) ) { throw new RuntimeException( 'Unable to create canonical MDI seed archive.' ); }
	$manifest_files = array();
	foreach ( $files as $path => $file ) {
		$bytes = file_get_contents( $file );
		if ( false === $bytes || ! $zip->addFromString( $path, $bytes ) || ! $zip->setMtimeName( $path, 0 ) || ! $zip->setCompressionName( $path, ZipArchive::CM_STORE ) ) { throw new RuntimeException( "Unable to package canonical file $path." ); }
		$manifest_files[] = array( 'path' => $path, 'sha256' => hash( 'sha256', $bytes ), 'size' => strlen( $bytes ) );
	}
	$zip->close();
	$manifest = array(
		'schema' => 'wp-codebox/cloudflare-canonical-mdi-seed/v1',
		'markdownDatabaseIntegrationRevision' => MDI_REVISION,
		'wordpressInstallSeedSha256' => hash_file( 'sha256', $sqlite_seed ),
		'archiveSha256' => hash_file( 'sha256', $output_zip ),
		'files' => $manifest_files,
	);
	file_put_contents( $output_manifest, json_encode( $manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
	echo 'Built ' . count( $files ) . ' canonical MDI files (' . filesize( $output_zip ) . ' bytes, ' . $manifest['archiveSha256'] . ").\n";
} finally {
	cloudflare_seed_rm( $root );
}
