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

	private const RUNTIME_DESCRIPTOR_SCHEMA                 = 'wp-codebox/runtime-descriptor/v1';
	private const RUNTIME_CONTRACT_MANIFEST_SCHEMA          = 'wp-codebox/runtime-contract-manifest/v1';
	private const WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA    = 'wp-codebox/wordpress-fuzz-runtime-contract/v1';

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
		'wp-codebox/wordpress-fuzz-runtime-contract'        => 'wordpress_fuzz_runtime_contract',
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
			'wordpressFuzzRuntimeContract' => self::wordpress_fuzz_runtime_contract(),
			'contractManifest' => self::runtime_contract_manifest(),
		);
	}

	/** @param array<string,mixed> $input Ignored descriptor input. @return array<string,mixed> */
	public static function wordpress_fuzz_runtime_contract( array $input = array() ): array {
		unset( $input );

		return array(
			'schema'                      => self::WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA,
			'version'                     => 1,
			'runtime'                     => array(
				'id'          => 'wp-codebox',
				'environment' => 'wordpress',
			),
			'publicSurfaces'              => array(
				'phpFacade'  => 'WP_Codebox_API::wordpress_fuzz_runtime_contract()',
				'ability'    => 'wp-codebox/run-fuzz-suite',
				'wpCli'      => 'wp codebox wordpress-fuzz-runtime-contract',
				'nodeCli'    => 'wp-codebox fuzz descriptor --format=json',
				'typescript' => '@automattic/wp-codebox-core/contracts',
			),
			'actionFamilies'              => array(
				array(
					'id'                 => 'ability-http-rest-read',
					'label'              => 'Ability, HTTP, and REST read coverage',
					'targetKinds'        => array( 'ability', 'http', 'rest' ),
					'runtimeActionTypes' => array(),
					'commands'           => array( 'wordpress.ability', 'wordpress.http-request', 'wordpress.rest-request' ),
					'mutationIntents'    => array( 'read' ),
					'supported'          => true,
				),
				array(
					'id'                 => 'runtime-browser-admin',
					'label'              => 'Runtime browser, admin page, editor, and page coverage',
					'targetKinds'        => array( 'runtime', 'runtime-action' ),
					'runtimeActionTypes' => array( 'admin_page', 'browser', 'browser_probe', 'editor_open', 'page', 'random_walk', 'sequence' ),
					'commands'           => array( 'wordpress.browser-actions', 'wordpress.browser-page-load', 'wordpress.browser-probe', 'wordpress.editor-open', 'wordpress.fuzz-admin-pages', 'wordpress.page', 'wordpress.simulated-admin-page-load', 'wordpress.simulated-frontend-page-load' ),
					'mutationIntents'    => array( 'read', 'write' ),
					'supported'          => true,
				),
				array(
					'id'                 => 'runtime-wordpress-operations',
					'label'              => 'WordPress CLI, PHP, REST, CRUD, and database operation coverage',
					'targetKinds'        => array( 'command', 'runtime', 'runtime-action' ),
					'runtimeActionTypes' => array( 'crud_operation', 'db_operation', 'php', 'rest_request', 'wp_cli' ),
					'commands'           => array( 'wordpress.collect-workload-result', 'wordpress.crud-operation', 'wordpress.db-operation', 'wordpress.inventory-plugin-module-options-tables', 'wordpress.rest-performance-observation', 'wordpress.rest-request', 'wordpress.run-php', 'wordpress.run-workload', 'wordpress.wp-cli' ),
					'mutationIntents'    => array( 'read', 'write', 'delete', 'destructive' ),
					'supported'          => true,
				),
			),
			'resetModes'                  => array(
				array( 'id' => 'none', 'supported' => true, 'requiredForMutationIntents' => array( 'read' ), 'artifactKinds' => array() ),
				array( 'id' => 'checkpoint-per-case', 'supported' => true, 'requiredForMutationIntents' => array( 'write', 'delete', 'destructive' ), 'artifactKinds' => array( 'mutation-isolation-artifact', 'delete-boundary-artifact' ) ),
				array( 'id' => 'restore-snapshot', 'supported' => false, 'requiredForMutationIntents' => array(), 'artifactKinds' => array() ),
			),
			'artifactExpectations'        => array(
				array( 'id' => 'fuzz-suite-result', 'required' => true, 'schema' => 'wp-codebox/fuzz-suite-result/v1', 'producedBy' => array( 'run-fuzz-suite' ), 'description' => 'Every fuzz run returns a structured suite result envelope with case summaries, diagnostics, and artifact references.' ),
				array( 'id' => 'mutation-isolation-artifact', 'required' => true, 'schema' => 'wp-codebox/mutation-isolation-artifact/v1', 'producedBy' => array( 'rest-mutation:post', 'rest-mutation:put', 'rest-mutation:patch' ), 'description' => 'Mutating REST coverage records the fixture opt-in and reset boundary used to isolate the mutation.' ),
				array( 'id' => 'delete-boundary-artifact', 'required' => true, 'schema' => 'wp-codebox/delete-boundary-artifact/v1', 'producedBy' => array( 'rest-mutation:delete' ), 'description' => 'Delete coverage records the explicit delete boundary artifact instead of advertising raw delete support.' ),
			),
			'destructiveModeRequirements' => array(
				'supported'                 => true,
				'destructiveMutationIntent' => 'destructive',
				'requiredResetModes'        => array( 'checkpoint-per-case' ),
				'requiredArtifacts'         => array( 'mutation-isolation-artifact', 'delete-boundary-artifact' ),
				'deleteBoundaryCapability'  => 'delete-boundary-artifact',
				'rawDeleteCapability'       => null,
			),
			'unsupportedCapabilities'     => array(
				array( 'id' => 'raw-delete', 'reason' => 'WordPress fuzz runtime delete coverage is only supported through explicit delete-boundary artifacts.', 'replacement' => 'delete-boundary-artifact' ),
				array( 'id' => 'restore-snapshot-reset', 'reason' => 'Snapshot restore is not part of the public WordPress fuzz runtime contract.', 'replacement' => 'checkpoint-per-case' ),
				array( 'id' => 'private-runtime-probing', 'reason' => 'Consumers must read this descriptor instead of probing private runtime commands or implementation capabilities.' ),
			),
			'hbex'                        => array(
				'schemaIds' => array(
					'descriptor'                 => self::WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA,
					'fuzzSuite'                  => 'wp-codebox/fuzz-suite/v1',
					'fuzzSuiteResult'            => 'wp-codebox/fuzz-suite-result/v1',
					'fuzzRunnerCapabilities'     => 'wp-codebox/fuzz-runner-capabilities/v1',
					'fuzzRunnerReadiness'        => 'wp-codebox/fuzz-runner-readiness/v1',
					'fuzzCoveragePlan'           => 'wp-codebox/fuzz-coverage-plan/v1',
					'fuzzFixturePlan'            => 'wp-codebox/fuzz-fixture-plan/v1',
					'restMutationFixtureOptIn'   => 'wp-codebox/rest-mutation-fixture-opt-in/v1',
					'mutationIsolationArtifact'  => 'wp-codebox/mutation-isolation-artifact/v1',
					'deleteBoundaryArtifact'     => 'wp-codebox/delete-boundary-artifact/v1',
					'wordpressWorkloadRun'       => 'wp-codebox/wordpress-workload-run/v1',
				),
			),
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
				'fuzzRunnerCapabilities' => 'wp-codebox/fuzz-runner-capabilities/v1',
				'fuzzRunnerReadiness' => 'wp-codebox/fuzz-runner-readiness/v1',
				'wordpressFuzzRuntimeContract' => self::WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA,
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

	/** @return array<string,string> Public Codebox ability id to facade method map. */
	public static function public_abilities(): array {
		return self::ABILITY_METHODS;
	}

	/** @return array<string,array<string,string>> Public schema ids grouped by Codebox primitive. */
	public static function public_contract_schemas(): array {
		$schemas = self::runtime_contract_schemas();

		return array(
			'runtimeSession' => array(
				'access'                     => $schemas['runtimeBoundary']['runtimeAccess'],
				'previewLease'               => $schemas['runtimeBoundary']['previewLease'],
				'previewReviewerAccess'      => $schemas['preview']['reviewerAccess'],
				'browserSessionProductDto'   => $schemas['runtimeBoundary']['browserSessionProductDto'],
				'browserPreviewBootConfig'   => $schemas['runtimeBoundary']['browserPreviewBootConfig'],
				'browserContainedSiteStatus' => $schemas['runtimeBoundary']['browserContainedSiteStatus'],
				'browserContainedSiteOpen'   => $schemas['runtimeBoundary']['browserContainedSiteOpen'],
			),
			'runtimeProfile' => array(
				'profile' => $schemas['runtimeBoundary']['profile'],
			),
			'task'           => array(
				'input'           => 'wp-codebox/task-input/v1',
				'runRequest'      => $schemas['agentTask']['runRequest'],
				'runResult'       => $schemas['agentTask']['runResult'],
				'headlessRequest' => $schemas['agentTask']['headlessRequest'],
				'headlessResult'  => $schemas['agentTask']['headlessResult'],
			),
			'agent'          => array(
				'workload'  => $schemas['taskState']['agentRuntimeWorkload'],
				'runResult' => $schemas['taskState']['agentTaskRunResult'],
			),
			'artifact'       => array(
				'resultEnvelope'                => $schemas['artifact']['resultEnvelope'],
				'typedArtifact'                 => $schemas['artifact']['typedArtifact'],
				'typedArtifactIndex'            => $schemas['artifact']['typedArtifactIndex'],
				'bundleFileManifest'            => $schemas['artifact']['bundleFileManifest'],
				'browserArtifactPersistenceRef' => $schemas['artifact']['browserArtifactPersistenceRef'],
			),
			'credential'     => array(
				'requirements' => $schemas['runtimeProvider']['credentialRequirements'],
				'preflight'    => $schemas['runtimeProvider']['credentialPreflight'],
				'resolution'   => $schemas['runtimeProvider']['credentialResolution'],
			),
		);
	}

	/** @return array<string,mixed> Public primitive map for PHP SDK consumers. */
	public static function public_contract_primitives(): array {
		$schemas   = self::public_contract_schemas();
		$abilities = self::runtime_abilities();

		return array(
			'runtimeSession' => array( 'schemas' => $schemas['runtimeSession'] ),
			'runtimeProfile' => array( 'schemas' => $schemas['runtimeProfile'] ),
			'task'           => array(
				'abilities' => $abilities['agentTask'],
				'schemas'   => $schemas['task'],
			),
			'agent'          => array(
				'abilities' => array(
					'runTask'       => $abilities['agentTask']['run'],
					'runTaskBatch'  => $abilities['agentTask']['batch'],
					'runTaskFanout' => $abilities['agentTask']['fanout'],
				),
				'schemas'   => $schemas['agent'],
			),
			'artifact'       => array( 'schemas' => $schemas['artifact'] ),
			'credential'     => array( 'schemas' => $schemas['credential'], 'redacted' => true ),
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
