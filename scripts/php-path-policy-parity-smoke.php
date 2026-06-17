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

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-path-policy.php';

function assert_same( mixed $expected, mixed $actual, string $label ): void {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $label . ' failed: expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) . PHP_EOL );
		exit( 1 );
	}
}

function assert_error( mixed $actual, string $label ): void {
	if ( ! is_wp_error( $actual ) ) {
		fwrite( STDERR, $label . ' failed: expected WP_Error, got ' . var_export( $actual, true ) . PHP_EOL );
		exit( 1 );
	}
}

assert_same( 'files/output.json', WP_Codebox_Path_Policy::normalize_artifact_relative_path( '/files//output.json' ), 'artifact leading slash and slash collapse' );
assert_same( 'files/windows/path.json', WP_Codebox_Path_Policy::normalize_artifact_relative_path( 'files\\windows/path.json' ), 'artifact backslash normalization' );
assert_error( WP_Codebox_Path_Policy::normalize_artifact_relative_path( './files/output.json' ), 'artifact current-directory segment' );
assert_error( WP_Codebox_Path_Policy::normalize_artifact_relative_path( 'files/../secret.txt' ), 'artifact parent-directory segment' );
assert_error( WP_Codebox_Path_Policy::normalize_artifact_relative_path( 'C:/tmp/output.json' ), 'artifact drive absolute path' );
assert_error( WP_Codebox_Path_Policy::normalize_artifact_relative_path( '' ), 'artifact empty path' );

assert_same( '/wordpress/wp-content/plugins/plugin', WP_Codebox_Path_Policy::normalize_sandbox_mount_target( '//wordpress//wp-content/plugins/plugin' ), 'mount slash collapse' );
assert_same( '/wordpress/wp-content/plugins/plugin', WP_Codebox_Path_Policy::normalize_sandbox_mount_target( '\\wordpress\\wp-content/plugins/plugin' ), 'mount backslash normalization' );
assert_same( '/', WP_Codebox_Path_Policy::normalize_sandbox_mount_target( '///' ), 'mount root target' );
assert_error( WP_Codebox_Path_Policy::normalize_sandbox_mount_target( 'wordpress/wp-content/plugins/plugin' ), 'mount relative target' );
assert_error( WP_Codebox_Path_Policy::normalize_sandbox_mount_target( '/wordpress/./plugins/plugin' ), 'mount current-directory segment' );
assert_error( WP_Codebox_Path_Policy::normalize_sandbox_mount_target( '/wordpress/../escape' ), 'mount parent-directory segment' );

fwrite( STDOUT, "PHP path policy parity smoke passed\n" );
