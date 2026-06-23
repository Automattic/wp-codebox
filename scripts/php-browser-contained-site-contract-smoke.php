<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );
defined( 'WEEK_IN_SECONDS' ) || define( 'WEEK_IN_SECONDS', 7 * 24 * 60 * 60 );

$GLOBALS['wp_codebox_test_transient'] = false;
$GLOBALS['wp_codebox_test_transients'] = array();

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

function apply_filters( string $hook_name, mixed $value, mixed ...$args ): mixed {
	unset( $hook_name, $args );
	return $value;
}

function sanitize_key( string $key ): string {
	return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $key ) ?? '' );
}

function is_user_logged_in(): bool {
	return false;
}

function current_user_can( string $capability ): bool {
	unset( $capability );
	return false;
}

final class WP_Codebox_Test_Request {
	/** @param array<string,mixed> $params */
	public function __construct( private array $params ) {}

	public function get_param( string $key ): mixed {
		return $this->params[ $key ] ?? null;
	}
}

final class WP_REST_Request {
	/** @param array<string,mixed> $params */
	public function __construct( private array $params ) {}

	public function get_param( string $key ): mixed {
		return $this->params[ $key ] ?? null;
	}
}

function get_transient( string $transient ): mixed {
	if ( array_key_exists( $transient, $GLOBALS['wp_codebox_test_transients'] ) ) {
		return $GLOBALS['wp_codebox_test_transients'][ $transient ]['value'];
	}
	unset( $transient );
	return $GLOBALS['wp_codebox_test_transient'];
}

function set_transient( string $transient, mixed $value, int $expiration = 0 ): bool {
	$GLOBALS['wp_codebox_test_transients'][ $transient ] = array(
		'value'      => $value,
		'expiration' => $expiration,
	);

	return true;
}

function wp_json_encode( mixed $value, int $flags = 0, int $depth = 512 ): string|false {
	return json_encode( $value, $flags, $depth );
}

function wp_generate_uuid4(): string {
	return '00000000-0000-4000-8000-000000000123';
}

function wp_parse_url( string $url, int $component = -1 ): mixed {
	return -1 === $component ? parse_url( $url ) : parse_url( $url, $component );
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

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-workload.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-runtime-invoker.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-path-policy.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-task.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-browser-runner-template.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';

$source_digest = str_repeat( 'a', 64 );
$artifact_digest = str_repeat( 'b', 64 );
$materialization_digest = str_repeat( 'c', 64 );

expect( WP_Codebox_Abilities::can_hydrate_browser_blueprint_ref( new WP_Codebox_Test_Request( array( 'ref' => 'prepared:studio-native-preview:' . $source_digest ) ) ), 'Expected public prepared blueprint refs to be hydratable.' );
expect( WP_Codebox_Abilities::can_hydrate_browser_blueprint_ref( new WP_Codebox_Test_Request( array( 'cache_key' => 'studio-native-preview', 'input_hash' => $source_digest ) ) ), 'Expected public prepared blueprint cache key and input hash to be hydratable.' );
expect( ! WP_Codebox_Abilities::can_hydrate_browser_blueprint_ref( new WP_Codebox_Test_Request( array( 'ref' => 'prepared:studio-native-preview:not-a-hash' ) ) ), 'Expected malformed public prepared blueprint refs to remain forbidden.' );

$miss = WP_Codebox_Abilities::get_browser_contained_site_status(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
	)
);

expect( ! is_wp_error( $miss ), 'Expected miss status lookup to return an envelope.' );
expect( 'wp-codebox/browser-contained-site-status/v1' === $miss['schema'], 'Expected status schema.' );
expect( false === $miss['success'], 'Expected miss success=false.' );
expect( 'materialize' === $miss['open_mode'], 'Expected miss open_mode=materialize.' );
expect( 'none' === $miss['reuse_level'], 'Expected miss reuse_level=none.' );
expect( true === $miss['requires_materialization'], 'Expected miss to require materialization.' );
expect( false === $miss['prepared_runtime_recoverable'], 'Expected miss prepared_runtime_recoverable=false.' );
expect( false === $miss['live'], 'Expected miss live=false.' );
expect( false === $miss['current'], 'Expected miss current=false.' );
expect( false === $miss['materialized'], 'Expected miss materialized=false.' );
expect( 'browser-contained-site:studio-native-preview:' . $source_digest === $miss['recovery_handle'], 'Expected stable miss recovery handle.' );

$miss_decision = WP_Codebox_Abilities::preview_reuse_decision(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
	)
);

expect( ! is_wp_error( $miss_decision ), 'Expected miss preview reuse decision to return an envelope.' );
expect( 'wp-codebox/preview-reuse-decision/v1' === $miss_decision['schema'], 'Expected preview reuse decision schema.' );
expect( 'create-new' === $miss_decision['action'], 'Expected miss preview decision to create a new contained site.' );
expect( true === $miss_decision['reload_required'], 'Expected miss preview decision to require reload/materialization.' );
expect( 'materialize' === $miss_decision['open_mode'], 'Expected miss preview decision open_mode=materialize.' );
expect( isset( $miss_decision['identity_key'] ) && 64 === strlen( $miss_decision['identity_key'] ), 'Expected stable decision identity key.' );

$GLOBALS['wp_codebox_test_transient'] = array(
	'schema'                 => 'wp-codebox/browser-prepared-runtime-artifact/v1',
	'cache_key'              => 'studio-native-preview',
	'input_hash'             => $source_digest,
	'source_digest'          => array( 'algorithm' => 'sha256', 'value' => $source_digest ),
	'artifact_digest'        => array( 'algorithm' => 'sha256', 'value' => $artifact_digest ),
	'materialization_digest' => array( 'algorithm' => 'sha256', 'value' => $materialization_digest ),
	'created_at'             => '2026-01-02T03:04:05+00:00',
	'blueprint'              => array( 'steps' => array() ),
);

$rest_blueprint = WP_Codebox_Abilities::rest_browser_blueprint_ref( new WP_REST_Request( array( 'ref' => 'prepared:studio-native-preview:' . $source_digest ) ) );
expect( ! is_wp_error( $rest_blueprint ), 'Expected REST blueprint ref to return a raw Blueprint.' );
expect( ! isset( $rest_blueprint['success'] ), 'Expected REST blueprint ref to omit the hydration envelope.' );
expect( isset( $rest_blueprint['steps'] ) && is_array( $rest_blueprint['steps'] ), 'Expected REST blueprint ref to return the Blueprint root.' );

$recipe_method = new ReflectionMethod( WP_Codebox_Abilities::class, 'browser_agent_recipe' );
$recipe = $recipe_method->invoke(
	null,
	array(
		'goal'               => 'Import a browser artifact.',
		'target'             => array( 'kind' => 'recipe-smoke' ),
		'expected_artifacts' => array( 'preview' ),
	),
	'recipe-smoke-session',
	array(
		'task_path'   => '/tmp/recipe-smoke-task.json',
		'result_path' => '/tmp/recipe-smoke-result.json',
		'invocation'  => array(
			'type'  => 'ability',
			'name'  => 'static-site-importer/import-website-artifact',
			'input' => array(),
		),
	),
	array(
		'steps' => array(
			array(
				'step'     => 'login',
				'username' => 'admin',
				'password' => 'password',
			),
		),
	),
	array(),
	array( 'schema' => 'wp-codebox/browser-agent-task-payload/v1' )
);
expect( ! is_wp_error( $recipe ), 'Expected browser agent recipe smoke to build.' );
$recipe_steps = is_array( $recipe['runtime']['blueprint']['steps'] ?? null ) ? $recipe['runtime']['blueprint']['steps'] : array();
$recipe_run_php_steps = array_values( array_filter( $recipe_steps, static fn( array $step ): bool => 'runPHP' === ( $step['step'] ?? '' ) ) );
expect( count( $recipe_run_php_steps ) >= 1, 'Expected browser recipe Blueprint to include the runner runPHP step.' );
expect( str_contains( (string) ( $recipe_run_php_steps[0]['code'] ?? '' ), 'static-site-importer/import-website-artifact' ), 'Expected browser recipe Blueprint runPHP step to execute the requested invocation.' );

$status = WP_Codebox_Abilities::get_browser_contained_site_status(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
	)
);

expect( ! is_wp_error( $status ), 'Expected recoverable status lookup to return an envelope.' );
expect( true === $status['success'], 'Expected recoverable success=true.' );
expect( 'reuse_prepared_runtime' === $status['open_mode'], 'Expected recoverable open_mode=reuse_prepared_runtime.' );
expect( 'prepared_runtime' === $status['reuse_level'], 'Expected recoverable reuse_level=prepared_runtime.' );
expect( false === $status['requires_materialization'], 'Expected recoverable runtime not to require materialization.' );
expect( true === $status['prepared_runtime_recoverable'], 'Expected prepared runtime to be recoverable.' );
expect( $artifact_digest === $status['artifact_digest']['value'], 'Expected artifact digest to be surfaced.' );
expect( $materialization_digest === $status['materialization_digest']['value'], 'Expected materialization digest to be surfaced.' );

$open = WP_Codebox_Abilities::open_browser_contained_site(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
		'playground'    => array(
			'public_url'         => 'https://preview.example.test',
			'site_url'           => 'https://preview.example.test/wp',
			'local_url'          => 'http://localhost:8881/preview',
			'lease'              => array( 'status' => 'active', 'owner' => 'php-smoke' ),
			'reachability'       => array( 'status' => 'reachable', 'http_status' => 200, 'probes' => array( array( 'kind' => 'http' ) ) ),
			'evidence_refs'      => array( array( 'kind' => 'probe-log', 'path' => 'files/probe.json' ) ),
		),
	)
);

expect( ! is_wp_error( $open ), 'Expected open to return an envelope.' );
expect( true === $open['success'], 'Expected open success=true.' );
expect( 'wp-codebox/browser-contained-site-open/v1' === $open['schema'], 'Expected open schema.' );
expect( 'reuse_prepared_runtime' === $open['open_mode'], 'Expected open open_mode=reuse_prepared_runtime.' );
expect( 'prepared_runtime' === $open['reuse_level'], 'Expected open reuse_level=prepared_runtime.' );
expect( false === $open['requires_materialization'], 'Expected open not to require materialization.' );
expect( isset( $open['preview_boot']['blueprint_ref_dto']['hydration_endpoint'] ), 'Expected preview boot hydration endpoint.' );
expect( 'wp-codebox/preview-lease/v1' === $open['preview_lease']['schema'], 'Expected preview lease DTO.' );
expect( 'https://preview.example.test' === $open['preview_lease']['public_url'], 'Expected canonical public preview URL.' );
expect( 'http://localhost:8881/preview' === $open['preview_lease']['local_url'], 'Expected local preview URL to remain distinct.' );
expect( 'active' === $open['preview_lease']['lease']['status'], 'Expected active preview lease.' );
expect( 'php-smoke' === $open['preview_lease']['lease']['owner'], 'Expected lease owner evidence.' );
expect( 'reachable' === $open['preview_lease']['reachability']['status'], 'Expected reachability evidence.' );
expect( 'browser-contained-site:studio-native-preview:' . $source_digest === $open['recovery_handle'], 'Expected stable open recovery handle.' );
expect( 'reuse_prepared_runtime' === $open['contained_site']['open_mode'], 'Expected contained site lifecycle fields.' );

$reuse_decision = WP_Codebox_Abilities::preview_reuse_decision(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
	)
);

expect( ! is_wp_error( $reuse_decision ), 'Expected recoverable preview reuse decision to return an envelope.' );
expect( 'hydrate-ref' === $reuse_decision['action'], 'Expected recoverable preview decision to hydrate a prepared ref.' );
expect( false === $reuse_decision['reload_required'], 'Expected recoverable preview decision not to require reload.' );
expect( 'prepared_runtime' === $reuse_decision['reuse_level'], 'Expected recoverable preview decision reuse level.' );
expect( true === $reuse_decision['prepared_runtime_recoverable'], 'Expected recoverable preview decision to surface prepared runtime recovery.' );

$open_or_create = WP_Codebox_Abilities::open_or_create_browser_contained_site(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
		'playground'    => array(
			'preview_public_url' => 'https://preview.example.test',
			'site_url'           => 'https://preview.example.test/wp',
			'local_url'          => 'http://localhost:8881/preview',
			'lease'              => array( 'status' => 'active' ),
		),
	)
);

expect( ! is_wp_error( $open_or_create ), 'Expected open-or-create to return an envelope.' );
expect( true === $open_or_create['success'], 'Expected open-or-create success=true for reusable prepared runtime.' );
expect( 'wp-codebox/browser-contained-site-open-or-create/v1' === $open_or_create['schema'], 'Expected open-or-create schema.' );
expect( 'opened' === $open_or_create['action'], 'Expected open-or-create to open reusable prepared runtime.' );
expect( false === $open_or_create['reload_required'], 'Expected opened reusable runtime not to require reload.' );
expect( 'hydrate-ref' === $open_or_create['decision']['action'], 'Expected open-or-create decision to hydrate ref.' );
expect( isset( $open_or_create['preview_boot']['blueprint_ref_dto']['hydration_endpoint'] ), 'Expected open-or-create preview boot hydration endpoint.' );
expect( 'wp-codebox/preview-lease/v1' === $open_or_create['preview_lease']['schema'], 'Expected open-or-create preview lease DTO.' );

$boot = WP_Codebox_Abilities::boot_browser_contained_site_session(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
		'playground'    => array(
			'preview_public_url' => 'https://preview.example.test',
			'site_url'           => 'https://preview.example.test/wp',
			'local_url'          => 'http://localhost:8881/preview',
			'lease'              => array( 'status' => 'active' ),
		),
	)
);

expect( ! is_wp_error( $boot ), 'Expected boot facade to return an envelope.' );
expect( true === $boot['success'], 'Expected boot facade success=true.' );
expect( 'wp-codebox/browser-contained-site-boot-result/v1' === $boot['schema'], 'Expected boot result schema.' );
expect( 'wp-codebox/browser-contained-site-boot/v1' === $boot['boot']['schema'], 'Expected boot descriptor schema.' );
expect( ! isset( $boot['boot']['client_module_url'] ), 'Boot descriptor must not expose client_module_url.' );
expect( ! isset( $boot['boot']['remote_url'] ), 'Boot descriptor must not expose remote_url.' );
expect( ! isset( $boot['boot']['scope'] ), 'Boot descriptor must not expose scope as a consumer boot requirement.' );
expect( isset( $boot['boot']['blueprint_ref']['hydration_endpoint'] ), 'Boot descriptor should expose a Codebox blueprint ref hydrator.' );
expect( 'wp-codebox/browser-contained-site-startup-diagnostics/v1' === $boot['startup_diagnostics']['schema'], 'Expected startup diagnostics schema.' );
expect( 'active' === $boot['startup_diagnostics']['preview_lease_status'], 'Expected active lease diagnostics.' );

$preview_boot_ref = WP_Codebox_Abilities::preview_boot_ref(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
		'playground'    => array(
			'preview_public_url' => 'https://preview.example.test',
			'site_url'           => 'https://preview.example.test/wp',
			'local_url'          => 'http://localhost:8881/preview',
			'lease'              => array( 'status' => 'active' ),
		),
	)
);

expect( ! is_wp_error( $preview_boot_ref ), 'Expected preview boot ref facade to return an envelope.' );
expect( true === $preview_boot_ref['success'], 'Expected preview boot ref success=true.' );
expect( 'wp-codebox/preview-boot-ref/v1' === $preview_boot_ref['schema'], 'Expected preview boot ref schema.' );
expect( 'wp-codebox/browser-contained-site-boot/v1' === $preview_boot_ref['boot']['schema'], 'Expected stable boot descriptor.' );
expect( isset( $preview_boot_ref['blueprint_ref']['hydration_endpoint'] ), 'Expected stable blueprint ref hydration endpoint.' );
expect( ! isset( $preview_boot_ref['boot']['client_module_url'] ), 'Stable boot descriptor must not expose client_module_url.' );
expect( ! isset( $preview_boot_ref['boot']['remote_url'] ), 'Stable boot descriptor must not expose remote_url.' );
expect( ! isset( $preview_boot_ref['boot']['cors_proxy_url'] ), 'Stable boot descriptor must not expose cors_proxy_url.' );
expect( ! isset( $preview_boot_ref['boot']['scope'] ), 'Stable boot descriptor must not expose scope.' );
expect( ! isset( $preview_boot_ref['boot']['blueprint'] ), 'Stable boot descriptor must not expose raw blueprint.' );
expect( 'wp-codebox/browser-contained-site/v1' === $preview_boot_ref['compatibility']['contained_site_schema'], 'Expected contained-site compatibility schema.' );
expect( 'wp-codebox/browser-contained-site-boot-result/v1' === $preview_boot_ref['compatibility']['session_result_schema'], 'Expected session result compatibility schema.' );

$destroy = WP_Codebox_Abilities::destroy_browser_contained_site_session(
	array(
		'contained_site' => $boot['contained_site'],
		'preview_lease'  => $boot['preview_lease']['lease'],
	)
);

expect( ! is_wp_error( $destroy ), 'Expected destroy facade to return an envelope.' );
expect( true === $destroy['success'], 'Expected destroy success=true.' );
expect( 'wp-codebox/browser-contained-site-destroy/v1' === $destroy['schema'], 'Expected destroy schema.' );
expect( 'released' === $destroy['preview_lease']['lease']['status'], 'Expected released preview lease.' );

$raw_product_session = array(
	'success'          => true,
	'schema'           => 'wp-codebox/browser-playground-session/v1',
	'execution'        => 'browser-playground',
	'execution_scope'  => 'disposable-playground',
	'permission_model' => 'runtime-principal',
	'session'          => array( 'id' => 'product-smoke-session' ),
	'task_input'       => array(
		'goal'               => 'Create a disposable preview for smoke testing.',
		'target'             => array( 'kind' => 'php-smoke' ),
		'expected_artifacts' => array( 'preview' ),
	),
	'playground'       => array(
		'scope'              => 'product-smoke-session',
		'preview_url'        => '/wp-content/uploads/wp-codebox/artifacts/uploaded-site/index.html',
		'prepared_runtime'   => array(
			'schema'     => 'wp-codebox/browser-prepared-runtime/v1',
			'cache_key'  => 'product-smoke-cache',
			'input_hash' => $source_digest,
			'status'     => 'ready',
		),
	),
	'contained_site'   => array(
		'schema'     => 'wp-codebox/browser-contained-site/v1',
		'site_id'    => 'product-smoke-cache',
		'preview_id' => 'preview-product-smoke',
		'session_id' => 'product-smoke-session',
		'status'     => 'ready',
	),
	'artifacts'        => array(
		'schema' => 'wp-codebox/browser-artifacts/v1',
		'files'  => array(
			array(
				'path'    => 'uploaded-site/index.html',
				'kind'    => 'html',
				'size'    => 16,
				'sha256'  => str_repeat( 'd', 64 ),
				'content' => '<h1>Preview</h1>',
			),
		),
	),
	'signals'          => array(
		'ready_to_code' => array( 'schema' => 'wp-codebox/signal/v1', 'emitted' => true ),
	),
);
$response_method = new ReflectionMethod( WP_Codebox_Abilities::class, 'browser_session_response_for_input' );
$product_session = $response_method->invoke( null, $raw_product_session, array() );

expect( ! is_wp_error( $product_session ), 'Expected product browser session DTO.' );
expect( 'wp-codebox/browser-session-product-dto/v1' === $product_session['schema'], 'Expected product session DTO schema.' );
expect( true === $product_session['success'], 'Expected product session success=true.' );
expect( isset( $product_session['preview_boot'] ), 'Expected product session preview boot.' );
expect( isset( $product_session['preview_ref'] ), 'Expected product session preview ref.' );
expect( isset( $product_session['preview_lease'] ), 'Expected product session preview lease.' );
expect( isset( $product_session['preview_reference'] ), 'Expected product session preview reference.' );
expect( 'wp-codebox/browser-preview-reference/v1' === $product_session['preview_reference']['schema'], 'Expected preview reference schema.' );
expect( isset( $product_session['blueprint_ref'] ), 'Expected product session blueprint ref.' );
expect( isset( $product_session['evidence_ref'] ), 'Expected product session evidence ref.' );
expect( 'wp-codebox/browser-session-evidence-ref/v1' === $product_session['evidence_ref']['schema'], 'Expected evidence ref schema.' );
expect( ! isset( $product_session['playground'] ), 'Product DTO must not expose raw playground.' );
expect( ! isset( $product_session['task_payload'] ), 'Product DTO must not expose raw task payload.' );

$evidence_key = 'wp_codebox_browser_session_evidence_' . $product_session['evidence_ref']['id'];
expect( isset( $GLOBALS['wp_codebox_test_transients'][ $evidence_key ] ), 'Expected evidence transient to be stored.' );
$evidence = $GLOBALS['wp_codebox_test_transients'][ $evidence_key ]['value'];
expect( 'wp-codebox/browser-session-evidence/v1' === $evidence['schema'], 'Expected evidence schema.' );
expect( $product_session['session_id'] === $evidence['session_id'], 'Expected evidence session id.' );
expect( isset( $evidence['preview_reference'] ), 'Expected evidence preview reference.' );
expect( false === str_contains( wp_json_encode( $evidence ), '<h1>Preview</h1>' ), 'Evidence must not store raw uploaded content.' );

$executable_ref = WP_Codebox_Browser_Task_Builder::executable_blueprint_ref( $product_session );
expect( $product_session['blueprint_ref'] === $executable_ref, 'Expected executable blueprint ref from product DTO.' );

$compact_product_session = array(
	'success'        => true,
	'schema'         => 'wp-codebox/browser-session-product-dto/v1',
	'session_id'     => 'compact-product-smoke-session',
	'preview_boot'   => array(
		'schema'        => 'wp-codebox/browser-preview-boot-config/v1',
		'blueprint_ref' => 'inline-session-blueprint',
	),
	'contained_site' => array(
		'schema'   => 'wp-codebox/browser-contained-site/v1',
		'site_id'  => 'product-smoke-cache',
		'status'   => 'ready',
		'recovery' => array(
			'input' => array(
				'schema'     => 'wp-codebox/browser-prepared-runtime/v1',
				'cache_key'  => 'product-smoke-cache',
				'input_hash' => $source_digest,
				'status'     => 'ready',
			),
		),
	),
);

$compact_executable_ref = WP_Codebox_Browser_Task_Builder::executable_blueprint_ref( $compact_product_session );
expect( 'prepared:product-smoke-cache:' . $source_digest === $compact_executable_ref['ref'], 'Expected executable blueprint ref from compact contained-site recovery input.' );
expect( isset( $compact_executable_ref['hydration_endpoint'] ), 'Expected compact executable ref hydration endpoint.' );

fwrite( STDOUT, "PHP browser contained site contract smoke passed\n" );
