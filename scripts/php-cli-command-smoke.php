<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

final class WP_Error {
	public function __construct( private string $code = '', private string $message = '', private mixed $data = null ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): mixed { return $this->data; }
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function wp_json_encode( mixed $value, int $flags = 0 ): string|false {
	return json_encode( $value, $flags );
}

final class WP_CLI {
	/** @var array<string,callable> */
	public static array $commands = array();
	/** @var string[] */
	public static array $lines = array();

	public static function add_command( string $name, callable $callable ): void {
		self::$commands[ $name ] = $callable;
	}

	public static function line( string $message ): void {
		self::$lines[] = $message;
	}

	public static function warning( string $message ): void {
		self::$lines[] = 'warning: ' . $message;
	}

	public static function error( string $message ): void {
		throw new RuntimeException( $message );
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-json.php';

final class WP_Codebox_Abilities {
	/** @var array<int,array{method:string,input:array<string,mixed>}> */
	public static array $calls = array();

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function list_artifacts( array $input ): array { return self::record( 'list_artifacts', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function get_artifact( array $input ): array { return self::record( 'get_artifact', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function apply_artifact_preflight( array $input ): array { return self::record( 'apply_artifact_preflight', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function stage_artifact_apply( array $input ): array { return self::record( 'stage_artifact_apply', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function apply_approved_artifact( array $input ): array { return self::record( 'apply_approved_artifact', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function create_browser_playground_session( array $input ): array { return self::record( 'create_browser_playground_session', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_agent_task( array $input ): array { return self::record( 'run_agent_task', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_agent_task_batch( array $input ): array { return self::record( 'run_agent_task_batch', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_agent_task_fanout( array $input ): array { return self::record( 'run_agent_task_fanout', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_runtime_task( array $input ): array { return self::record( 'run_runtime_task', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_wordpress_workload( array $input ): array { return self::record( 'run_wordpress_workload', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_runtime_package( array $input ): array { return self::record( 'run_runtime_package', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function resolve_runtime_requirements( array $input ): array { return self::record( 'resolve_runtime_requirements', $input ); }
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_fuzz_suite( array $input ): array { return self::record( 'run_fuzz_suite', $input ); }

	/** @param array<string,mixed> $input @return array<string,mixed> */
	private static function record( string $method, array $input ): array {
		self::$calls[] = array( 'method' => $method, 'input' => $input );
		return array( 'success' => true, 'method' => $method, 'input' => $input );
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-api.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-cli-command.php';

function expect( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, $message . PHP_EOL );
		exit( 1 );
	}
}

WP_Codebox_CLI_Command::register();

$expected_commands = array(
	'codebox artifacts list',
	'codebox artifacts get',
	'codebox artifacts preflight-apply',
	'codebox artifacts stage-apply',
	'codebox artifacts apply',
	'codebox runtime descriptor',
	'codebox browser-session create',
	'codebox run-agent-task',
	'codebox run-agent-task-batch',
	'codebox run-agent-task-fanout',
	'codebox run-runtime-task',
	'codebox run-wordpress-workload',
	'codebox run-runtime-package',
	'codebox resolve-runtime-requirements',
	'codebox wordpress-fuzz-runtime-contract',
	'codebox run-fuzz-suite',
);

foreach ( $expected_commands as $command ) {
	expect( isset( WP_CLI::$commands[ $command ] ), 'Missing WP-CLI command: ' . $command );
}

WP_CLI::$lines = array();
WP_Codebox_Abilities::$calls = array();
WP_CLI::$commands['codebox runtime descriptor']( array(), array() );
$descriptor_output = json_decode( WP_CLI::$lines[0] ?? '', true );
expect( is_array( $descriptor_output ), 'Expected JSON output for runtime descriptor command.' );
expect( 'wp-codebox/runtime-descriptor/v1' === $descriptor_output['schema'], 'Runtime descriptor command must emit descriptor schema.' );
expect( in_array( 'contract-manifest:read', $descriptor_output['capabilities'], true ), 'Runtime descriptor command must include contract manifest capability.' );
expect( 0 === count( WP_Codebox_Abilities::$calls ), 'Runtime descriptor command must not dispatch through backend abilities.' );

WP_CLI::$lines = array();
WP_Codebox_Abilities::$calls = array();
WP_CLI::$commands['codebox wordpress-fuzz-runtime-contract']( array(), array() );
$fuzz_contract_output = json_decode( WP_CLI::$lines[0] ?? '', true );
expect( is_array( $fuzz_contract_output ), 'Expected JSON output for WordPress fuzz runtime contract command.' );
expect( 'wp-codebox/wordpress-fuzz-runtime-contract/v1' === $fuzz_contract_output['schema'], 'WordPress fuzz runtime contract command must emit descriptor schema.' );
expect( null === $fuzz_contract_output['destructiveModeRequirements']['rawDeleteCapability'], 'WordPress fuzz runtime contract must explicitly reject raw delete capability.' );
expect( 'wp-codebox/delete-boundary-artifact/v1' === $fuzz_contract_output['hbex']['schemaIds']['deleteBoundaryArtifact'], 'WordPress fuzz runtime contract must include HBEX delete boundary schema id.' );
expect( 0 === count( WP_Codebox_Abilities::$calls ), 'WordPress fuzz runtime contract command must not dispatch through backend abilities.' );

function run_cli_command( string $command, array $args = array(), array $assoc_args = array() ): array {
	WP_CLI::$lines = array();
	WP_Codebox_Abilities::$calls = array();

	WP_CLI::$commands[ $command ]( $args, $assoc_args );

	$output = json_decode( WP_CLI::$lines[0] ?? '', true );
	expect( is_array( $output ), 'Expected JSON output for ' . $command );
	expect( 1 === count( WP_Codebox_Abilities::$calls ), 'Expected one public API dispatch for ' . $command );

	return array( 'output' => $output, 'call' => WP_Codebox_Abilities::$calls[0] );
}

$runtime_package = run_cli_command( 'codebox run-runtime-package', array(), array( 'input-json' => '{"goal":"package"}', 'package' => '{"schema":"wp-codebox/runtime-package/v1"}' ) );
expect( 'run_runtime_package' === $runtime_package['call']['method'], 'Runtime package command must dispatch through public API.' );
expect( 'package' === $runtime_package['call']['input']['goal'], 'input-json payload should be preserved.' );
expect( 'wp-codebox/runtime-package/v1' === $runtime_package['call']['input']['package']['schema'], 'package flag should decode as JSON object.' );

$fuzz_suite = run_cli_command( 'codebox run-fuzz-suite', array(), array( 'suite' => '{"id":"php-in-process-suite"}', 'cases' => '[{"id":"rest-status"}]' ) );
expect( 'run_fuzz_suite' === $fuzz_suite['call']['method'], 'Fuzz suite command must dispatch through public API.' );
expect( 'php-in-process-suite' === $fuzz_suite['call']['input']['suite']['id'], 'suite flag should decode as JSON object.' );
expect( 'rest-status' === $fuzz_suite['call']['input']['cases'][0]['id'], 'cases flag should decode as JSON array.' );

$requirements = run_cli_command( 'codebox resolve-runtime-requirements', array(), array( 'runtime-provider' => 'local', 'capabilities' => 'php-in-process,rest' ) );
expect( 'resolve_runtime_requirements' === $requirements['call']['method'], 'Requirements command must dispatch through public API.' );
expect( 'local' === $requirements['call']['input']['runtime_provider'], 'runtime-provider flag should select the runtime provider.' );
expect( array( 'php-in-process', 'rest' ) === $requirements['call']['input']['capabilities'], 'capabilities flag should parse as a list.' );

$agent_task = run_cli_command( 'codebox run-agent-task', array(), array( 'goal' => 'public facade task' ) );
expect( 'run_agent_task' === $agent_task['call']['method'], 'Agent task command must dispatch through public API.' );

fwrite( STDOUT, "PHP CLI command smoke passed\n" );
