<?php
/**
 * Public PHP facade for WP Codebox consumers.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Stable PHP facade over WP Codebox consumer operations.
 */
final class WP_Codebox_API {

	private const RUNTIME_DESCRIPTOR_SCHEMA        = 'wp-codebox/runtime-descriptor/v1';
	private const RUNTIME_CONTRACT_MANIFEST_SCHEMA = 'wp-codebox/runtime-contract-manifest/v1';

	/** @var string[] */
	private const PUBLIC_RUNTIME_CAPABILITIES = array(
		'agent-task:run',
		'agent-task:batch',
		'agent-task:fanout',
		'runtime-package:run',
		'runtime-requirements:resolve',
		'wordpress-runtime:workload',
		'wordpress-runtime:fuzz-suite',
		'contract-manifest:read',
	);

	public const ABILITY_LIST_ARTIFACTS = 'wp-codebox/list-artifacts';
	public const ABILITY_GET_ARTIFACT = 'wp-codebox/get-artifact';
	public const ABILITY_INSPECT_ARTIFACT = 'wp-codebox/inspect-artifact';
	public const ABILITY_APPLY_ARTIFACT_PREFLIGHT = 'wp-codebox/apply-artifact-preflight';
	public const ABILITY_STAGE_ARTIFACT_APPLY = 'wp-codebox/stage-artifact-apply';
	public const ABILITY_APPLY_APPROVED_ARTIFACT = 'wp-codebox/apply-approved-artifact';

	public const ARTIFACT_SCHEMA = 'wp-codebox/artifact/v1';
	public const ARTIFACT_INSPECTION_SCHEMA = 'wp-codebox/artifact-inspection/v1';
	public const ARTIFACT_APPLY_PREFLIGHT_SCHEMA = 'wp-codebox/artifact-apply-preflight/v1';
	public const ARTIFACT_APPLY_SCHEMA = 'wp-codebox/artifact-apply/v1';
	public const ARTIFACT_APPLY_RESULT_SCHEMA = 'wp-codebox/apply-result/v1';

	/** @var array<string,string> */
	private const ABILITY_METHODS = array(
		'wp-codebox/runtime-descriptor'                     => 'runtime_descriptor',
		'wp-codebox/run-agent-task'                         => 'run_agent_task',
		'wp-codebox/run-agent-task-batch'                   => 'run_agent_task_batch',
		'wp-codebox/run-agent-task-fanout'                  => 'run_agent_task_fanout',
		'wp-codebox/run-runtime-task'                       => 'run_runtime_task',
		'wp-codebox/run-wordpress-workload'                 => 'run_wordpress_workload',
		'wp-codebox/run-runtime-package'                    => 'run_runtime_package',
		'wp-codebox/resolve-runtime-requirements'           => 'resolve_runtime_requirements',
		'wp-codebox/run-fuzz-suite'                         => 'run_fuzz_suite',
		'wp-codebox/create-browser-playground-session'      => 'create_browser_session',
		'wp-codebox/create-browser-task-contract'           => 'create_browser_task_contract',
		'wp-codebox/create-browser-materializer-contract'   => 'create_browser_materializer_contract',
		'wp-codebox/create-browser-contained-site-session'  => 'create_browser_contained_site_session',
		'wp-codebox/get-browser-contained-site-status'      => 'browser_contained_site_status',
		'wp-codebox/preview-reuse-decision'                 => 'preview_reuse_decision',
		'wp-codebox/open-browser-contained-site'            => 'open_browser_session',
		'wp-codebox/open-or-create-browser-contained-site'  => 'open_or_create_browser_contained_site',
		'wp-codebox/snapshot-browser-contained-site'        => 'snapshot_browser_contained_site',
		'wp-codebox/export-browser-contained-site'          => 'export_browser_contained_site',
		'wp-codebox/plan-browser-contained-site-apply'      => 'plan_browser_contained_site_apply',
		'wp-codebox/apply-browser-contained-site-plan'      => 'apply_browser_contained_site_plan',
		'wp-codebox/browser-contained-site-sync-delegation' => 'browser_contained_site_sync_delegation',
		'wp-codebox/browser-contained-site-sync-source-connect' => 'browser_contained_site_sync_source_connect',
		'wp-codebox/browser-contained-site-sync-manifest'   => 'browser_contained_site_sync_manifest',
		'wp-codebox/browser-contained-site-sync-export'     => 'browser_contained_site_sync_export',
		'wp-codebox/browser-contained-site-sync-apply-plan-generate' => 'browser_contained_site_sync_apply_plan_generate',
		'wp-codebox/browser-contained-site-sync-apply-plan-validate' => 'browser_contained_site_sync_apply_plan_validate',
		'wp-codebox/browser-contained-site-sync-apply'      => 'browser_contained_site_sync_apply',
		'wp-codebox/request-host-delegation'                => 'request_host_delegation',
		self::ABILITY_LIST_ARTIFACTS                        => 'list_artifacts',
		self::ABILITY_GET_ARTIFACT                          => 'get_artifact',
		self::ABILITY_INSPECT_ARTIFACT                      => 'inspect_artifact',
		'wp-codebox/normalize-browser-artifact-bundle'      => 'normalize_artifact_bundle',
		'wp-codebox/persist-browser-artifact'               => 'persist_artifact',
		'wp-codebox/import-artifact-bundle'                 => 'import_artifact',
		'wp-codebox/reimport-artifact-bundle'               => 'reimport_artifact',
		self::ABILITY_APPLY_ARTIFACT_PREFLIGHT              => 'preflight_artifact_apply',
		self::ABILITY_STAGE_ARTIFACT_APPLY                  => 'stage_artifact_apply',
		self::ABILITY_APPLY_APPROVED_ARTIFACT               => 'apply_approved_artifact',
		'wp-codebox/runner-workspace-prepare'               => 'prepare_runner_workspace',
		'wp-codebox/prepare-runner-workspace'               => 'prepare_runner_workspace',
		'wp-codebox/prepare'                                => 'prepare_runner_workspace',
		'wp-codebox/runner-workspace-capture'               => 'capture_runner_workspace',
		'wp-codebox/capture-runner-workspace'               => 'capture_runner_workspace',
		'wp-codebox/capture'                                => 'capture_runner_workspace',
		'wp-codebox/runner-workspace-command'               => 'run_runner_workspace_command',
		'wp-codebox/run-runner-workspace-command'           => 'run_runner_workspace_command',
		'wp-codebox/command'                                => 'run_runner_workspace_command',
		'wp-codebox/runner-workspace-publish'               => 'publish_runner_workspace',
		'wp-codebox/publish-runner-workspace'               => 'publish_runner_workspace',
		'wp-codebox/publish'                                => 'publish_runner_workspace',
	);

	/** @param array<string,mixed> $input Ignored descriptor input. @return array<string,mixed> */
	public static function runtime_descriptor( array $input = array() ): array {
		unset( $input );

		return array(
			'schema'           => self::RUNTIME_DESCRIPTOR_SCHEMA,
			'version'          => 1,
			'runtime'          => array(
				'id'   => 'wp-codebox',
				'name' => 'WP Codebox',
			),
			'readiness'        => array(
				'status'            => 'available',
				'publicApi'         => true,
				'contractManifest'  => true,
			),
			'capabilities'     => self::PUBLIC_RUNTIME_CAPABILITIES,
			'abilities'        => self::runtime_abilities(),
			'contractManifest' => self::runtime_contract_manifest(),
		);
	}

	/** @return array<string,mixed> */
	public static function runtime_contract_manifest(): array {
		return array(
			'schema'          => self::RUNTIME_CONTRACT_MANIFEST_SCHEMA,
			'version'         => 1,
			'schemas'         => self::runtime_contract_schemas(),
			'abilities'       => self::runtime_abilities(),
			'providerRuntime' => self::provider_runtime_contract(),
		);
	}

	/** @return array<string,mixed> */
	private static function runtime_contract_schemas(): array {
		return array(
			'agentTask'                => array(
				'runRequest'        => 'wp-codebox/agent-task-run-request/v1',
				'runResult'         => 'wp-codebox/agent-task-run-result/v1',
				'headlessRequest'   => 'wp-codebox/headless-agent-task-request/v1',
				'headlessResult'    => 'wp-codebox/headless-agent-task-result/v1',
				'legacyRunResponse' => 'wp-codebox/agent-task-run-result/v1',
			),
			'runtimeBoundary'          => array(
				'profile'                    => 'wp-codebox/runtime-profile/v1',
				'previewLease'               => 'wp-codebox/preview-lease/v1',
				'browserContainedSiteStatus' => 'wp-codebox/browser-contained-site-status/v1',
				'browserContainedSiteOpen'   => 'wp-codebox/browser-contained-site-open/v1',
				'browserSessionProductDto'   => 'wp-codebox/browser-session-product-dto/v1',
				'browserPreviewBootConfig'   => 'wp-codebox/browser-preview-boot-config/v1',
				'runtimeAccess'              => 'wp-codebox/runtime-access/v1',
			),
			'browserSession'            => array(
				'productDto'               => 'wp-codebox/browser-session-product-dto/v1',
				'containedSiteStatus'      => 'wp-codebox/browser-contained-site-status/v1',
				'containedSiteOpen'        => 'wp-codebox/browser-contained-site-open/v1',
				'previewBootConfig'        => 'wp-codebox/browser-preview-boot-config/v1',
				'containedSiteSnapshot'    => 'wp-codebox/browser-contained-site-snapshot/v1',
				'containedSiteExport'      => 'wp-codebox/browser-contained-site-export/v1',
				'containedSiteApplyPlan'   => 'wp-codebox/browser-contained-site-apply-plan/v1',
				'containedSiteApplyResult' => 'wp-codebox/browser-contained-site-apply-result/v1',
			),
			'preview'                   => array(
				'lease'          => 'wp-codebox/preview-lease/v1',
				'reviewerAccess' => 'wp-codebox/preview-reviewer-access/v1',
				'runtimeAccess'  => 'wp-codebox/runtime-access/v1',
			),
			'artifact'                  => array(
				'resultEnvelope'                => 'wp-codebox/artifact-result-envelope/v1',
				'typedArtifact'                 => 'wp-codebox/structured-artifact/v1',
				'typedArtifactIndex'            => 'wp-codebox/typed-artifacts-index/v1',
				'runtimePackageDeclaration'     => 'wp-codebox/runtime-package-artifact-declaration/v1',
				'runtimePackageProjection'      => 'wp-codebox/runtime-package-output-projection/v1',
				'bundleFileManifest'            => 'wp-codebox/artifact-bundle-file-manifest/v1',
				'browserArtifactPersistenceRef' => 'wp-codebox/browser-artifact-persistence/ref/v1',
			),
			'artifactBundle'            => array(
				'resultEnvelope'        => 'wp-codebox/artifact-result-envelope/v1',
				'fileManifest'          => 'wp-codebox/artifact-bundle-file-manifest/v1',
				'browserPersistenceRef' => 'wp-codebox/browser-artifact-persistence/ref/v1',
			),
			'taskState'                 => array(
				'agentTaskRunResult'  => 'wp-codebox/agent-task-run-result/v1',
				'runtimeRunResult'    => 'wp-codebox/runtime-run-result/v1',
				'agentRuntimeWorkload' => 'wp-codebox/agent-runtime-workload/v1',
			),
			'runtimeProvider'           => array(
				'invocationContract'     => 'wp-codebox/provider-runtime-invocation-contract/v1',
				'credentialRequirements' => 'wp-codebox/provider-credential-requirements/v1',
				'credentialPreflight'    => 'wp-codebox/provider-credential-preflight/v1',
				'credentialResolution'   => 'wp-codebox/provider-credential-resolution/v1',
			),
			'providerRuntime'           => array(
				'invocation'             => 'wp-codebox/provider-runtime-invocation-contract/v1',
				'invocationContract'     => 'wp-codebox/provider-runtime-invocation-contract/v1',
				'credentialRequirements' => 'wp-codebox/provider-credential-requirements/v1',
				'credentialPreflight'    => 'wp-codebox/provider-credential-preflight/v1',
				'credentialResolution'   => 'wp-codebox/provider-credential-resolution/v1',
			),
			'hostDelegation'            => array(
				'request' => 'wp-codebox/host-delegation-request/v1',
				'result'  => 'wp-codebox/host-delegation-result/v1',
				'event'   => 'wp-codebox/host-delegation-event/v1',
			),
			'runtimePackage'            => array(
				'task'            => 'wp-codebox/runtime-package-task/v1',
				'result'          => 'wp-codebox/runtime-package-result/v1',
				'diagnostic'      => 'wp-codebox/runtime-package-diagnostic/v1',
				'executionInput'  => 'wp-codebox/runtime-package-execution-input/v1',
				'executionResult' => 'wp-codebox/runtime-package-execution-result/v1',
			),
			'runnerWorkspace'           => array(
				'prepareRequest'     => 'wp-codebox/runner-workspace-prepare-request/v1',
				'prepareResult'      => 'wp-codebox/runner-workspace-prepare-result/v1',
				'captureRequest'     => 'wp-codebox/runner-workspace-capture-request/v1',
				'captureResult'      => 'wp-codebox/runner-workspace-capture-result/v1',
				'commandRequest'     => 'wp-codebox/runner-workspace-command-request/v1',
				'commandResult'      => 'wp-codebox/runner-workspace-command-result/v1',
				'publicationRequest' => 'wp-codebox/runner-workspace-publication-request/v1',
				'publicationResult'  => 'wp-codebox/runner-workspace-publication-result/v1',
			),
			'parentToolBridge'          => array(
				'bridge'  => 'wp-codebox/parent-tool-bridge/v1',
				'request' => 'wp-codebox/parent-tool-request/v1',
				'result'  => 'wp-codebox/parent-tool-result/v1',
			),
			'fanoutAggregation'         => array(
				'input'  => 'wp-codebox/agent-fanout-aggregation-input/v1',
				'output' => 'wp-codebox/agent-fanout-aggregation-output/v1',
			),
			'wordpressRuntimeDiscovery' => array(
				'result'               => 'wp-codebox/wordpress-runtime-discovery/v1',
				'restRouteInventory'   => 'wp-codebox/wordpress-rest-route-inventory/v1',
				'adminPageInventory'   => 'wp-codebox/wordpress-admin-page-inventory/v1',
				'databaseInventory'    => 'wp-codebox/wordpress-db-inventory/v1',
				'frontendUrlInventory' => 'wp-codebox/wordpress-frontend-url-inventory/v1',
				'restMatrix'           => 'wp-codebox/wordpress-rest-matrix/v1',
				'restMatrixResult'     => 'wp-codebox/wordpress-rest-matrix-result/v1',
			),
			'wordpressDb'               => array(
				'operation' => 'wp-codebox/wordpress-db-operation/v1',
				'result'    => 'wp-codebox/wordpress-db-result/v1',
			),
			'wordpressRuntime'          => array(
				'workloadRun'         => 'wp-codebox/wordpress-workload-run/v1',
				'fuzzCoveragePlan'    => 'wp-codebox/fuzz-coverage-plan/v1',
				'fuzzSuite'           => 'wp-codebox/fuzz-suite/v1',
				'fuzzSuiteResult'     => 'wp-codebox/fuzz-suite-result/v1',
				'blockExerciseResult' => 'wp-codebox/wordpress-block-exercise-result/v1',
			),
		);
	}

	/** @return array<string,mixed> */
	private static function provider_runtime_contract(): array {
		return array(
			'schema'         => 'wp-codebox/provider-runtime-invocation-contract/v1',
			'version'        => 1,
			'tasks'          => array(
				'workspacePrepare'         => 'wp-codebox.runner-workspace.prepare',
				'workspaceCapture'         => 'wp-codebox.runner-workspace.capture',
				'workspaceCommand'         => 'wp-codebox.runner-workspace.command',
				'workspacePublish'         => 'wp-codebox.runner-workspace.publish',
				'toolCallTranscriptRecord' => 'wp-codebox.tool-call-transcript.record',
				'artifactHandoff'          => 'wp-codebox.artifact-handoff',
			),
			'abilities'      => array(
				'workspacePrepare'         => 'wp-codebox/runner-workspace-prepare',
				'workspaceCapture'         => 'wp-codebox/runner-workspace-capture',
				'workspaceCommand'         => 'wp-codebox/runner-workspace-command',
				'workspacePublish'         => 'wp-codebox/runner-workspace-publish',
				'toolCallTranscriptRecord' => 'wp-codebox/record-tool-call-transcript',
				'artifactHandoff'          => 'wp-codebox/handoff-artifacts',
			),
			'result_schemas' => array(
				'workspace_prepare'          => 'wp-codebox/runner-workspace-prepare-result/v1',
				'workspace_capture'          => 'wp-codebox/runner-workspace-capture-result/v1',
				'workspace_command'          => 'wp-codebox/runner-workspace-command-result/v1',
				'workspace_publication'      => 'wp-codebox/runner-workspace-publication-result/v1',
				'tool_call_transcript'       => 'wp-codebox/tool-call-transcript/v1',
				'evidence_artifact_envelope' => 'wp-codebox/evidence-artifact-envelope/v1',
				'artifact_result_envelope'   => 'wp-codebox/artifact-result-envelope/v1',
			),
		);
	}

	/** @return array<string,mixed> */
	private static function runtime_abilities(): array {
		return array(
			'agentTask'           => array(
				'run'    => 'wp-codebox/run-agent-task',
				'batch'  => 'wp-codebox/run-agent-task-batch',
				'fanout' => 'wp-codebox/run-agent-task-fanout',
			),
			'runtimePackage'      => array(
				'run' => 'wp-codebox/run-runtime-package',
			),
			'runtimeRequirements' => array(
				'resolve' => 'wp-codebox/resolve-runtime-requirements',
			),
			'wordpressRuntime'    => array(
				'runWorkload'  => 'wp-codebox/run-wordpress-workload',
				'runFuzzSuite' => 'wp-codebox/run-fuzz-suite',
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function execute_ability( string $ability_name, array $input = array() ): array|WP_Error {
		$ability_name = trim( $ability_name );
		$method       = self::ABILITY_METHODS[ $ability_name ] ?? '';
		if ( '' === $method ) {
			return new WP_Error( 'wp_codebox_api_ability_not_supported', 'WP_Codebox_API only executes supported wp-codebox consumer operations.', array( 'status' => 400 ) );
		}

		return self::{$method}( $input );
	}

	/** @param array<string,mixed> $input Task input. @return array<string,mixed>|WP_Error */
	public static function run_agent_task( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::run_agent_task( $input );
	}

	/** @param array<string,mixed> $input Batch input. @return array<string,mixed>|WP_Error */
	public static function run_agent_task_batch( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::run_agent_task_batch( $input );
	}

	/** @param array<string,mixed> $input Fanout input. @return array<string,mixed>|WP_Error */
	public static function run_agent_task_fanout( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::run_agent_task_fanout( $input );
	}

	/** @param array<string,mixed> $input Runtime task input. @return array<string,mixed>|WP_Error */
	public static function run_runtime_task( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::run_runtime_task( $input );
	}

	/** @param array<string,mixed> $input WordPress workload input. @return array<string,mixed>|WP_Error */
	public static function run_wordpress_workload( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::run_wordpress_workload( $input );
	}

	/** @param array<string,mixed> $input Runtime package input. @return array<string,mixed>|WP_Error */
	public static function run_runtime_package( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::run_runtime_package( $input );
	}

	/** @param array<string,mixed> $input Runtime readiness input. @return array<string,mixed> */
	public static function resolve_runtime_requirements( array $input ): array {
		return WP_Codebox_Abilities::resolve_runtime_requirements( $input );
	}

	/** @param array<string,mixed> $input Fuzz suite input. @return array<string,mixed>|WP_Error */
	public static function run_fuzz_suite( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::run_fuzz_suite( $input );
	}

	/** @param array<string,mixed> $input Browser session input. @return array<string,mixed>|WP_Error */
	public static function create_browser_session( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::create_browser_playground_session( $input );
	}

	/** @param array<string,mixed> $input Browser task contract input. @return array<string,mixed>|WP_Error */
	public static function create_browser_task_contract( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::create_browser_task_contract( $input );
	}

	/** @param array<string,mixed> $input Browser materializer contract input. @return array<string,mixed>|WP_Error */
	public static function create_browser_materializer_contract( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::create_browser_materializer_contract( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site session input. @return array<string,mixed>|WP_Error */
	public static function create_browser_contained_site_session( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::create_browser_contained_site_session( $input );
	}

	/** @param array<string,mixed> $input Browser session lookup input. @return array<string,mixed>|WP_Error */
	public static function get_browser_session_status( array $input ): array|WP_Error {
		return self::browser_contained_site_status( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site status input. @return array<string,mixed>|WP_Error */
	public static function browser_contained_site_status( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::get_browser_contained_site_status( $input );
	}

	/** @param array<string,mixed> $input Browser session lookup input. @return array<string,mixed>|WP_Error */
	public static function preview_reuse_decision( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::preview_reuse_decision( $input );
	}

	/** @param array<string,mixed> $input Browser session input. @return array<string,mixed>|WP_Error */
	public static function open_browser_session( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::open_browser_contained_site( $input );
	}

	/** @param array<string,mixed> $input Browser session input. @return array<string,mixed>|WP_Error */
	public static function open_or_create_browser_session( array $input ): array|WP_Error {
		return self::open_or_create_browser_contained_site( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site input. @return array<string,mixed>|WP_Error */
	public static function open_or_create_browser_contained_site( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::open_or_create_browser_contained_site( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site input. @return array<string,mixed>|WP_Error */
	public static function snapshot_browser_contained_site( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::snapshot_browser_contained_site( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site input. @return array<string,mixed>|WP_Error */
	public static function export_browser_contained_site( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::export_browser_contained_site( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site input. @return array<string,mixed>|WP_Error */
	public static function plan_browser_contained_site_apply( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::plan_browser_contained_site_apply( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site input. @return array<string,mixed>|WP_Error */
	public static function apply_browser_contained_site_plan( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::apply_browser_contained_site_plan( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site sync input. @return array<string,mixed>|WP_Error */
	public static function browser_contained_site_sync_delegation( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::browser_contained_site_sync_delegation( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site sync input. @return array<string,mixed>|WP_Error */
	public static function browser_contained_site_sync_source_connect( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::browser_contained_site_sync_source_connect( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site sync input. @return array<string,mixed>|WP_Error */
	public static function browser_contained_site_sync_manifest( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::browser_contained_site_sync_manifest( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site sync input. @return array<string,mixed>|WP_Error */
	public static function browser_contained_site_sync_export( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::browser_contained_site_sync_export( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site sync input. @return array<string,mixed>|WP_Error */
	public static function browser_contained_site_sync_apply_plan_generate( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::browser_contained_site_sync_apply_plan_generate( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site sync input. @return array<string,mixed>|WP_Error */
	public static function browser_contained_site_sync_apply_plan_validate( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::browser_contained_site_sync_apply_plan_validate( $input );
	}

	/** @param array<string,mixed> $input Browser contained-site sync input. @return array<string,mixed>|WP_Error */
	public static function browser_contained_site_sync_apply( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::browser_contained_site_sync_apply( $input );
	}

	/** @param array<string,mixed> $input Host delegation input. @return array<string,mixed>|WP_Error */
	public static function request_host_delegation( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::request_host_delegation( $input );
	}

	/** @param array<string,mixed> $input Artifact list input. @return array<string,mixed>|WP_Error */
	public static function list_artifacts( array $input = array() ): array|WP_Error {
		return WP_Codebox_Abilities::list_artifacts( $input );
	}

	/** @param array<string,mixed> $input Artifact lookup input. @return array<string,mixed>|WP_Error */
	public static function get_artifact( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::get_artifact( $input );
	}

	/** @param array<string,mixed> $input Artifact inspection input. @return array<string,mixed>|WP_Error */
	public static function inspect_artifact( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::inspect_artifact( $input );
	}

	/** @param array<string,mixed> $input Artifact bundle normalization input. @return array<string,mixed>|WP_Error */
	public static function normalize_artifact_bundle( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::normalize_browser_artifact_bundle( $input );
	}

	/** @param array<string,mixed> $input Browser artifact persistence input. @return array<string,mixed>|WP_Error */
	public static function persist_artifact( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::persist_browser_artifact( $input );
	}

	/** @param array<string,mixed> $input Artifact bundle import input. @return array<string,mixed>|WP_Error */
	public static function import_artifact( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::import_artifact_bundle( $input );
	}

	/** @param array<string,mixed> $input Artifact bundle reimport input. @return array<string,mixed>|WP_Error */
	public static function reimport_artifact( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::reimport_artifact_bundle( $input );
	}

	/** @param array<string,mixed> $input Artifact apply input. @return array<string,mixed>|WP_Error */
	public static function preflight_artifact_apply( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::apply_artifact_preflight( $input );
	}

	/** @param array<string,mixed> $input Artifact apply input. @return array<string,mixed>|WP_Error */
	public static function stage_artifact_apply( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::stage_artifact_apply( $input );
	}

	/** @param array<string,mixed> $input Artifact apply input. @return array<string,mixed>|WP_Error */
	public static function apply_approved_artifact( array $input ): array|WP_Error {
		return WP_Codebox_Abilities::apply_approved_artifact( $input );
	}

	/** @param array<string,mixed> $input Runner workspace input. @return array<string,mixed> */
	public static function prepare_runner_workspace( array $input ): array {
		return WP_Codebox_Abilities::prepare_runner_workspace( $input );
	}

	/** @param array<string,mixed> $input Runner workspace input. @return array<string,mixed> */
	public static function capture_runner_workspace( array $input ): array {
		return WP_Codebox_Abilities::capture_runner_workspace( $input );
	}

	/** @param array<string,mixed> $input Runner workspace command input. @return array<string,mixed> */
	public static function run_runner_workspace_command( array $input ): array {
		return WP_Codebox_Abilities::run_runner_workspace_command( $input );
	}

	/** @param array<string,mixed> $input Runner workspace publication input. @return array<string,mixed> */
	public static function publish_runner_workspace( array $input ): array {
		return WP_Codebox_Abilities::publish_runner_workspace( $input );
	}
}
