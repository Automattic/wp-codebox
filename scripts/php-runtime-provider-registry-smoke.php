<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

$GLOBALS['wp_codebox_test_filters'] = array();

final class WP_Error {
	public function __construct( private string $code, private string $message, private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function apply_filters( string $hook_name, mixed $value, mixed ...$args ): mixed {
	unset( $args );
	return array_key_exists( $hook_name, $GLOBALS['wp_codebox_test_filters'] ) ? $GLOBALS['wp_codebox_test_filters'][ $hook_name ] : $value;
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-provider-registry.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-browser-provider-auth-strategies.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-task.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-inheritance.php';

WP_Codebox_Runtime_Provider_Registry::register(
	'Example Runtime',
	static fn( array $input ): array => array( 'schema' => 'wp-codebox/example-runtime-result/v1', 'received' => $input ),
	array( 'label' => 'Example runtime', 'capabilities' => array( 'runtime-package' ) )
);

assert( '' === WP_Codebox_Runtime_Provider_Registry::default_provider() );

$missing_default = WP_Codebox_Runtime_Provider_Registry::invoke( array( 'package' => array( 'id' => 'example' ) ) );
assert( is_wp_error( $missing_default ) );
assert( 'wp_codebox_runtime_provider_default_missing' === $missing_default->get_error_code() );
assert( array( 'example-runtime' ) === $missing_default->get_error_data()['available_providers'] );

$explicit = WP_Codebox_Runtime_Provider_Registry::invoke( array( 'runtime_provider_id' => 'example-runtime' ) );
assert( ! is_wp_error( $explicit ) );
assert( 'example-runtime' === $explicit['runtime_provider']['id'] );

$GLOBALS['wp_codebox_test_filters']['wp_codebox_default_runtime_provider'] = 'missing-runtime';
$unavailable_default = WP_Codebox_Runtime_Provider_Registry::invoke( array() );
assert( is_wp_error( $unavailable_default ) );
assert( 'wp_codebox_runtime_provider_unavailable' === $unavailable_default->get_error_code() );
assert( 'missing-runtime' === $unavailable_default->get_error_data()['provider'] );

$GLOBALS['wp_codebox_test_filters']['wp_codebox_default_runtime_provider'] = 'example-runtime';
$default = WP_Codebox_Runtime_Provider_Registry::invoke( array( 'package' => array( 'id' => 'example' ) ) );
assert( ! is_wp_error( $default ) );
assert( 'example-runtime' === $default['runtime_provider']['id'] );

WP_Codebox_Browser_Provider_Auth_Strategies::register( 'example-auth', static fn( array $prepared ): array => $prepared, array( 'installable_plugins' => array( 'example-provider' ), 'secret_env' => array( 'EXAMPLE_TOKEN' ) ) );
$readiness = WP_Codebox_Runtime_Provider_Registry::resolve_runtime_requirements(
	array(
		'runtime_provider_id' => 'example-runtime',
		'model'               => 'example-model',
		'secret_env'          => array( 'EXAMPLE_TOKEN' ),
		'components'          => array( 'example-provider' ),
		'inherit'             => array(
			'connectors' => array(
				array( 'name' => 'example-provider', 'bridge' => array( 'authentication' => 'example-auth' ) ),
				array( 'name' => 'missing-provider', 'bridge' => array( 'authentication' => 'missing-auth' ) ),
			),
		),
	)
);
assert( 'wp-codebox/runtime-requirements-readiness/v1' === $readiness['schema'] );
assert( 'example-runtime' === $readiness['provider']['id'] );
assert( 'example-model' === $readiness['model'] );
assert( array( 'EXAMPLE_TOKEN' ) === $readiness['secret_env'] );
assert( array( 'missing-auth' ) === $readiness['missing_adapters'] );
assert( false === $readiness['availability']['available'] );
assert( array( 'type' => 'plugin', 'slug' => 'example-provider', 'source' => 'example-auth' ) === $readiness['installable_components'][0] );

$public_connector_readiness = WP_Codebox_Runtime_Provider_Registry::resolve_runtime_requirements(
	array(
		'runtime_provider_id' => 'example-runtime',
		'inherit'             => array(
			'connectors' => array( 'openai' ),
		),
	)
);
assert( false === $public_connector_readiness['availability']['available'] );
assert( 'pending' === $public_connector_readiness['availability']['status'] );
assert( array() === $public_connector_readiness['missing_adapters'] );
assert( array( 'openai' ) === $public_connector_readiness['pending_connectors'] );

echo "runtime provider registry smoke passed\n";
