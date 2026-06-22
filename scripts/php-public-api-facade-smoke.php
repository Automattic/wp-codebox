<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

if ( ! class_exists( 'WP_Error' ) ) {
	final class WP_Error {
		public function __construct( private string $code = '', private string $message = '', private mixed $data = null ) {}
		public function get_error_code(): string { return $this->code; }
		public function get_error_message(): string { return $this->message; }
		public function get_error_data(): mixed { return $this->data; }
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-api.php';

final class WP_Codebox_Abilities {
	public static array $calls = array();

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function prepare_runner_workspace( array $input ): array {
		return self::record( 'prepare_runner_workspace', 'wp-codebox/runner-workspace-prepare-result/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function capture_runner_workspace( array $input ): array {
		return self::record( 'capture_runner_workspace', 'wp-codebox/runner-workspace-capture-result/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_runner_workspace_command( array $input ): array {
		return self::record( 'run_runner_workspace_command', 'wp-codebox/runner-workspace-command-result/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function publish_runner_workspace( array $input ): array {
		return self::record( 'publish_runner_workspace', 'wp-codebox/runner-workspace-publication-result/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_runtime_task( array $input ): array {
		return self::record( 'run_runtime_task', 'wp-codebox/runtime-task-result/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_wordpress_workload( array $input ): array {
		return self::record( 'run_wordpress_workload', 'wp-codebox/wordpress-workload-run-result/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_runtime_package( array $input ): array {
		return self::record( 'run_runtime_package', 'wp-codebox/runtime-package-result/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function create_browser_task_contract( array $input ): array {
		return self::record( 'create_browser_task_contract', 'wp-codebox/browser-task-contract/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function create_browser_materializer_contract( array $input ): array {
		return self::record( 'create_browser_materializer_contract', 'wp-codebox/browser-materializer-contract/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function get_browser_contained_site_status( array $input ): array {
		return self::record( 'get_browser_contained_site_status', 'wp-codebox/browser-contained-site-status/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function open_or_create_browser_contained_site( array $input ): array {
		return self::record( 'open_or_create_browser_contained_site', 'wp-codebox/browser-contained-site-open-or-create/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function request_host_delegation( array $input ): array {
		return self::record( 'request_host_delegation', 'wp-codebox/host-delegation-result/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function normalize_browser_artifact_bundle( array $input ): array {
		return self::record( 'normalize_browser_artifact_bundle', 'wp-codebox/browser-artifact-bundle/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function persist_browser_artifact( array $input ): array {
		return self::record( 'persist_browser_artifact', 'wp-codebox/artifact-result/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function import_artifact_bundle( array $input ): array {
		return self::record( 'import_artifact_bundle', 'wp-codebox/import-artifact-bundle/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function reimport_artifact_bundle( array $input ): array {
		return self::record( 'reimport_artifact_bundle', 'wp-codebox/reimport-artifact-bundle/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	private static function record( string $method, string $schema, array $input ): array {
		self::$calls[] = array( 'method' => $method, 'input' => $input );
		return array( 'success' => true, 'schema' => $schema, 'method' => $method );
	}
}

function expect( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, $message . PHP_EOL );
		exit( 1 );
	}
}

$expected_methods = array(
	'execute_ability',
	'run_agent_task',
	'run_agent_task_batch',
	'run_agent_task_fanout',
	'run_runtime_task',
	'run_wordpress_workload',
	'run_runtime_package',
	'create_browser_session',
	'create_browser_task_contract',
	'create_browser_materializer_contract',
	'create_browser_contained_site_session',
	'get_browser_session_status',
	'browser_contained_site_status',
	'preview_reuse_decision',
	'open_browser_session',
	'open_or_create_browser_session',
	'open_or_create_browser_contained_site',
	'request_host_delegation',
	'list_artifacts',
	'get_artifact',
	'normalize_artifact_bundle',
	'persist_artifact',
	'import_artifact',
	'reimport_artifact',
	'preflight_artifact_apply',
	'stage_artifact_apply',
	'apply_approved_artifact',
	'prepare_runner_workspace',
	'capture_runner_workspace',
	'run_runner_workspace_command',
	'publish_runner_workspace',
);

$reflection = new ReflectionClass( WP_Codebox_API::class );
foreach ( $expected_methods as $method ) {
	expect( $reflection->hasMethod( $method ), 'Missing public API method: ' . $method );
	expect( $reflection->getMethod( $method )->isPublic(), 'API method is not public: ' . $method );
}

$blocked = WP_Codebox_API::execute_ability( 'external-backend/workspace-show', array() );
expect( $blocked instanceof WP_Error, 'Expected non-wp-codebox ability names to be rejected.' );
expect( 'wp_codebox_api_ability_not_supported' === $blocked->get_error_code(), 'Expected unsupported ability error code.' );
expect( ! str_contains( json_encode( $blocked->get_error_data(), JSON_UNESCAPED_SLASHES ) ?: '', 'external-backend' ), 'Unsupported ability errors must not echo backend ability names.' );

foreach ( array( 'agents/run-runtime-package', 'datamachine/jobs-list', 'playground/run-blueprint' ) as $raw_ability ) {
	$blocked = WP_Codebox_API::execute_ability( $raw_ability, array() );
	expect( $blocked instanceof WP_Error, 'Expected raw backend ability name to be rejected: ' . $raw_ability );
}

$runner_workspace_abilities = array(
	'wp-codebox/runner-workspace-prepare' => array( 'method' => 'prepare_runner_workspace', 'schema' => 'wp-codebox/runner-workspace-prepare-result/v1' ),
	'wp-codebox/runner-workspace-capture' => array( 'method' => 'capture_runner_workspace', 'schema' => 'wp-codebox/runner-workspace-capture-result/v1' ),
	'wp-codebox/runner-workspace-command' => array( 'method' => 'run_runner_workspace_command', 'schema' => 'wp-codebox/runner-workspace-command-result/v1' ),
	'wp-codebox/runner-workspace-publish' => array( 'method' => 'publish_runner_workspace', 'schema' => 'wp-codebox/runner-workspace-publication-result/v1' ),
	'wp-codebox/prepare-runner-workspace' => array( 'method' => 'prepare_runner_workspace', 'schema' => 'wp-codebox/runner-workspace-prepare-result/v1' ),
	'wp-codebox/capture-runner-workspace' => array( 'method' => 'capture_runner_workspace', 'schema' => 'wp-codebox/runner-workspace-capture-result/v1' ),
	'wp-codebox/run-runner-workspace-command' => array( 'method' => 'run_runner_workspace_command', 'schema' => 'wp-codebox/runner-workspace-command-result/v1' ),
	'wp-codebox/publish-runner-workspace' => array( 'method' => 'publish_runner_workspace', 'schema' => 'wp-codebox/runner-workspace-publication-result/v1' ),
);

foreach ( $runner_workspace_abilities as $ability_name => $expected ) {
	$result = WP_Codebox_API::execute_ability( $ability_name, array( 'workspace' => 'wp-codebox@task', 'repo' => 'wp-codebox', 'command' => 'php -l file.php' ) );
	expect( is_array( $result ), 'Expected runner workspace facade result for ' . $ability_name );
	expect( $expected['method'] === $result['method'], 'Expected runner workspace facade method for ' . $ability_name );
	expect( $expected['schema'] === $result['schema'], 'Expected runner workspace facade schema for ' . $ability_name );
}

$public_abilities = array(
	'wp-codebox/run-runtime-task' => array( 'method' => 'run_runtime_task', 'schema' => 'wp-codebox/runtime-task-result/v1' ),
	'wp-codebox/run-wordpress-workload' => array( 'method' => 'run_wordpress_workload', 'schema' => 'wp-codebox/wordpress-workload-run-result/v1' ),
	'wp-codebox/run-runtime-package' => array( 'method' => 'run_runtime_package', 'schema' => 'wp-codebox/runtime-package-result/v1' ),
	'wp-codebox/create-browser-task-contract' => array( 'method' => 'create_browser_task_contract', 'schema' => 'wp-codebox/browser-task-contract/v1' ),
	'wp-codebox/create-task-contract' => array( 'method' => 'create_browser_task_contract', 'schema' => 'wp-codebox/browser-task-contract/v1' ),
	'wp-codebox/create-browser-materializer-contract' => array( 'method' => 'create_browser_materializer_contract', 'schema' => 'wp-codebox/browser-materializer-contract/v1' ),
	'wp-codebox/open-or-create-browser-contained-site' => array( 'method' => 'open_or_create_browser_contained_site', 'schema' => 'wp-codebox/browser-contained-site-open-or-create/v1' ),
	'wp-codebox/open-contained-runtime' => array( 'method' => 'open_or_create_browser_contained_site', 'schema' => 'wp-codebox/browser-contained-site-open-or-create/v1' ),
	'wp-codebox/get-browser-contained-site-status' => array( 'method' => 'get_browser_contained_site_status', 'schema' => 'wp-codebox/browser-contained-site-status/v1' ),
	'wp-codebox/normalize-browser-artifact-bundle' => array( 'method' => 'normalize_browser_artifact_bundle', 'schema' => 'wp-codebox/browser-artifact-bundle/v1' ),
	'wp-codebox/persist-browser-artifact' => array( 'method' => 'persist_browser_artifact', 'schema' => 'wp-codebox/artifact-result/v1' ),
	'wp-codebox/import-artifact-bundle' => array( 'method' => 'import_artifact_bundle', 'schema' => 'wp-codebox/import-artifact-bundle/v1' ),
	'wp-codebox/reimport-artifact-bundle' => array( 'method' => 'reimport_artifact_bundle', 'schema' => 'wp-codebox/reimport-artifact-bundle/v1' ),
	'wp-codebox/request-host-delegation' => array( 'method' => 'request_host_delegation', 'schema' => 'wp-codebox/host-delegation-result/v1' ),
);

foreach ( $public_abilities as $ability_name => $expected ) {
	$result = WP_Codebox_API::execute_ability( $ability_name, array( 'goal' => 'Exercise public facade dispatch.' ) );
	expect( is_array( $result ), 'Expected public facade result for ' . $ability_name );
	expect( $expected['method'] === $result['method'], 'Expected public facade method for ' . $ability_name );
	expect( $expected['schema'] === $result['schema'], 'Expected public facade schema for ' . $ability_name );
}

foreach ( array(
	'wp-codebox/browser-contained-site-status',
	'wp-codebox/normalize-artifact-bundle',
	'wp-codebox/persist-artifact',
	'wp-codebox/import-artifact',
	'wp-codebox/reimport-artifact',
) as $unregistered_short_name ) {
	$blocked = WP_Codebox_API::execute_ability( $unregistered_short_name, array() );
	expect( $blocked instanceof WP_Error, 'Expected unregistered shorthand ability to be rejected: ' . $unregistered_short_name );
}

fwrite( STDOUT, "PHP public API facade smoke passed\n" );
