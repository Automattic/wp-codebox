<?php
declare( strict_types=1 );

/*
 * ZIP stores DOS date/time fields in local time, so `setMtimeName( $path, 0 )`
 * below encodes a different value per builder timezone and the archive digest
 * stops being reproducible. libzip converts through libc, which reads the TZ
 * environment variable rather than PHP's own timezone setting, so pin both.
 * This keeps `archiveSha256` meaning the same thing on every machine and in CI.
 */
putenv( 'TZ=UTC' );
date_default_timezone_set( 'UTC' );

const MDI_REVISION = 'bf6d434d1673fdd86d777501f7eaec292d32ad1f';
const REQUIRED_PATHS = array(
	'_options/siteurl.json', '_options/home.json', '_tables/users.json', '_tables/usermeta.json',
	'_tables/terms.json', '_tables/term_taxonomy.json', '_tables/termmeta.json', '_tables/postmeta.json',
	'_tables/term_relationships.json', '_tables/comments.json', '_tables/commentmeta.json', '_tables/links.json',
	'_options/theme_mods_twentytwentyfive.json',
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
$assets = $repository . '/assets';
$runtime_zip = $assets . '/markdown-database-integration-runtime.zip';
$sqlite_seed = $assets . '/wordpress-install-seed.sqlite';
$output_zip = $assets . '/markdown-database-integration-canonical-seed.zip';
$output_manifest = $assets . '/markdown-database-integration-canonical-seed.json';
$root = sys_get_temp_dir() . '/wp-codebox-canonical-mdi-' . getmypid() . '-' . bin2hex( random_bytes( 4 ) );
$front_page_content = <<<'HTML'
<!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} -->
<main class="wp-block-group">
<!-- wp:group {"style":{"border":{"radius":"18px"},"spacing":{"padding":{"top":"var:preset|spacing|60","right":"var:preset|spacing|60","bottom":"var:preset|spacing|60","left":"var:preset|spacing|60"}}},"backgroundColor":"contrast","textColor":"base","layout":{"type":"constrained"}} -->
<div class="wp-block-group has-base-color has-contrast-background-color has-text-color has-background" style="border-radius:18px;padding-top:var(--wp--preset--spacing--60);padding-right:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--60);padding-left:var(--wp--preset--spacing--60)"><!-- wp:paragraph {"style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.12em"}},"fontSize":"small"} -->
<p class="has-small-font-size" style="letter-spacing:0.12em;text-transform:uppercase">A live systems experiment</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":1,"fontSize":"xx-large"} -->
<h1 class="wp-block-heading has-xx-large-font-size">WordPress at the edge, with durable Markdown state</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size">You are looking at a real WordPress site running PHP as WebAssembly inside a Cloudflare Worker. This page is both the demonstration and the guide to how it works.</p>
<!-- /wp:paragraph -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button {"backgroundColor":"base","textColor":"contrast"} -->
<div class="wp-block-button"><a class="wp-block-button__link has-contrast-color has-base-background-color has-text-color has-background wp-element-button" href="/wp-admin/">Open WordPress</a></div>
<!-- /wp:button --><!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="https://github.com/Automattic/wp-codebox/pull/1886">Read the implementation</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->

<!-- wp:columns {"style":{"spacing":{"margin":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|60"}}}} -->
<div class="wp-block-columns" style="margin-top:var(--wp--preset--spacing--50);margin-bottom:var(--wp--preset--spacing--60)"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size"><strong>Runtime</strong><br>PHP 8.5 WebAssembly</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --><!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size"><strong>Application</strong><br>WordPress 7.0</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --><!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size"><strong>Durable state</strong><br>Markdown and JSON in R2</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --><!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size"><strong>Coordination</strong><br>Cloudflare Durable Object</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->

<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Follow a request</h2>
<!-- /wp:heading -->

<!-- wp:list {"ordered":true} -->
<ol class="wp-block-list"><!-- wp:list-item -->
<li>The Worker acquires a short lease from a Durable Object, which serializes requests against the current site revision.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>A cold isolate downloads the content-addressed WordPress server corpus and the current canonical revision from R2.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>PHP-WASM reconstructs disposable SQLite query state, then WordPress handles the request normally. Warm reads reuse that pointer-scoped runtime.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>Browser CSS, JavaScript, fonts, and images bypass PHP and stream from bounded archive reads at the edge.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>After a write, Markdown Database Integration flushes canonical changes to immutable R2 objects and the Durable Object atomically advances the revision pointer.</li>
<!-- /wp:list-item --></ol>
<!-- /wp:list -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">The durability boundary</h2>
<!-- /wp:heading -->

<!-- wp:columns -->
<div class="wp-block-columns"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"style":{"border":{"color":"#d5d7da","width":"1px","radius":"12px"},"spacing":{"padding":{"top":"var:preset|spacing|40","right":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group has-border-color" style="border-color:#d5d7da;border-width:1px;border-radius:12px;padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)"><!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Durable</h3>
<!-- /wp:heading --><!-- wp:paragraph -->
<p>Posts, pages, options, users, and metadata are exported as canonical Markdown and JSON. Immutable objects and revision manifests live in R2.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:column --><!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"style":{"border":{"color":"#d5d7da","width":"1px","radius":"12px"},"spacing":{"padding":{"top":"var:preset|spacing|40","right":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group has-border-color" style="border-color:#d5d7da;border-width:1px;border-radius:12px;padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)"><!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Disposable</h3>
<!-- /wp:heading --><!-- wp:paragraph -->
<p>SQLite and the PHP filesystem are reconstructed runtime state. A Worker isolate can disappear without becoming the source of truth.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->

<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">What this deployment proves</h2>
<!-- /wp:heading -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>Log in to WordPress.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>Edit content with the block editor and publish it.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>Render the published page publicly.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>Recover the same published state after replacing the Worker runtime.</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Current operating envelope</h2>
<!-- /wp:heading -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>One site namespace is currently configured.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>Dynamic requests are serialized against one canonical revision.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>Cold isolates pay reconstruction cost; warm read requests reuse the current PHP runtime.</li>
<!-- /wp:list-item --><!-- wp:list-item -->
<li>Static browser assets are cached independently and never enter PHP request handling.</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size">This is an experimental deployment from <a href="https://github.com/Automattic/wp-codebox/pull/1886">Automattic/wp-codebox#1886</a>. Its public behavior is exercised through deployment, authentication, publishing, asset, restart, and canonical-state recovery gates.</p>
<!-- /wp:paragraph -->
</main>
<!-- /wp:group -->
HTML;

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
	$front_page = $pdo->prepare( 'UPDATE wp_posts SET post_title = ?, post_name = ?, post_excerpt = ?, post_content = ?, post_status = ? WHERE ID = 2 AND post_type = ?' );
	$front_page->execute( array( 'Cloudflare WordPress Runtime', 'cloudflare-wordpress-runtime', 'A bounded WordPress WebAssembly runtime with canonical Markdown state in R2.', $front_page_content, 'publish', 'page' ) );
	if ( 1 !== $front_page->rowCount() ) { throw new RuntimeException( 'Unable to configure canonical front page ID 2.' ); }
	$options = $pdo->prepare( "INSERT INTO wp_options (option_name, option_value, autoload) VALUES (?, ?, 'on') ON CONFLICT(option_name) DO UPDATE SET option_value = excluded.option_value" );
	foreach ( array( 'blogname' => 'Cloudflare WordPress Runtime', 'blogdescription' => 'WordPress WebAssembly with canonical Markdown state', 'show_on_front' => 'page', 'page_on_front' => '2' ) as $name => $value ) {
		$options->execute( array( $name, $value ) );
	}
	$runtime = WP_Markdown_Primary_Storage_Runtime::bootstrap_existing_cache( array( 'content_root' => $markdown_root, 'state_root' => $markdown_root ), new WP_SQLite_Connection( $pdo ), 'wordpress' );
	$driver = $runtime->get_driver();
	$theme_mods = $pdo->prepare( "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('theme_mods_twentytwentyfive', ?, 'auto') ON CONFLICT(option_name) DO UPDATE SET option_value = excluded.option_value" );
	$theme_mods->execute( array( serialize( array( 'custom_css_post_id' => -1 ) ) ) );
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
