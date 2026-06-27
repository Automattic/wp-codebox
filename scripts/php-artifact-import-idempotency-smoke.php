<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

final class WP_Error {
	/** @param array<string,mixed> $data */
	public function __construct( private string $code = '', private string $message = '', private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	/** @return array<string,mixed> */
	public function get_error_data(): array { return $this->data; }
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function fail( string $message ): void {
	fwrite( STDERR, $message . PHP_EOL );
	exit( 1 );
}

function expect( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fail( $message );
	}
}

/** @param array<string,mixed> $expected */
function expect_envelope( array $envelope, array $expected, string $label ): void {
	foreach ( $expected as $key => $value ) {
		expect( array_key_exists( $key, $envelope ), $label . ' missing ' . $key );
		expect( $value === $envelope[ $key ], $label . ' expected ' . $key . '=' . var_export( $value, true ) . ', got ' . var_export( $envelope[ $key ], true ) );
	}
}

function write_json_file( string $path, mixed $value ): void {
	$encoded = json_encode( $value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
	expect( false !== $encoded, 'Expected JSON fixture encoding to succeed.' );
	expect( false !== file_put_contents( $path, $encoded . "\n" ), 'Expected fixture write to succeed: ' . $path );
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
		$item->isDir() ? rmdir( $item->getPathname() ) : unlink( $item->getPathname() );
	}
	rmdir( $path );
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-json.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-path-policy.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-managed-host-command.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-artifacts.php';

$root = sys_get_temp_dir() . '/wp-codebox-artifact-import-smoke-' . bin2hex( random_bytes( 6 ) );
$source = $root . '/source/replay-bundle';
$store = $root . '/store';
$verifier = $root . '/wp-codebox-verifier';

try {
	mkdir( $source . '/files', 0777, true );
	mkdir( $store, 0777, true );
	file_put_contents(
		$verifier,
		"#!/usr/bin/env php\n<?php echo json_encode(array('schema'=>'wp-codebox/artifact-bundle-verification/v1','valid'=>true,'violations'=>array(),'summary'=>'fixture verifier'));\n"
	);
	chmod( $verifier, 0755 );

	$content_digest = str_repeat( 'd', 64 );
	write_json_file(
		$source . '/manifest.json',
		array(
			'schema'        => 'wp-codebox/artifact-bundle-manifest/v1',
			'id'            => 'generic-replay-fixture',
			'createdAt'     => '2026-06-19T00:00:00+00:00',
			'contentDigest' => array( 'algorithm' => 'sha256', 'value' => $content_digest ),
			'files'         => array(
				array( 'path' => 'manifest.json', 'sha256' => array( 'algorithm' => 'sha256', 'value' => str_repeat( 'a', 64 ) ) ),
				array( 'path' => 'files/runtime-snapshot.json', 'sha256' => array( 'algorithm' => 'sha256', 'value' => str_repeat( 'b', 64 ) ) ),
			),
		)
	);
	write_json_file( $source . '/metadata.json', array( 'kind' => 'generic-replay-package', 'consumer' => 'smoke' ) );
	write_json_file( $source . '/files/runtime-snapshot.json', array( 'schema' => 'wp-codebox/wordpress-runtime-snapshot/v1', 'version' => 1 ) );

	$artifacts = new WP_Codebox_Artifacts();
	$input = array(
		'artifacts_path' => $store,
		'source_bundle_path' => $source,
		'expected_artifact_id' => 'generic-replay-fixture',
		'expected_content_digest' => $content_digest,
		'wp_codebox_bin' => $verifier,
		'metadata' => array( 'caller' => 'artifact-import-idempotency-smoke' ),
	);

	$created = $artifacts->import_artifact_bundle( $input );
	expect( ! is_wp_error( $created ), 'Expected first import to succeed: ' . ( is_wp_error( $created ) ? $created->get_error_message() : '' ) );
	expect_envelope( $created, array( 'schema' => 'wp-codebox/artifact-result-envelope/v1', 'operation' => 'import-artifact-bundle', 'status' => 'created', 'success' => true ), 'created import envelope' );
	expect( 'wp-codebox/import-artifact-bundle/v1' === $created['operation_schema'], 'Expected import operation schema.' );
	expect( 'generic-replay-fixture' === $created['artifactBundle']['id'], 'Expected artifact bundle ref id.' );
	expect( $content_digest === $created['artifactBundle']['digest']['value'], 'Expected artifact bundle digest.' );
	expect( is_file( $created['artifactBundle']['path'] . '/files/runtime-snapshot.json' ), 'Expected imported generic replay file to remain readable.' );

	$existing = $artifacts->import_artifact_bundle( $input );
	expect( ! is_wp_error( $existing ), 'Expected second import to be idempotent.' );
	expect_envelope( $existing, array( 'operation' => 'import-artifact-bundle', 'status' => 'existing', 'success' => true ), 'existing import envelope' );
	expect( $created['artifactBundle'] === $existing['artifactBundle'], 'Expected existing import to return the stable artifact ref.' );

	$reimport = $artifacts->reimport_artifact_bundle(
		array(
			'artifacts_path' => $store,
			'artifact_result' => $created,
			'expected_content_digest' => $content_digest,
			'wp_codebox_bin' => $verifier,
		)
	);
	expect( ! is_wp_error( $reimport ), 'Expected reimport from artifact result to succeed.' );
	expect_envelope( $reimport, array( 'operation' => 'reimport-artifact-bundle', 'operation_schema' => 'wp-codebox/reimport-artifact-bundle/v1', 'status' => 'existing', 'success' => true ), 'reimport envelope' );
	expect( $created['artifactBundle'] === $reimport['artifactBundle'], 'Expected reimport to preserve the stable artifact ref.' );

	$get = $artifacts->get( array( 'artifacts_path' => $store, 'artifact_id' => 'generic-replay-fixture' ) );
	expect( ! is_wp_error( $get ), 'Expected generic imported artifact to be readable through get().' );
	expect( 'wp-codebox/artifact/v1' === $get['schema'], 'Expected get artifact schema.' );
	expect( 'generic-replay-fixture' === $get['artifact']['id'], 'Expected readable generic artifact id.' );
	expect( 'generic-replay-package' === $get['artifact']['metadata']['kind'], 'Expected readable generic metadata.' );
	expect( 'files/runtime-snapshot.json' === $get['artifact']['manifest']['files'][1]['path'], 'Expected generic replay bundle manifest paths to remain readable.' );

	$inspect = $artifacts->inspect( array( 'artifacts_path' => $store, 'artifact_id' => 'generic-replay-fixture', 'wp_codebox_bin' => $verifier ) );
	expect( ! is_wp_error( $inspect ), 'Expected generic imported artifact to be inspectable: ' . ( is_wp_error( $inspect ) ? $inspect->get_error_message() : '' ) );
	expect( 'wp-codebox/artifact-inspection/v1' === $inspect['schema'], 'Expected inspect artifact schema.' );
	expect( 'generic-replay-fixture' === $inspect['artifact']['id'], 'Expected inspect artifact id.' );
	expect( true === $inspect['verification']['valid'], 'Expected inspect verification payload.' );
} finally {
	remove_tree( $root );
}

fwrite( STDOUT, "PHP artifact import idempotency smoke passed\n" );
