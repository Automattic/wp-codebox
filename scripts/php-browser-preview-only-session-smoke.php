<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );
define( 'WPINC', 'wp-includes' );
defined( 'WEEK_IN_SECONDS' ) || define( 'WEEK_IN_SECONDS', 7 * 24 * 60 * 60 );

$GLOBALS['wp_codebox_test_transients'] = array();

final class WP_Error {
	/** @param array<string,mixed> $data */
	public function __construct( private string $code = '', private string $message = '', private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	/** @return array<string,mixed> */
	public function get_error_data(): array { return $this->data; }
}

function is_wp_error( mixed $value ): bool { return $value instanceof WP_Error; }
function plugin_dir_path( string $file ): string { return rtrim( dirname( $file ), '/' ) . '/'; }
function plugin_dir_url( string $file ): string { unset( $file ); return 'https://example.test/wp-content/plugins/wp-codebox/'; }
function add_action( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void { unset( $hook, $callback, $priority, $accepted_args ); }
function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void { unset( $hook, $callback, $priority, $accepted_args ); }
function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	if ( 'wp_codebox_resolve_inheritance' === $hook ) {
		return array(
			'connectors' => array(
				array(
					'name'     => 'preview-provider',
					'status'   => 'resolved',
					'provider' => 'inherited-provider',
					'model'    => 'inherited-model',
				),
			),
			'settings' => array(),
		);
	}
	unset( $args );
	return $value;
}
function sanitize_key( string $value ): string { return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $value ) ?? '' ); }
function sanitize_text_field( string $value ): string { return trim( $value ); }
function wp_json_encode( mixed $value, int $flags = 0, int $depth = 512 ): string|false { return json_encode( $value, $flags, $depth ); }
function wp_parse_url( string $url, int $component = -1 ): mixed { return -1 === $component ? parse_url( $url ) : parse_url( $url, $component ); }
function wp_create_nonce( string|int $action = -1 ): string { unset( $action ); return 'preview-only-test'; }
function wp_normalize_path( string $path ): string { return str_replace( '\\', '/', $path ); }
function wp_generate_uuid4(): string { return '00000000-0000-4000-8000-000000001743'; }
function get_transient( string $key ): mixed { return $GLOBALS['wp_codebox_test_transients'][ $key ] ?? false; }
function set_transient( string $key, mixed $value, int $expiration = 0 ): bool { unset( $expiration ); $GLOBALS['wp_codebox_test_transients'][ $key ] = $value; return true; }

function fail( string $message ): void {
	fwrite( STDERR, $message . PHP_EOL );
	exit( 1 );
}

function expect( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fail( $message );
	}
}

/** @param array<int,array<string,mixed>> $steps */
function has_runner_step( array $steps ): bool {
	foreach ( $steps as $step ) {
		if ( 'runPHP' === ( $step['step'] ?? '' ) && str_contains( (string) ( $step['code'] ?? '' ), 'WP_CODEBOX_BROWSER_RUNNER_BODY_START' ) ) {
			return true;
		}
	}
	return false;
}

require __DIR__ . '/../packages/wordpress-plugin/wp-codebox.php';

$task_input_schema_method = new ReflectionMethod( WP_Codebox_Abilities::class, 'task_input_schema' );
$inherit_schema_method    = new ReflectionMethod( WP_Codebox_Abilities::class, 'inherit_schema' );
$session_input_method     = new ReflectionMethod( WP_Codebox_Abilities::class, 'sandbox_session_input_schema' );
$browser_input_method     = new ReflectionMethod( WP_Codebox_Abilities::class, 'browser_task_input_properties' );
$task_input_schema        = $task_input_schema_method->invoke( null );
$inherit_schema           = $inherit_schema_method->invoke( null );
$session_input            = $session_input_method->invoke( null );
$session_properties       = $browser_input_method->invoke( null, $task_input_schema, $inherit_schema, $session_input, true );
$task_contract_properties = $browser_input_method->invoke( null, $task_input_schema, $inherit_schema, $session_input, false );

expect( 'boolean' === ( $session_properties['preview_only']['type'] ?? '' ), 'Browser session input schema must explicitly declare preview_only as a boolean.' );
expect( false === ( $session_properties['preview_only']['default'] ?? null ), 'Browser session input schema must default preview_only to false.' );
expect( ! isset( $task_contract_properties['preview_only'] ), 'Browser task contract input schema must remain agentic.' );

$input = array(
	'goal'               => 'Prepare an editable theme preview.',
	'sandbox_session_id' => 'preview-only-session',
	'inherit'            => array( 'connectors' => array( 'preview-provider' ) ),
	'runtime_requirements' => array( 'requires_provider' => false ),
	'runtime'            => array(
		'plugins'    => array(
			array(
				'slug'     => 'caller-runtime-plugin',
				'url'      => 'https://downloads.wordpress.org/plugin/caller-runtime-plugin.zip',
				'package'  => 'browser',
				'activate' => true,
			),
		),
		'mu_plugins' => array(
			array(
				'slug'    => 'preview-bootstrap',
				'file'    => 'preview-bootstrap.php',
				'content' => '<?php add_action( "init", static function (): void {} );',
			),
		),
		'themes'     => array(
			array(
				'slug'  => 'preview-theme',
				'files' => array(
					array( 'path' => 'style.css', 'content' => '/* Theme Name: Preview Theme */' ),
					array( 'path' => 'index.php', 'content' => '<?php echo "Preview";' ),
				),
			),
		),
		'bootstrap'  => array(
			array( 'operation' => 'set_option', 'args' => array( 'name' => 'blogname', 'value' => 'Preview Only' ) ),
		),
		'prepared'   => array(
			'enabled'   => true,
			'cache'     => true,
			'cache_key' => 'preview-only-runtime',
		),
	),
	'site_blueprint_artifact' => array(
		'schema'    => 'wp-codebox/site-blueprint-artifact/v1',
		'id'        => 'preview-site-blueprint',
		'blueprint' => array(
			'steps' => array( array( 'step' => 'setSiteOptions', 'options' => array( 'description' => 'Site artifact applied' ) ) ),
		),
	),
	'include_internal_browser_session' => true,
);

$preview = WP_Codebox_Abilities::create_browser_playground_session( $input + array( 'preview_only' => true ) );
if ( is_wp_error( $preview ) ) {
	fail( 'preview failed: ' . $preview->get_error_code() . ': ' . $preview->get_error_message() );
}
$hydrated = WP_Codebox_Abilities::hydrate_browser_blueprint_ref( array( 'ref' => $preview['product']['preview_boot']['blueprint_ref'] ?? '' ) );
$agentic  = WP_Codebox_Abilities::create_browser_playground_session( $input );
$task     = WP_Codebox_Abilities::create_browser_task_contract( $input + array( 'preview_only' => true, 'include_internal_browser_contract' => true ) );

foreach ( array( 'hydrated' => $hydrated, 'agentic' => $agentic, 'task' => $task ) as $name => $result ) {
	if ( is_wp_error( $result ) ) {
		fail( $name . ' failed: ' . $result->get_error_code() . ': ' . $result->get_error_message() );
	}
}

$preview_steps = is_array( $preview['playground']['blueprint']['steps'] ?? null ) ? $preview['playground']['blueprint']['steps'] : array();
$agentic_steps = is_array( $agentic['playground']['blueprint']['steps'] ?? null ) ? $agentic['playground']['blueprint']['steps'] : array();
$task_steps    = is_array( $task['primary']['playground']['blueprint']['steps'] ?? null ) ? $task['primary']['playground']['blueprint']['steps'] : array();
$preview_kinds = array_column( $preview_steps, 'step' );

expect( true === ( $preview['preview_only'] ?? false ), 'Expected raw preview session to audit preview_only=true.' );
expect( true === ( $preview['product']['preview_only'] ?? false ), 'Expected product DTO to audit preview_only=true.' );
expect( ! isset( $preview['agent'], $preview['provider'], $preview['model'], $preview['inheritance'] ), 'Preview-only must omit agent/provider inheritance fields.' );
expect( ! isset( $preview['task_payload'], $preview['recipe'], $preview['materialization'] ), 'Preview-only must omit task payload, recipe, and materialization contracts.' );
expect( ! has_runner_step( $preview_steps ), 'Preview-only boot blueprint must not contain the generated runner runPHP step.' );
expect( in_array( 'installPlugin', $preview_kinds, true ), 'Preview-only boot blueprint must install the caller runtime plugin.' );
expect( in_array( 'setSiteOptions', $preview_kinds, true ), 'Preview-only boot blueprint must retain the site blueprint artifact.' );
expect( in_array( 'runPHP', $preview_kinds, true ), 'Preview-only boot blueprint must retain caller bootstrap operations.' );
expect( str_contains( wp_json_encode( $preview_steps ) ?: '', 'preview-bootstrap.php' ), 'Preview-only boot blueprint must install caller MU plugin content.' );
expect( str_contains( wp_json_encode( $preview_steps ) ?: '', 'preview-theme' ), 'Preview-only boot blueprint must install caller theme files.' );
expect( array( 'caller-runtime-plugin' ) === array_column( $preview['runtime']['plugins'] ?? array(), 'slug' ), 'Preview-only runtime must contain only the caller-declared plugin.' );
expect( array( 'preview-bootstrap' ) === array_column( $preview['runtime']['mu_plugins'] ?? array(), 'slug' ), 'Preview-only runtime must retain caller MU plugins.' );
expect( array( 'preview-theme' ) === array_column( $preview['runtime']['themes'] ?? array(), 'slug' ), 'Preview-only runtime must retain caller themes.' );
expect( 'ready' === ( $preview['product']['runtime_readiness']['status'] ?? '' ), 'Preview-only product DTO must remain runtime-ready.' );
expect( true === ( $preview['product']['preview_boot']['blueprint_ref_dto']['hydratable'] ?? false ), 'Preview-only product DTO must expose a hydratable blueprint ref.' );

expect( ! is_wp_error( $hydrated ), 'Preview-only prepared runtime blueprint ref must hydrate.' );
expect( $preview['playground']['blueprint'] === ( $hydrated['blueprint'] ?? null ), 'Preview-only boot blueprint must be the cached executable runtime blueprint.' );

expect( false === ( $agentic['preview_only'] ?? true ), 'Default browser session must remain agentic.' );
expect( 'inherited-provider' === ( $agentic['provider'] ?? '' ), 'Default browser session must retain provider inheritance.' );
expect( 'inherited-model' === ( $agentic['model'] ?? '' ), 'Default browser session must retain model inheritance.' );
expect( has_runner_step( $agentic_steps ), 'Default browser session must retain the generated runner step.' );
expect( isset( $agentic['task_payload'], $agentic['recipe'], $agentic['materialization'] ), 'Default browser session must retain runner contracts.' );

expect( false === ( $task['primary']['preview_only'] ?? true ), 'Browser task contract must remain agentic when preview_only is supplied.' );
expect( 'inherited-provider' === ( $task['primary']['provider'] ?? '' ), 'Browser task contract must retain provider inheritance.' );
expect( has_runner_step( $task_steps ), 'Browser task contract primary session must retain the generated runner step.' );

fwrite( STDOUT, "PHP browser preview-only session smoke passed\n" );
