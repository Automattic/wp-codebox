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
	'create_browser_session',
	'create_browser_contained_site_session',
	'get_browser_session_status',
	'preview_reuse_decision',
	'open_browser_session',
	'open_or_create_browser_session',
	'list_artifacts',
	'get_artifact',
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

$blocked = WP_Codebox_API::execute_ability( 'datamachine-code/workspace-show', array() );
expect( $blocked instanceof WP_Error, 'Expected non-wp-codebox ability names to be rejected.' );
expect( 'wp_codebox_api_ability_not_supported' === $blocked->get_error_code(), 'Expected unsupported ability error code.' );
expect( ! str_contains( json_encode( $blocked->get_error_data(), JSON_UNESCAPED_SLASHES ) ?: '', 'datamachine-code' ), 'Unsupported ability errors must not echo backend ability names.' );

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

fwrite( STDOUT, "PHP public API facade smoke passed\n" );
