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
	public static function run_fuzz_suite( array $input ): array {
		return self::record( 'run_fuzz_suite', 'wp-codebox/fuzz-suite-result/v1', $input );
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
	public static function list_artifacts( array $input ): array {
		return self::record( 'list_artifacts', 'wp-codebox/artifact-list/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function get_artifact( array $input ): array {
		return self::record( 'get_artifact', 'wp-codebox/artifact/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function inspect_artifact( array $input ): array {
		return self::record( 'inspect_artifact', 'wp-codebox/artifact-inspection/v1', $input );
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
	public static function apply_artifact_preflight( array $input ): array {
		return self::record( 'apply_artifact_preflight', 'wp-codebox/artifact-apply-preflight/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function stage_artifact_apply( array $input ): array {
		return self::record( 'stage_artifact_apply', 'wp-codebox/pending-apply/v1', $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function apply_approved_artifact( array $input ): array {
		return self::record( 'apply_approved_artifact', 'wp-codebox/artifact-apply/v1', $input );
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
	'public_abilities',
	'public_contract_schemas',
	'public_contract_primitives',
	'runtime_descriptor',
	'runtime_contract_manifest',
	'run_agent_task',
	'run_agent_task_batch',
	'run_agent_task_fanout',
	'run_runtime_task',
	'run_wordpress_workload',
	'run_runtime_package',
	'run_fuzz_suite',
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
	'inspect_artifact',
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

$expected_constants = array(
	'ABILITY_LIST_ARTIFACTS' => 'wp-codebox/list-artifacts',
	'ABILITY_GET_ARTIFACT' => 'wp-codebox/get-artifact',
	'ABILITY_INSPECT_ARTIFACT' => 'wp-codebox/inspect-artifact',
	'ABILITY_APPLY_ARTIFACT_PREFLIGHT' => 'wp-codebox/apply-artifact-preflight',
	'ABILITY_STAGE_ARTIFACT_APPLY' => 'wp-codebox/stage-artifact-apply',
	'ABILITY_APPLY_APPROVED_ARTIFACT' => 'wp-codebox/apply-approved-artifact',
	'ARTIFACT_SCHEMA' => 'wp-codebox/artifact/v1',
	'ARTIFACT_INSPECTION_SCHEMA' => 'wp-codebox/artifact-inspection/v1',
	'ARTIFACT_APPLY_PREFLIGHT_SCHEMA' => 'wp-codebox/artifact-apply-preflight/v1',
	'ARTIFACT_APPLY_SCHEMA' => 'wp-codebox/artifact-apply/v1',
	'ARTIFACT_APPLY_RESULT_SCHEMA' => 'wp-codebox/apply-result/v1',
);
foreach ( $expected_constants as $constant => $value ) {
	expect( $reflection->hasConstant( $constant ), 'Missing public API constant: ' . $constant );
	expect( $value === $reflection->getConstant( $constant ), 'Unexpected public API constant value: ' . $constant );
}

$public_schemas = WP_Codebox_API::public_contract_schemas();
expect( 'wp-codebox/runtime-access/v1' === $public_schemas['runtimeSession']['access'], 'Expected runtime session access schema.' );
expect( 'wp-codebox/runtime-profile/v1' === $public_schemas['runtimeProfile']['profile'], 'Expected runtime profile schema.' );
expect( 'wp-codebox/headless-agent-task-request/v1' === $public_schemas['task']['headlessRequest'], 'Expected headless task request schema.' );
expect( 'wp-codebox/agent-runtime-workload/v1' === $public_schemas['agent']['workload'], 'Expected agent workload schema.' );
expect( 'wp-codebox/artifact-result-envelope/v1' === $public_schemas['artifact']['resultEnvelope'], 'Expected artifact envelope schema.' );
expect( 'wp-codebox/provider-credential-preflight/v1' === $public_schemas['credential']['preflight'], 'Expected redacted credential preflight schema.' );

$public_primitives = WP_Codebox_API::public_contract_primitives();
expect( 'wp-codebox/run-agent-task' === $public_primitives['task']['abilities']['run'], 'Expected task run ability.' );
expect( true === $public_primitives['credential']['redacted'], 'Expected credential primitive to advertise redaction.' );
expect( isset( WP_Codebox_API::public_abilities()['wp-codebox/run-agent-task'] ), 'Expected public ability accessor to include run-agent-task.' );

$blocked = WP_Codebox_API::execute_ability( 'external-backend/workspace-show', array() );
expect( $blocked instanceof WP_Error, 'Expected non-wp-codebox ability names to be rejected.' );
expect( 'wp_codebox_api_ability_not_supported' === $blocked->get_error_code(), 'Expected unsupported ability error code.' );
expect( ! str_contains( json_encode( $blocked->get_error_data(), JSON_UNESCAPED_SLASHES ) ?: '', 'external-backend' ), 'Unsupported ability errors must not echo backend ability names.' );

foreach ( array( 'agents/run-runtime-package', 'datamachine/jobs-list', 'playground/run-blueprint' ) as $raw_ability ) {
	$blocked = WP_Codebox_API::execute_ability( $raw_ability, array() );
	expect( $blocked instanceof WP_Error, 'Expected raw backend ability name to be rejected: ' . $raw_ability );
}

$descriptor = WP_Codebox_API::runtime_descriptor();
expect( 'wp-codebox/runtime-descriptor/v1' === $descriptor['schema'], 'Expected public runtime descriptor schema.' );
expect( 'available' === $descriptor['readiness']['status'], 'Expected descriptor readiness status.' );
expect( in_array( 'runtime-requirements:resolve', $descriptor['capabilities'], true ), 'Expected runtime requirements capability.' );
expect( 'wp-codebox/resolve-runtime-requirements' === $descriptor['abilities']['runtimeRequirements']['resolve'], 'Expected runtime requirements ability in descriptor.' );
expect( 'wp-codebox/wordpress-fuzz-runtime-contract/v1' === $descriptor['wordpressFuzzRuntimeContract']['schema'], 'Expected nested WordPress fuzz runtime contract.' );
expect( 'wp-codebox/runtime-contract-manifest/v1' === $descriptor['contractManifest']['schema'], 'Expected nested runtime contract manifest.' );

$fuzz_runtime_contract = WP_Codebox_API::wordpress_fuzz_runtime_contract();
expect( 'wp-codebox/wordpress-fuzz-runtime-contract/v1' === $fuzz_runtime_contract['schema'], 'Expected WordPress fuzz runtime contract schema.' );
expect( 'WP_Codebox_API::wordpress_fuzz_runtime_contract()' === $fuzz_runtime_contract['publicSurfaces']['phpFacade'], 'Expected PHP facade public surface.' );
expect( 'wp-codebox/run-fuzz-suite' === $fuzz_runtime_contract['publicSurfaces']['ability'], 'Expected ability public surface.' );
expect( 'wp codebox wordpress-fuzz-runtime-contract' === $fuzz_runtime_contract['publicSurfaces']['wpCli'], 'Expected WP-CLI public surface.' );
expect( null === $fuzz_runtime_contract['destructiveModeRequirements']['rawDeleteCapability'], 'Expected raw delete to be explicitly unsupported.' );
expect( in_array( 'checkpoint-per-case', $fuzz_runtime_contract['destructiveModeRequirements']['requiredResetModes'], true ), 'Expected destructive mode reset requirement.' );
expect( 'wp-codebox/delete-boundary-artifact/v1' === $fuzz_runtime_contract['hbex']['schemaIds']['deleteBoundaryArtifact'], 'Expected HBEX delete boundary schema id.' );
expect( in_array( 'private-runtime-probing', array_column( $fuzz_runtime_contract['unsupportedCapabilities'], 'id' ), true ), 'Expected explicit unsupported probing capability.' );

$fuzz_contract_ability = WP_Codebox_API::execute_ability( 'wp-codebox/wordpress-fuzz-runtime-contract', array( 'ignored' => true ) );
expect( is_array( $fuzz_contract_ability ), 'Expected WordPress fuzz runtime contract ability facade result.' );
expect( 'wp-codebox/wordpress-fuzz-runtime-contract/v1' === $fuzz_contract_ability['schema'], 'Expected WordPress fuzz runtime contract ability schema.' );

$descriptor_ability = WP_Codebox_API::execute_ability( 'wp-codebox/runtime-descriptor', array( 'ignored' => true ) );
expect( is_array( $descriptor_ability ), 'Expected descriptor ability facade result.' );
expect( 'wp-codebox/runtime-descriptor/v1' === $descriptor_ability['schema'], 'Expected descriptor ability schema.' );
expect( 0 === count( WP_Codebox_Abilities::$calls ), 'Descriptor must not dispatch through runtime backend internals.' );

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
	'wp-codebox/run-fuzz-suite' => array( 'method' => 'run_fuzz_suite', 'schema' => 'wp-codebox/fuzz-suite-result/v1' ),
	'wp-codebox/create-browser-task-contract' => array( 'method' => 'create_browser_task_contract', 'schema' => 'wp-codebox/browser-task-contract/v1' ),
	'wp-codebox/create-browser-materializer-contract' => array( 'method' => 'create_browser_materializer_contract', 'schema' => 'wp-codebox/browser-materializer-contract/v1' ),
	'wp-codebox/open-or-create-browser-contained-site' => array( 'method' => 'open_or_create_browser_contained_site', 'schema' => 'wp-codebox/browser-contained-site-open-or-create/v1' ),
	'wp-codebox/get-browser-contained-site-status' => array( 'method' => 'get_browser_contained_site_status', 'schema' => 'wp-codebox/browser-contained-site-status/v1' ),
	'wp-codebox/normalize-browser-artifact-bundle' => array( 'method' => 'normalize_browser_artifact_bundle', 'schema' => 'wp-codebox/browser-artifact-bundle/v1' ),
	'wp-codebox/persist-browser-artifact' => array( 'method' => 'persist_browser_artifact', 'schema' => 'wp-codebox/artifact-result/v1' ),
	'wp-codebox/import-artifact-bundle' => array( 'method' => 'import_artifact_bundle', 'schema' => 'wp-codebox/import-artifact-bundle/v1' ),
	'wp-codebox/reimport-artifact-bundle' => array( 'method' => 'reimport_artifact_bundle', 'schema' => 'wp-codebox/reimport-artifact-bundle/v1' ),
	'wp-codebox/list-artifacts' => array( 'method' => 'list_artifacts', 'schema' => 'wp-codebox/artifact-list/v1' ),
	'wp-codebox/get-artifact' => array( 'method' => 'get_artifact', 'schema' => 'wp-codebox/artifact/v1' ),
	'wp-codebox/inspect-artifact' => array( 'method' => 'inspect_artifact', 'schema' => 'wp-codebox/artifact-inspection/v1' ),
	'wp-codebox/apply-artifact-preflight' => array( 'method' => 'apply_artifact_preflight', 'schema' => 'wp-codebox/artifact-apply-preflight/v1' ),
	'wp-codebox/stage-artifact-apply' => array( 'method' => 'stage_artifact_apply', 'schema' => 'wp-codebox/pending-apply/v1' ),
	'wp-codebox/apply-approved-artifact' => array( 'method' => 'apply_approved_artifact', 'schema' => 'wp-codebox/artifact-apply/v1' ),
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
