<?php
define( 'ABSPATH', __DIR__ );

final class WP_Error {
	private string $code;
	private mixed $data;

	public function __construct( string $code, string $message = '', mixed $data = null ) {
		$this->code = $code;
		$this->data = $data;
	}

	public function get_error_code(): string {
		return $this->code;
	}

	public function get_error_data(): mixed {
		return $this->data;
	}
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

$GLOBALS['wp_codebox_test_filters'] = array();
function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	$GLOBALS['wp_codebox_test_filters'][ $hook ][] = array( $callback, $accepted_args );
}
function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array() as $entry ) {
		$value = $entry[0]( ...array_slice( array_merge( array( $value ), $args ), 0, $entry[1] ) );
	}
	return $value;
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-task.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-provider-credentials.php';

add_filter(
	'wp_codebox_provider_credential_requirements',
	static function ( array $requirements ): array {
		$requirements['provider']       = 'example-provider';
		$requirements['requirements'][] = array(
			'name'              => 'primary token',
			'kind'              => 'api-token',
			'scope'             => 'sandbox',
			'required'          => true,
			'secret_env_values' => array( 'EXAMPLE_PROVIDER_TOKEN' => 'do-not-serialize' ),
			'secret_env'        => array( 'EXAMPLE_PROVIDER_TOKEN', 'bad-name' ),
		);
		return $requirements;
	},
	10,
	1
);

add_filter(
	'wp_codebox_resolve_provider_credentials',
	static function ( array $preflight ): array {
		$preflight['status']            = 'available';
		$preflight['secret_env']        = array( 'EXAMPLE_PROVIDER_TOKEN' );
		$preflight['secret_env_values'] = array( 'EXAMPLE_PROVIDER_TOKEN' => 'do-not-serialize' );
		$preflight['credentials']       = array( 'token' => 'do-not-serialize' );
		$preflight['diagnostics'][]     = array( 'code' => 'ok', 'severity' => 'info', 'message' => 'Resolved through provider-owned mapping.' );
		return $preflight;
	},
	10,
	1
);

$resolved = WP_Codebox_Provider_Credentials::resolve( array( 'provider' => 'example-provider', 'model' => 'example-model' ) );
if ( is_wp_error( $resolved ) ) {
	fwrite( STDERR, "Expected provider credentials to resolve.\n" );
	exit( 1 );
}

$serialized = json_encode( $resolved );
if ( ! is_string( $serialized ) || str_contains( $serialized, 'do-not-serialize' ) || str_contains( $serialized, 'secret_env_values' ) || str_contains( $serialized, 'credentials' ) ) {
	fwrite( STDERR, "Provider credential contract leaked secret-shaped fields.\n" );
	exit( 1 );
}

if ( array( 'EXAMPLE_PROVIDER_TOKEN' ) !== ( $resolved['secret_env'] ?? null ) ) {
	fwrite( STDERR, "Provider credential env name resolution failed.\n" );
	exit( 1 );
}

$GLOBALS['wp_codebox_test_filters'] = array();
add_filter(
	'wp_codebox_provider_credential_requirements',
	static function ( array $requirements ): array {
		$requirements['requirements'][] = array( 'name' => 'primary_token', 'required' => true );
		return $requirements;
	},
	10,
	1
);

$missing = WP_Codebox_Provider_Credentials::resolve( array( 'provider' => 'example-provider' ) );
if ( ! is_wp_error( $missing ) || 'wp_codebox_provider_credentials_unavailable' !== $missing->get_error_code() ) {
	fwrite( STDERR, "Expected provider credential preflight to fail closed.\n" );
	exit( 1 );
}

echo "provider credential boundary ok\n";
