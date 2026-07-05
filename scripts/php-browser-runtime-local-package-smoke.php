<?php

define( 'ABSPATH', __DIR__ );

final class WP_Error {
	private string $code;
	private string $message;
	/** @var array<string,mixed> */
	private array $data;

	/** @param array<string,mixed> $data */
	public function __construct( string $code = '', string $message = '', array $data = array() ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}

	public function get_error_code(): string {
		return $this->code;
	}

	public function get_error_message(): string {
		return $this->message;
	}

	/** @return array<string,mixed> */
	public function get_error_data(): array {
		return $this->data;
	}
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

/** @return array{basedir:string,baseurl:string} */
function wp_upload_dir(): array {
	return array(
		'basedir' => sys_get_temp_dir() . '/wp-codebox-local-package-smoke/uploads',
		'baseurl' => 'https://example.test/wp-content/uploads',
	);
}

/** @return array<string,mixed>|false */
function wp_parse_url( string $url ): array|false {
	return parse_url( $url );
}

function apply_filters( string $hook_name, mixed $value, mixed ...$args ): mixed {
	if ( 'wp_codebox_browser_runtime_plugin_package_allowed_hosts' === $hook_name ) {
		$value[] = 'example.test';
	}

	return $value;
}

/** @param array<string,mixed> $args */
function wp_safe_remote_get( string $url, array $args = array() ): array {
	return array(
		'response' => array( 'code' => 200 ),
		'body'     => $GLOBALS['wp_codebox_remote_package_body'] ?? '',
	);
}

/** @param array<string,mixed> $response */
function wp_remote_retrieve_response_code( array $response ): int {
	return (int) ( $response['response']['code'] ?? 0 );
}

/** @param array<string,mixed> $response */
function wp_remote_retrieve_body( array $response ): string {
	return (string) ( $response['body'] ?? '' );
}

function sanitize_key( string $key ): string {
	return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $key ) ?? '' );
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-path-policy.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-runtime.php';

final class WP_Codebox_Browser_Runtime_Local_Package_Smoke {
	use WP_Codebox_Abilities_Browser_Runtime;

	/** @param array<int,mixed> $mu_plugins @return array<int,array<string,mixed>>|WP_Error */
	public static function normalize( array $mu_plugins ): array|WP_Error {
		$method = new ReflectionMethod( self::class, 'normalize_browser_mu_plugins' );
		return $method->invoke( null, $mu_plugins );
	}

	/** @return array<int,string> */
	private static function string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		return array_values(
			array_filter(
				array_map( 'strval', $value ),
				static fn( string $item ): bool => '' !== trim( $item )
			)
		);
	}
}

function fail( string $message ): void {
	fwrite( STDERR, $message . PHP_EOL );
	exit( 1 );
}

function remove_tree( string $path ): void {
	if ( ! is_dir( $path ) ) {
		return;
	}

	$iterator = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator( $path, FilesystemIterator::SKIP_DOTS ),
		RecursiveIteratorIterator::CHILD_FIRST
	);
	foreach ( $iterator as $item ) {
		if ( $item instanceof SplFileInfo && $item->isDir() ) {
			rmdir( $item->getPathname() );
		} elseif ( $item instanceof SplFileInfo ) {
			unlink( $item->getPathname() );
		}
	}
	rmdir( $path );
}

$root = sys_get_temp_dir() . '/wp-codebox-local-package-smoke';
remove_tree( $root );
mkdir( $root . '/source', 0777, true );

$zip_path = $root . '/source/runtime.zip';
$package_body = "PK\x03\x04local-package-smoke";
file_put_contents( $zip_path, $package_body );
$GLOBALS['wp_codebox_remote_package_body'] = $package_body;
$sha256 = hash_file( 'sha256', $zip_path );
if ( ! is_string( $sha256 ) ) {
	fail( 'Could not hash test package.' );
}

$normalized = WP_Codebox_Browser_Runtime_Local_Package_Smoke::normalize(
	array(
		array(
			'slug'   => 'runtime-smoke',
			'file'   => 'runtime-smoke.php',
			'path'   => $zip_path,
			'sha256' => $sha256,
			'entry'  => 'runtime-smoke/runtime-smoke.php',
		),
	)
);

if ( is_wp_error( $normalized ) ) {
	fail( 'Expected local package normalization to succeed, got ' . $normalized->get_error_code() . ': ' . $normalized->get_error_message() );
}

$entry = $normalized[0] ?? array();
if ( ( $entry['sha256'] ?? '' ) !== $sha256 ) {
	fail( 'Expected normalized package sha256 to match source package.' );
}
if ( ! str_starts_with( (string) ( $entry['url'] ?? '' ), 'data:application/zip;base64,' ) ) {
	fail( 'Expected local package to use data URL delivery.' );
}
if ( ( $entry['provenance']['source'] ?? '' ) !== 'runtime-mu-plugin-package-path' ) {
	fail( 'Expected local package path provenance.' );
}

$mismatch = WP_Codebox_Browser_Runtime_Local_Package_Smoke::normalize(
	array(
		array(
			'slug'   => 'runtime-smoke',
			'file'   => 'runtime-smoke.php',
			'path'   => $zip_path,
			'sha256' => str_repeat( '0', 64 ),
			'entry'  => 'runtime-smoke/runtime-smoke.php',
		),
	)
);
if ( ! is_wp_error( $mismatch ) || 'wp_codebox_browser_plugin_package_hash_mismatch' !== $mismatch->get_error_code() ) {
	fail( 'Expected sha256 mismatch to fail.' );
}

$remote_fallback = WP_Codebox_Browser_Runtime_Local_Package_Smoke::normalize(
	array(
		array(
			'slug'   => 'runtime-smoke',
			'file'   => 'runtime-smoke.php',
			'path'   => $root . '/missing/runtime.zip',
			'url'    => 'https://example.test/runtime.zip',
			'sha256' => $sha256,
			'entry'  => 'runtime-smoke/runtime-smoke.php',
		),
	)
);

if ( is_wp_error( $remote_fallback ) ) {
	fail( 'Expected missing local package with URL fallback to succeed, got ' . $remote_fallback->get_error_code() . ': ' . $remote_fallback->get_error_message() );
}

$remote_entry = $remote_fallback[0] ?? array();
if ( ! str_starts_with( (string) ( $remote_entry['url'] ?? '' ), 'data:application/zip;base64,' ) ) {
	fail( 'Expected missing local package with URL fallback to use data URL delivery.' );
}
if ( ( $remote_entry['provenance']['source'] ?? '' ) !== 'runtime-mu-plugin-remote-package' ) {
	fail( 'Expected remote package provenance for missing path fallback.' );
}
if ( 'https://example.test/runtime.zip' !== ( $remote_entry['provenance']['url'] ?? '' ) ) {
	fail( 'Expected remote package provenance to keep the source URL.' );
}

$local_url = WP_Codebox_Browser_Runtime_Local_Package_Smoke::normalize(
	array(
		array(
			'slug'          => 'runtime-smoke',
			'file'          => 'runtime-smoke.php',
			'url'           => 'https://example.test/runtime.zip',
			'sha256'        => $sha256,
			'entry'         => 'runtime-smoke/runtime-smoke.php',
			'local_package' => true,
		),
	)
);

if ( is_wp_error( $local_url ) ) {
	fail( 'Expected local package URL normalization to succeed, got ' . $local_url->get_error_code() . ': ' . $local_url->get_error_message() );
}

$local_url_entry = $local_url[0] ?? array();
if ( 'https://example.test/runtime.zip' !== ( $local_url_entry['url'] ?? '' ) ) {
	fail( 'Expected mu-plugin local_package URL mode to preserve the source URL.' );
}
if ( ( $local_url_entry['sha256'] ?? '' ) !== $sha256 ) {
	fail( 'Expected mu-plugin local_package URL mode to preserve the expected sha256.' );
}
if ( ( $local_url_entry['local_package_fetch_url'] ?? '' ) !== 'https://example.test/runtime.zip' ) {
	fail( 'Expected mu-plugin local_package URL mode to expose the browser fetch URL.' );
}
if ( ( $local_url_entry['provenance']['source'] ?? '' ) !== 'runtime-mu-plugin-local-package-url' ) {
	fail( 'Expected mu-plugin local_package URL provenance.' );
}

remove_tree( $root );
fwrite( STDOUT, "PHP browser runtime local package smoke passed\n" );
