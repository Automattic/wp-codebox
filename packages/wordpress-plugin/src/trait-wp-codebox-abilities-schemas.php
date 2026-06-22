<?php
/**
 * WP_Codebox_Abilities_Schemas implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Schemas {
private static function mount_schema(): array {
	return array(
		'type'        => 'array',
		'description' => 'Additional host directories to mount into the sandbox. Callers may attach repo metadata for downstream tools that need to map sandbox paths back to source repositories.',
		'items'       => array(
			'type'       => 'object',
			'required'   => array( 'source', 'target' ),
			'properties' => array(
				'source'   => array(
					'type'        => 'string',
					'description' => 'Host directory path to mount.',
				),
				'target'   => array(
					'type'        => 'string',
					'description' => 'Absolute sandbox path, such as /wordpress/wp-content/plugins/example.',
				),
				'mode'     => array(
					'type' => 'string',
					'enum' => array( 'readonly', 'readwrite' ),
				),
				'metadata' => array(
					'type'        => 'object',
					'description' => 'Opaque caller metadata, for example repo, default_branch, repo_root_relative_to_mount, and editable flags.',
				),
			),
		),
	);
}

/** @return array<string,mixed> */
private static function site_seed_schema(): array {
	$scope_schema = array(
		'type'       => 'object',
		'properties' => array(
			'ids'          => array( 'type' => 'array', 'items' => array( 'type' => 'integer' ) ),
			'slugs'        => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
			'names'        => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
			'postTypes'    => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
			'taxonomies'   => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
			'roles'        => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
			'statuses'     => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
			'includeFiles' => array( 'type' => 'boolean' ),
			'anonymize'    => array( 'type' => 'boolean' ),
			'maxRecords'   => array( 'type' => 'integer', 'minimum' => 1, 'maximum' => 100 ),
		),
	);

	return array(
		'type'        => 'array',
		'description' => 'Explicit opt-in bounded parent-site seed exports for existing-site sandboxes. Exported data is written to a temporary JSON fixture and imported into the sandbox before the task runs.',
		'items'       => array(
			'type'       => 'object',
			'required'   => array( 'type', 'name', 'scopes' ),
			'properties' => array(
				'type'   => array( 'type' => 'string', 'enum' => array( 'parent_site' ) ),
				'name'   => array( 'type' => 'string' ),
				'scopes' => array(
					'type'       => 'object',
					'properties' => array(
						'posts'         => $scope_schema,
						'terms'         => $scope_schema,
						'options'       => $scope_schema,
						'users'         => $scope_schema,
						'media'         => $scope_schema,
						'activePlugins' => array( 'type' => 'boolean' ),
						'activeTheme'   => array( 'type' => 'boolean' ),
					),
				),
			),
		),
	);
}

/** @return array<string,mixed> */
private static function agent_bundle_schema(): array {
	return array(
		'type'        => 'array',
		'description' => 'Runtime agent bundles to import into the disposable sandbox before invoking the selected runtime agent. Installed runtime plugins provide importer implementations.',
		'items'       => array(
			'type'       => 'object',
			'anyOf'      => array(
				array( 'required' => array( 'source' ) ),
				array( 'required' => array( 'bundle' ) ),
			),
			'properties' => array(
				'source'      => array(
					'type'        => 'string',
					'description' => 'Bundle source accepted by the runtime importer, such as a local directory, .zip, .json, or remote URL.',
				),
				'bundle'      => array(
					'type'        => 'object',
					'description' => 'Inline runtime agent bundle JSON staged in the sandbox and passed to the registered importer.',
				),
				'slug'        => array( 'type' => 'string' ),
				'on_conflict' => array( 'type' => 'string', 'enum' => array( 'error', 'skip', 'upgrade' ) ),
				'owner_id'    => array( 'type' => 'integer' ),
				'token_env'   => array( 'type' => 'string' ),
				'import_principal' => array(
					'type'        => 'object',
					'description' => 'Optional non-secret importer principal context. Runtime importers define the shape they accept.',
				),
			),
		),
	);
}

/** @return array<string,mixed> */
private static function inherit_schema(): array {
	$credential_secret_schema = array(
		'type'       => 'object',
		'required'   => array( 'name', 'status' ),
		'properties' => array(
			'name'   => array(
				'type'        => 'string',
				'description' => 'Sandbox environment variable name. Secret values are never transported.',
			),
			'status' => array(
				'type' => 'string',
				'enum' => array( 'available', 'missing', 'denied' ),
			),
			'scope'  => array(
				'type'        => 'string',
				'description' => 'Parent-side connector scope that authorized this secret name.',
			),
			'source' => array(
				'type'        => 'string',
				'description' => 'Redacted source label, such as parent-env or connector.',
			),
			'reason' => array(
				'type'        => 'string',
				'description' => 'Redacted missing/denied reason for audit surfaces.',
			),
		),
	);

	return array(
		'type'        => 'object',
		'description' => 'Declarative request for parent-environment connector or setting inheritance. Parent filters resolve names into a sanitized sandbox payload with explicit connector-scoped credential envelopes; secret values are never accepted here.',
		'properties'  => array(
			'connectors' => array(
				'type'        => 'array',
				'description' => 'Connector names the parent environment should resolve for this sandbox run.',
				'items'       => array( 'type' => 'string' ),
			),
			'settings'   => array(
				'type'        => 'array',
				'description' => 'Setting names the parent environment should resolve for artifact/audit metadata. Values are not transported in this slice.',
				'items'       => array( 'type' => 'string' ),
			),
			'credentials' => array(
				'type'        => 'object',
				'description' => 'Observable credential envelope shape returned under inheritance.connectors[].credentials by parent filters. Values are not accepted.',
				'properties'  => array(
					'schema'    => array( 'type' => 'string' ),
					'connector' => array( 'type' => 'string' ),
					'scope'     => array( 'type' => 'string', 'enum' => array( 'connector' ) ),
					'status'    => array( 'type' => 'string', 'enum' => array( 'available', 'missing', 'denied' ) ),
					'reason'    => array( 'type' => 'string' ),
					'secrets'   => array( 'type' => 'array', 'items' => $credential_secret_schema ),
				),
			),
		),
	);
}

/** @return array<string,array<string,mixed>> */
private static function preview_input_schema(): array {
	return WP_Codebox_Preview_Options::input_schema();
}

/** @return array<string,mixed> */
private static function sandbox_session_input_schema(): array {
	return array(
		'sandbox_session_id' => array(
			'type'        => 'string',
			'description' => 'Caller-owned sandbox session id for external job/session systems. WP Codebox returns it in the response but does not persist sessions itself.',
		),
		'orchestrator'       => array(
			'type'        => 'object',
			'description' => 'Optional caller-owned job/session metadata, such as external job system, job id, or control-plane id. Values are copied into the response session envelope for correlation only.',
			'properties'  => array(
				'id'     => array( 'type' => 'string' ),
				'type'   => array( 'type' => 'string' ),
				'job_id' => array( 'type' => 'string' ),
			),
		),
	);
}

/** @return array<string,mixed> */
private static function remediation_outcome_schema(): array {
	return array(
		'type'        => 'object',
		'description' => 'Strict audit-remediation terminal outcome. Sandbox runs return reviewed artifacts when they can remediate, or an explicit terminal no-op/failure outcome when they cannot. Parent orchestrators apply artifacts and open PRs outside the sandbox.',
		'properties'  => array(
			'schema'                => array( 'type' => 'string' ),
			'success'               => array( 'type' => 'boolean' ),
			'kind'                  => array(
				'type' => 'string',
				'enum' => array( 'fix_artifact', 'false_positive_artifact', 'noop_artifact', 'unable_to_remediate', 'fix_pr', 'false_positive_pr', 'provider_error', 'agent_no_pr_outcome', 'max_turns_exceeded', 'runtime_tool_pending' ),
			),
			'failure'               => array(
				'type' => 'string',
				'enum' => array( 'provider_error', 'agent_no_pr_outcome', 'max_turns_exceeded', 'runtime_tool_pending', '' ),
			),
			'pr_url'                => array( 'type' => 'string' ),
			'false_positive_pr_url' => array( 'type' => 'string' ),
			'exit_code'             => array( 'type' => 'integer' ),
			'retryable'             => array( 'type' => 'boolean' ),
			'provider_error'        => array( 'type' => 'object' ),
			'artifact'              => array( 'type' => 'object' ),
			'metadata'              => array( 'type' => 'object' ),
			'diagnostics'           => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function completion_outcome_schema(): array {
	return array(
		'type'        => 'object',
		'description' => 'Generic sandbox completion outcome emitted as files/completion-outcome.json and returned for orchestration without parsing prose.',
		'properties'  => array(
			'schema'       => array( 'type' => 'string' ),
			'status'       => array(
				'type' => 'string',
				'enum' => array( 'succeeded', 'blocked', 'failed', 'partial' ),
			),
			'summary'      => array( 'type' => 'string' ),
			'changedFiles' => array( 'type' => 'object' ),
			'patch'        => array( 'type' => 'object' ),
			'artifacts'    => array( 'type' => 'object' ),
			'verification' => array( 'type' => 'object' ),
			'blockers'     => array( 'type' => 'array' ),
			'riskNotes'    => array( 'type' => 'array' ),
			'confidence'   => array( 'type' => 'string' ),
			'nextAction'   => array( 'type' => 'string' ),
			'provenance'   => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function sandbox_session_schema(): array {
	return array(
		'type'       => 'object',
		'properties' => array(
			'schema'           => array(
				'type'        => 'string',
				'description' => 'Session envelope contract version. Use wp-codebox/sandbox-session/v1.',
			),
			'id'               => array(
				'type'        => 'string',
				'description' => 'Caller-owned sandbox session id echoed for external orchestration correlation.',
			),
			'status'           => array(
				'type'        => 'string',
				'enum'        => array( 'ready', 'completed' ),
				'description' => 'Synchronous WP Codebox preparation/run status. Durable queued/running/cancelled/expired state belongs to the external orchestrator.',
			),
			'persistence'      => array(
				'type'        => 'string',
				'enum'        => array( 'external-orchestrator' ),
				'description' => 'WP Codebox does not persist host-site session lifecycle state; callers own durable records.',
			),
			'agent_session_id' => array( 'type' => 'string' ),
			'orchestrator'     => array( 'type' => 'object' ),
			'authorization'    => array( 'type' => 'object' ),
			'artifacts'        => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_playground_session_schema(): array {
	return array(
		'type'       => 'object',
		'properties' => array(
			'success'    => array( 'type' => 'boolean' ),
			'schema'     => array( 'type' => 'string' ),
			'execution'  => array(
				'type'        => 'string',
				'enum'        => array( 'browser-playground' ),
				'description' => 'The caller browser executes WordPress Playground; the host site does not run the WP Codebox CLI.',
			),
			'execution_scope'  => array(
				'type'        => 'string',
				'enum'        => array( 'disposable-playground' ),
				'description' => 'Browser sessions run inside a disposable WordPress Playground sandbox, not the host site.',
			),
			'permission_model' => array(
				'type'        => 'string',
				'enum'        => array( 'runtime-principal' ),
				'description' => 'The generated browser runner authorizes Agents API calls through a scoped runtime principal inside the disposable Playground sandbox.',
			),
			'session'    => array( 'type' => 'object' ),
			'preview_boot' => array( 'type' => 'object' ),
			'preview_ref'  => array( 'type' => 'object' ),
			'artifact_refs' => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
			'contained_site' => self::browser_contained_site_schema(),
			'signals'    => array( 'type' => 'object' ),
			'artifacts'  => array( 'type' => 'object' ),
			'product'    => self::browser_product_dto_schema(),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_materializer_contract_schema(): array {
	return self::browser_product_dto_schema();
}

/** @return array<string,mixed> */
private static function browser_internal_materializer_contract_schema(): array {
	return array(
		'type'       => 'object',
		'properties' => array(
			'success'          => array( 'type' => 'boolean' ),
			'schema'           => array( 'type' => 'string' ),
			'execution'        => array(
				'type' => 'string',
				'enum' => array( 'browser-playground' ),
			),
			'execution_scope'  => array(
				'type' => 'string',
				'enum' => array( 'disposable-playground' ),
			),
			'permission_model' => array(
				'type' => 'string',
				'enum' => array( 'runtime-principal' ),
			),
			'session_id'       => array( 'type' => 'string' ),
			'contained_site'   => self::browser_contained_site_schema(),
			'authorization'    => array( 'type' => 'object' ),
			'task_input'       => self::task_input_schema(),
			'task_payload'     => array( 'type' => 'object' ),
			'materialization'  => array( 'type' => 'object' ),
			'recipe'           => array( 'type' => 'object' ),
			'playground'       => array( 'type' => 'object' ),
			'runtime'          => array( 'type' => 'object' ),
			'artifacts'        => array( 'type' => 'object' ),
			'compact'          => self::browser_product_dto_schema(),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_task_contract_schema(): array {
	return self::browser_product_dto_schema();
}

/** @return array<string,mixed> */
private static function browser_internal_task_contract_schema(): array {
	return array(
		'type'       => 'object',
		'properties' => array(
			'success'          => array( 'type' => 'boolean' ),
			'schema'           => array( 'type' => 'string' ),
			'execution'        => array(
				'type' => 'string',
				'enum' => array( 'browser-playground' ),
			),
			'execution_scope'  => array(
				'type' => 'string',
				'enum' => array( 'disposable-playground' ),
			),
			'permission_model' => array(
				'type' => 'string',
				'enum' => array( 'runtime-principal' ),
			),
			'session'          => array( 'type' => 'object' ),
			'contained_site'   => self::browser_contained_site_schema(),
			'primary'          => self::browser_playground_session_schema(),
			'phases'           => array(
				'type'        => 'array',
				'description' => 'Named browser task phases. Materializer phases include a browser-materializer-contract envelope; fanout and host-delegation phases preserve explicit request envelopes during contract preparation and include results only when host-side phase execution is requested.',
				'items'       => array(
					'type'       => 'object',
					'properties' => array(
						'name'     => array( 'type' => 'string' ),
						'kind'     => array( 'type' => 'string', 'enum' => self::browser_task_phase_kinds() ),
						'index'    => array( 'type' => 'integer' ),
						'label'    => array( 'type' => 'string' ),
						'status'   => array( 'type' => 'string' ),
						'metadata' => array( 'type' => 'object' ),
						'request'  => array( 'type' => 'object' ),
						'contract' => array( 'type' => 'object' ),
						'result'   => array( 'type' => 'object' ),
					),
				),
			),
			'execution_metrics' => array( 'type' => 'object' ),
			'provenance'       => array( 'type' => 'object' ),
			'compact'          => self::browser_product_dto_schema(),
		),
	);
}

/** @return array<int,string> */
private static function browser_task_phase_kinds(): array {
	return array( 'materializer', 'agent', 'validator', 'repair', 'aggregator', 'host-delegation' );
}

/** @return array<string,mixed> */
private static function browser_product_dto_schema(): array {
	return array(
		'type'        => 'object',
		'description' => 'Compact product-facing browser task/session DTO for durable product records and REST responses. It exposes stable ids, preview refs, artifact refs, status, and compact diagnostics while omitting raw playground, runtime, recipe, task payload, sandbox path, and implementation diagnostic contracts.',
		'properties'  => array(
			'success'          => array( 'type' => 'boolean' ),
			'schema'           => array( 'type' => 'string' ),
			'dto_schema'       => array( 'type' => 'string' ),
			'source_schema'    => array( 'type' => 'string' ),
			'execution'        => array( 'type' => 'string' ),
			'execution_scope'  => array( 'type' => 'string' ),
			'permission_model' => array( 'type' => 'string' ),
			'status'           => array( 'type' => 'string' ),
			'session_id'       => array( 'type' => 'string' ),
			'session'          => array( 'type' => 'object' ),
			'contained_site'   => self::browser_contained_site_schema(),
			'primary'          => array( 'type' => 'object' ),
			'phases'           => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
			'task'             => array( 'type' => 'string' ),
			'target'           => array( 'type' => 'object' ),
			'agent'            => array( 'type' => 'string' ),
			'provider'         => array( 'type' => 'string' ),
			'model'            => array( 'type' => 'string' ),
			'preview_boot'     => array( 'type' => 'object' ),
			'preview_ref'      => array( 'type' => 'object' ),
			'artifact_refs'    => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
			'signals'          => array( 'type' => 'object' ),
			'error'            => array( 'type' => 'object' ),
			'diagnostics'      => array( 'type' => 'object' ),
			'execution_metrics' => array( 'type' => 'object' ),
			'provenance'       => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_schema(): array {
	return array(
		'type'        => 'object',
		'description' => 'Durable browser-contained WordPress site handle. The caller stores this envelope and can call the status ability to recover a prepared runtime blueprint when the transient still exists.',
		'properties'  => array(
			'schema'        => array( 'type' => 'string', 'const' => 'wp-codebox/browser-contained-site/v1' ),
			'site_id'       => array( 'type' => 'string' ),
			'preview_id'    => array( 'type' => 'string' ),
			'session_id'    => array( 'type' => 'string' ),
			'caller_id'     => array( 'type' => 'string' ),
			'status'        => array( 'type' => 'string', 'enum' => array( 'ready', 'blocked', 'recoverable_prepared_runtime', 'current', 'live', 'materialized', 'miss', 'disabled', 'incompatible', 'unusable' ) ),
			'open_mode'     => array( 'type' => 'string', 'enum' => array( 'reuse_current', 'reuse_live', 'reuse_materialized', 'reuse_prepared_runtime', 'materialize', 'unavailable' ) ),
			'reuse_level'   => array( 'type' => 'string', 'enum' => array( 'current', 'live', 'materialized', 'prepared_runtime', 'none' ) ),
			'requires_materialization' => array( 'type' => 'boolean' ),
			'prepared_runtime_recoverable' => array( 'type' => 'boolean' ),
			'live'          => array( 'type' => 'boolean' ),
			'current'       => array( 'type' => 'boolean' ),
			'materialized'  => array( 'type' => 'boolean' ),
			'resolution'    => array( 'type' => 'object' ),
			'persistence'   => array( 'type' => 'string', 'enum' => array( 'browser-contained' ) ),
			'artifact_seed' => array( 'type' => 'string' ),
			'artifact_revision' => array( 'type' => 'string' ),
			'recovery'      => array( 'type' => 'object' ),
			'recovery_handle' => array( 'type' => 'string' ),
			'source_digest' => array( 'type' => 'object' ),
			'artifact_digest' => array( 'type' => 'object' ),
			'materialization_digest' => array( 'type' => 'object' ),
			'preview'       => array( 'type' => 'object' ),
			'prepared_runtime' => array( 'type' => 'object' ),
			'blueprint_ref' => array( 'type' => 'object' ),
			'preview_boot'  => array( 'type' => 'object' ),
			'preview_lease' => array( 'type' => 'object' ),
			'session'       => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_session_authorization_schema(): array {
	return self::trusted_orchestrator_authorization_schema( self::BROWSER_SESSION_CREATE_SCOPE, 'Explicit trusted orchestrator authorization for browser session creation. Callers must provide a caller id and the browser-session:create scope; sites grant trust through wp_codebox_trusted_browser_session_callers.' );
}

/** @return array<string,mixed> */
private static function browser_connector_authorization_schema(): array {
	return self::trusted_orchestrator_authorization_schema( self::BROWSER_CONNECTOR_REQUEST_SCOPE, 'Explicit trusted orchestrator authorization for browser connector/provider requests. Callers must provide a caller id and the browser-connector:request scope; sites grant trust through wp_codebox_trusted_browser_session_callers.' );
}

/** @return array<string,mixed> */
private static function trusted_orchestrator_authorization_schema( string $scope, string $description ): array {
	return array(
		'type'        => 'object',
		'description' => $description,
		'properties'  => array(
			'schema' => array(
				'type'        => 'string',
				'description' => 'Authorization contract version. Use wp-codebox/trusted-orchestrator-authorization/v1.',
			),
			'caller' => array(
				'type'        => 'string',
				'description' => 'Stable caller id, for example browser-client.',
			),
			'scope'  => array(
				'type'        => 'string',
				'enum'        => array( $scope ),
				'description' => 'Required trusted-orchestrator capability scope.',
			),
		),
	);
}

/** @return array<string,mixed> */
private static function task_input_schema(): array {
	return WP_Codebox_Task_Input_Contract::schema();
}

/** @return array<string,mixed> */
private static function agent_workload_schema(): array {
	return WP_Codebox_Agent_Workload::schema();
}

/** @return array<string,mixed> */
private static function string_property_schema( string $description = '' ): array {
	$schema = array( 'type' => 'string' );
	if ( '' !== $description ) {
		$schema['description'] = $description;
	}

	return $schema;
}

/** @return array<string,mixed> */
private static function object_property_schema( string $description = '' ): array {
	$schema = array( 'type' => 'object' );
	if ( '' !== $description ) {
		$schema['description'] = $description;
	}

	return $schema;
}

/** @return array<string,mixed> */
private static function string_array_property_schema( string $description = '' ): array {
	$schema = array(
		'type'  => 'array',
		'items' => array( 'type' => 'string' ),
	);
	if ( '' !== $description ) {
		$schema['description'] = $description;
	}

	return $schema;
}

/** @return array<string,mixed> */
private static function object_array_property_schema( string $description = '' ): array {
	$schema = array(
		'type'  => 'array',
		'items' => array( 'type' => 'object' ),
	);
	if ( '' !== $description ) {
		$schema['description'] = $description;
	}

	return $schema;
}

/** @return array<string,mixed> */
private static function approved_files_schema( string $description ): array {
	return self::string_array_property_schema( $description );
}

/** @return array<string,mixed> */
private static function artifact_apply_input_properties( string $approved_files_description, string $approver_description, string $apply_target_description ): array {
	return array(
		'approved_files' => self::approved_files_schema( $approved_files_description ),
		'approver'       => self::string_property_schema( $approver_description ),
		'apply_target'   => self::object_property_schema( $apply_target_description ),
	);
}

/** @return array<string,mixed> */
private static function runtime_task_request_schema(): array {
	return array(
		'type'       => 'object',
		'required'   => array( 'task' ),
		'properties' => array(
			'schema'             => array( 'type' => 'string', 'const' => 'wp-codebox/runtime-task-request/v1' ),
			'task'               => array( 'type' => array( 'string', 'object' ) ),
			'input'              => array( 'type' => 'object' ),
			'task_input'         => self::task_input_schema(),
			'executor'           => array( 'type' => array( 'string', 'object' ) ),
			'target'             => array( 'type' => array( 'string', 'object' ) ),
			'target_id'          => array( 'type' => 'string' ),
			'executor_id'        => array( 'type' => 'string' ),
			'mode'               => self::string_property_schema(),
			'agent'              => self::string_property_schema(),
			'provider'           => self::string_property_schema(),
			'model'              => self::string_property_schema(),
			'sandbox_session_id' => self::string_property_schema(),
			'orchestrator'       => self::object_property_schema(),
			'metadata'           => self::object_property_schema(),
			'options'            => self::object_property_schema(),
		),
	);
}

/** @return array<string,mixed> */
private static function runtime_task_result_schema(): array {
	return array(
		'type'       => 'object',
		'properties' => array(
			'success'       => array( 'type' => 'boolean' ),
			'schema'        => array( 'type' => 'string', 'const' => 'wp-codebox/runtime-task-result/v1' ),
			'status'        => array( 'type' => 'string' ),
			'execution'     => array( 'type' => 'string' ),
			'task'          => array( 'type' => array( 'string', 'object' ) ),
			'result'        => array( 'type' => 'object' ),
			'error'         => array( 'type' => 'object' ),
			'events'        => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
			'artifacts'     => array( 'type' => array( 'object', 'array', 'string' ) ),
			'run'           => array( 'type' => 'object' ),
			'metadata'      => array( 'type' => 'object' ),
			'upstream_refs' => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function wordpress_workload_run_request_schema(): array {
	return array(
		'type'       => 'object',
		'required'   => array( 'schema', 'steps' ),
		'properties' => array(
			'schema'               => array( 'type' => 'string', 'const' => 'wp-codebox/wordpress-workload-run/v1' ),
			'wordpress_version'    => self::string_property_schema( 'WordPress version requested for the disposable Playground workload.' ),
			'blueprint'            => self::object_property_schema( 'Optional WordPress Playground blueprint object.' ),
			'preview'              => self::object_property_schema( 'Optional preview settings for the workload.' ),
			'mounts'               => self::mount_schema(),
			'runtime_stack_mounts' => self::object_array_property_schema( 'Runtime stack mounts for the disposable workload.' ),
			'runtime_overlays'     => self::object_array_property_schema( 'Runtime overlays for the disposable workload.' ),
			'runtime_env'          => self::object_property_schema( 'Non-secret runtime environment values. Secret values must use secret_env names.' ),
			'secret_env'           => self::string_array_property_schema( 'Parent environment variable names expected by the workload. Values are never accepted in this payload.' ),
			'staged_files'         => self::object_array_property_schema( 'Explicit staged file descriptors accepted by the recipe runtime.' ),
			'artifacts'            => self::object_array_property_schema( 'Artifact refs declared by the safe recipe runtime.' ),
			'before'               => self::wordpress_workload_steps_schema(),
			'steps'                => self::wordpress_workload_steps_schema(),
			'after'                => self::wordpress_workload_steps_schema(),
			'metadata'             => self::object_property_schema(),
		),
	);
}

/** @return array<string,mixed> */
private static function wordpress_workload_steps_schema(): array {
	return array(
		'type'  => 'array',
		'items' => array(
			'type'       => 'object',
			'required'   => array( 'command' ),
			'properties' => array(
				'command'      => array( 'type' => 'string' ),
				'args'         => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
				'allowFailure' => array( 'type' => 'boolean' ),
				'advisory'     => array( 'type' => 'boolean' ),
			),
		),
	);
}

/** @return array<string,mixed> */
private static function wordpress_workload_run_result_schema(): array {
	return array(
		'type'       => 'object',
		'properties' => array(
			'success'     => array( 'type' => 'boolean' ),
			'schema'      => array( 'type' => 'string', 'const' => 'wp-codebox/wordpress-workload-run-result/v1' ),
			'status'      => array( 'type' => 'string', 'enum' => array( 'completed', 'failed', 'skipped', 'unsupported' ) ),
			'request'     => self::object_property_schema(),
			'steps'       => self::object_array_property_schema(),
			'artifacts'   => self::object_array_property_schema(),
			'diagnostics' => self::object_array_property_schema(),
			'metadata'    => self::object_property_schema(),
		),
	);
}

/** @return array<string,mixed> */
private static function fuzz_suite_request_schema(): array {
	return array(
		'type'       => 'object',
		'required'   => array( 'schema', 'id', 'cases' ),
		'properties' => array(
			'schema'   => array( 'type' => 'string', 'const' => 'wp-codebox/fuzz-suite/v1' ),
			'id'       => array( 'type' => 'string' ),
			'version'  => array( 'type' => 'string' ),
			'target'   => self::fuzz_suite_target_schema(),
			'cases'    => array(
				'type'  => 'array',
				'items' => array(
					'type'       => 'object',
					'required'   => array( 'id' ),
					'properties' => array(
						'id'          => array( 'type' => 'string' ),
						'target'      => self::fuzz_suite_target_schema(),
						'input'       => array(),
						'description' => array( 'type' => 'string' ),
						'metadata'    => self::object_property_schema(),
					),
				),
			),
			'metadata' => self::object_property_schema(),
		),
	);
}

/** @return array<string,mixed> */
private static function fuzz_suite_target_schema(): array {
	return array(
		'type'       => 'object',
		'properties' => array(
			'kind'       => array( 'type' => 'string', 'enum' => array( 'ability', 'command', 'http', 'rest', 'runtime', 'runtime-action' ) ),
			'id'         => array( 'type' => 'string' ),
			'entrypoint' => array( 'type' => 'string' ),
			'label'      => array( 'type' => 'string' ),
			'metadata'   => self::object_property_schema(),
		),
	);
}

/** @return array<string,mixed> */
private static function fuzz_suite_result_schema(): array {
	return array(
		'type'       => 'object',
		'properties' => array(
			'success'      => array( 'type' => 'boolean' ),
			'schema'       => array( 'type' => 'string', 'const' => 'wp-codebox/fuzz-suite-result/v1' ),
			'status'       => array( 'type' => 'string', 'enum' => array( 'passed', 'failed', 'error', 'skipped', 'unsupported' ) ),
			'suite'        => self::object_property_schema(),
			'summary'      => self::object_property_schema(),
			'cases'        => self::object_array_property_schema(),
			'diagnostics'  => self::object_array_property_schema(),
			'artifactRefs' => self::object_array_property_schema(),
			'metadata'     => self::object_property_schema(),
		),
	);
}

/**
 * Shared host-side sandbox runner input fields used by task, batch, and fanout abilities.
 *
 * @param array<string,mixed> $task_input_schema Task input schema.
 * @param array<string,mixed> $mount_schema Mount schema.
 * @param array<string,mixed> $site_seed_schema Site seed schema.
 * @param array<string,mixed> $inherit_schema Inheritance schema.
 * @param array<string,mixed> $session_input Session input schema.
 * @param array<string,mixed> $preview_schema Preview input schema.
 * @param array<string,mixed> $options Composition options.
 * @return array<string,mixed>
 */
private static function host_agent_task_input_properties( array $task_input_schema, array $mount_schema, array $site_seed_schema, array $inherit_schema, array $session_input, array $preview_schema, array $options = array() ): array {
	$detailed = ! empty( $options['detailed'] );

	$properties = array(
		'agent_workload'         => self::agent_workload_schema(),
		'workload'               => self::agent_workload_schema(),
		'agent'                  => self::string_property_schema( $detailed ? 'Codebox agent runtime id. Defaults through wp_codebox_default_agent.' : '' ),
		'mode'                   => self::string_property_schema( $detailed ? 'Agent execution mode. Defaults to sandbox.' : '' ),
		'provider'               => self::string_property_schema( $detailed ? 'AI provider id to seed into the sandbox agent config.' : '' ),
		'model'                  => self::string_property_schema( $detailed ? 'AI model id to seed into the sandbox agent config.' : '' ),
		'provider_plugin_paths'  => self::string_array_property_schema( $detailed ? 'AI provider plugin directories to mount and activate inside the sandbox.' : '' ),
		'agent_bundles'          => self::agent_bundle_schema(),
		'runtime_task'           => self::object_property_schema( $detailed ? 'Internal runtime adapter task request. Prefer agent_workload.agent_runtime.runtime_task for public callers.' : '' ),
		'parent_request'         => self::object_property_schema( $detailed ? 'Canonical wp-codebox/task-input/v1 parent request normalized into the WP Codebox runner contract.' : '' ),
		'component_contracts'    => self::component_contracts_schema( $detailed ? 'Caller-declared runtime components WP Codebox should package, mount, or probe.' : '' ),
		'mounts'                 => $mount_schema,
		'workspaces'             => self::object_array_property_schema( $detailed ? 'Recipe workspace entries to seed as policy-checked writable repositories.' : '' ),
		'runtime_stack_mounts'   => self::object_array_property_schema( $detailed ? 'Runtime stack mounts to pass through to recipe.runtime.stack.mounts.' : '' ),
		'runtime_state_mounts'   => self::object_array_property_schema( $detailed ? 'Generic provider/runtime config or state files/directories mounted before provider plugins and runtime code load.' : '' ),
		'runtime_config_mounts'  => self::object_array_property_schema( $detailed ? 'Generic provider/runtime config files/directories mounted before provider plugins and runtime code load.' : '' ),
		'runtime_env'            => self::object_property_schema( $detailed ? 'Non-secret runtime environment values exposed to sandbox PHP before WordPress and provider plugins load. Secret values must use secret_env.' : '' ),
		'runtime_overlays'       => self::object_array_property_schema( $detailed ? 'Runtime overlays to pass through to recipe.runtime.overlays.' : '' ),
		'inherit'                => $inherit_schema,
		'sandbox_session_id'     => $session_input['sandbox_session_id'],
		'orchestrator'           => $session_input['orchestrator'],
		'secret_env'             => self::string_array_property_schema( $detailed ? 'Explicit parent environment variable names to expose inside the sandbox. Prefer connector-scoped inheritance credentials for product flows. Values are read from the parent process and are not accepted in this payload.' : '' ),
		'max_turns'              => $detailed ? array(
			'type'        => 'integer',
			'description' => 'Maximum agent loop turns for this sandbox task.',
		) : array( 'type' => 'integer' ),
		'preview_hold_seconds'   => $preview_schema['preview_hold_seconds'],
		'preview_port'           => $preview_schema['preview_port'],
		'preview_bind'           => $preview_schema['preview_bind'],
		'preview_public_url'     => $preview_schema['preview_public_url'],
		'wp'                     => self::string_property_schema( $detailed ? 'WordPress version passed to Playground. Defaults to trunk.' : '' ),
		'artifacts_path'         => self::string_property_schema( $detailed ? 'Directory where WP Codebox should write artifact bundles.' : '' ),
		'wp_codebox_bin'         => self::string_property_schema( $detailed ? 'WP Codebox CLI binary or path. JS dist files are run through node.' : '' ),
	);

	if ( ! empty( $options['task_fields'] ) ) {
		$properties = self::task_input_alias_properties( $task_input_schema ) + $properties;
	}

	if ( ! empty( $options['site_seeds'] ) ) {
		$properties['site_seeds'] = $site_seed_schema;
	}

	if ( ! empty( $options['session_id'] ) ) {
		$properties['session_id'] = self::string_property_schema( 'Existing sandbox conversation session id.' );
	}

	if ( ! empty( $options['task_timeout_seconds'] ) ) {
		$properties['task_timeout_seconds'] = array(
			'type'        => 'integer',
			'description' => $detailed ? 'Maximum wall-clock seconds for this sandbox task. Zero or omitted disables the host-side timeout.' : '',
		);
		if ( '' === $properties['task_timeout_seconds']['description'] ) {
			unset( $properties['task_timeout_seconds']['description'] );
		}
	}

	return $properties;
}

/** @return array<string,mixed> */
private static function component_contracts_schema( string $description = '' ): array {
	$schema = array(
		'type'  => 'array',
		'items' => array(
			'type'       => 'object',
			'properties' => array(
				'slug'            => self::string_property_schema( 'Component plugin slug.' ),
				'path'            => self::string_property_schema( 'Host filesystem path to package for the sandbox.' ),
				'source'          => self::string_property_schema( 'Alias for path.' ),
				'activate'        => array( 'type' => 'boolean' ),
				'loadAs'          => self::string_property_schema( 'Recipe loading mode, such as mu-plugin.' ),
				'required'        => array( 'type' => 'boolean' ),
				'readiness_probe' => array(
					'type'       => 'object',
					'properties' => array(
						'type' => array( 'type' => 'string', 'enum' => array( 'ability', 'filter' ) ),
						'name' => array( 'type' => 'string' ),
					),
				),
				'provenance'      => array( 'type' => 'object' ),
			),
		),
	);
	if ( '' !== $description ) {
		$schema['description'] = $description;
	}

	return $schema;
}

/**
 * Shared browser Playground task/session input fields.
 *
 * @param array<string,mixed> $task_input_schema Task input schema.
 * @param array<string,mixed> $inherit_schema Inheritance schema.
 * @param array<string,mixed> $session_input Session input schema.
 * @param bool                $detailed Whether to include field descriptions for the public session creator.
 * @return array<string,mixed>
 */
private static function browser_task_input_properties( array $task_input_schema, array $inherit_schema, array $session_input, bool $detailed = false ): array {
	return self::task_input_alias_properties( $task_input_schema ) + array(
		'agent_workload'          => self::agent_workload_schema(),
		'workload'                => self::agent_workload_schema(),
		'agent'                   => self::string_property_schema( $detailed ? 'Codebox agent runtime id for the browser sandbox.' : '' ),
		'provider'                => self::string_property_schema( $detailed ? 'AI provider id to seed into the browser Playground agent invocation.' : '' ),
		'model'                   => self::string_property_schema( $detailed ? 'AI model id to seed into the browser Playground agent invocation.' : '' ),
		'mode'                    => self::string_property_schema( $detailed ? 'Agent execution mode. Defaults to sandbox.' : '' ),
		'provider_plugin_paths'   => self::string_array_property_schema( $detailed ? 'AI provider plugin directories the browser sandbox should have available before code execution.' : '' ),
		'runtime_recipe'          => $detailed ? self::runtime_recipe_input_schema() : self::object_property_schema(),
		'runtime_packages'        => self::string_array_property_schema( $detailed ? 'Portable runtime package ids WP Codebox should resolve through the runtime package registry.' : '' ),
		'runtime_capabilities'    => self::string_array_property_schema( $detailed ? 'Portable runtime capabilities WP Codebox should satisfy through registered runtime packages.' : '' ),
		'agent_bundles'           => self::agent_bundle_schema(),
		'inherit'                 => $inherit_schema,
		'secret_env'              => self::string_array_property_schema( $detailed ? 'Parent environment variable names expected to be available to the browser sandbox. Values are never accepted in this payload.' : '' ),
		'sandbox_session_id'      => $session_input['sandbox_session_id'],
		'orchestrator'            => $session_input['orchestrator'],
		'authorization'           => self::browser_session_authorization_schema(),
		'playground'              => $detailed ? self::browser_playground_input_schema() : self::object_property_schema(),
		'browser_runner'          => $detailed ? self::browser_runner_input_schema() : self::object_property_schema(),
		'browser_plugins'         => $detailed ? self::browser_plugins_input_schema() : array( 'type' => 'array' ),
		'runtime_profile'        => self::object_property_schema( $detailed ? 'Portable wp-codebox/runtime-profile/v1 descriptor normalized into browser runtime fields before session creation.' : '' ),
		'runtime'                 => $detailed ? self::browser_runtime_input_schema() : self::object_property_schema(),
		'blueprint'               => self::object_property_schema( $detailed ? 'Optional WordPress Playground blueprint for the browser to compile and run.' : '' ),
		'site_blueprint_artifact' => $detailed ? self::site_blueprint_artifact_input_schema() : self::object_property_schema(),
		'artifact_files'          => $detailed ? self::artifact_files_input_schema() : array( 'type' => 'array' ),
		'include_raw_browser_session' => array(
			'type'        => 'boolean',
			'description' => 'Internal/debug escape hatch for materializers that need the raw browser Playground contract. Public callers should use the default product DTO.',
			'default'     => false,
		),
		'debug'                   => array(
			'type'        => 'object',
			'description' => 'Optional debug flags. Set debug.include_raw_browser_session only for internal materializer/debug tooling that needs the raw Playground contract.',
		),
	);
}

/** @return array<string,mixed> */
private static function task_input_alias_properties( array $task_input_schema ): array {
	$properties = array();
	foreach ( WP_Codebox_Task_Input_Contract::ABILITY_ALIAS_FIELDS as $field ) {
		$properties[ $field ] = $task_input_schema['properties'][ $field ];
	}

	return $properties;
}

/** @return array<string,mixed> */
private static function browser_playground_input_schema(): array {
	return array(
		'type'        => 'object',
		'description' => 'Optional browser Playground client and artifact preview configuration overrides.',
		'properties'  => array(
			'client_module_url' => array( 'type' => 'string' ),
			'remote_url'        => array( 'type' => 'string' ),
			'cors_proxy_url'    => array( 'type' => 'string' ),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_runner_input_schema(): array {
	return array(
		'type'        => 'object',
		'description' => 'Optional PHP-WASM runner paths and generic sandbox-local invocation settings for executing the task inside the browser Playground site.',
		'properties'  => array(
			'task_path'     => array( 'type' => 'string' ),
			'result_path'   => array( 'type' => 'string' ),
			'capture_paths' => array(
				'type'        => 'array',
				'description' => 'Sandbox-local files or reports the generated browser runner should include in its normalized result after invocation.',
				'items'       => array(
					'type'       => 'object',
					'required'   => array( 'path' ),
					'properties' => array(
						'path'      => array( 'type' => 'string' ),
						'name'      => array( 'type' => 'string' ),
						'kind'      => array( 'type' => 'string' ),
						'mime_type' => array( 'type' => 'string' ),
						'max_bytes' => array( 'type' => 'integer' ),
					),
				),
			),
			'invocation'    => array(
				'type'        => 'object',
				'description' => 'Generic sandbox-local invocation. Callers can inject MU plugins that register the named ability or hook task; WP Codebox only invokes it and captures normal artifacts.',
				'properties'  => array(
					'type'  => array( 'type' => 'string', 'enum' => array( 'ability', 'task' ) ),
					'name'  => array( 'type' => 'string' ),
					'hook'  => array( 'type' => 'string' ),
					'input' => array( 'type' => 'object' ),
				),
			),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_plugins_input_schema(): array {
	return array(
		'type'        => 'array',
		'description' => 'Optional plugin zip URLs the browser Playground should install and activate before running the recipe.',
		'items'       => array(
			'type'       => 'object',
			'properties' => array(
				'slug'     => array( 'type' => 'string' ),
				'url'      => array( 'type' => 'string' ),
				'activate' => array( 'type' => 'boolean' ),
				'sha256'   => array( 'type' => 'string' ),
			),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_runtime_input_schema(): array {
	return array(
		'type'        => 'object',
		'description' => 'Structured browser Playground runtime dependencies compiled by WP Codebox into the session blueprint.',
		'properties'  => array(
			'components' => array( 'type' => 'array' ),
			'packages'   => array( 'type' => 'array' ),
			'capabilities' => array( 'type' => 'array' ),
			'recipe'     => self::runtime_recipe_input_schema(),
			'plugins'    => array( 'type' => 'array' ),
			'mu_plugins' => array( 'type' => 'array' ),
			'themes'     => array( 'type' => 'array' ),
			'bootstrap'  => array( 'type' => 'array' ),
			'prepared'   => array(
				'type'        => 'object',
				'description' => 'Optional prepared browser runtime cache contract. When enabled, WP Codebox keys the compiled browser-ready blueprint by a source digest and reuses matching cached artifacts on repeated known-site opens.',
				'properties'  => array(
					'enabled'    => array( 'type' => 'boolean' ),
					'cache'      => array( 'type' => 'boolean' ),
					'cache_key'  => array( 'type' => 'string' ),
					'input_hash' => array( 'type' => 'string' ),
					'blueprint'  => array( 'type' => 'object' ),
				),
			),
			'prepared_runtime' => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function runtime_recipe_input_schema(): array {
	return array(
		'type'        => 'object',
		'description' => 'Portable runtime recipe request. Callers name package ids or capabilities; WP Codebox resolves registered dependencies, package rows, inheritance, and placement details.',
		'properties'  => array(
			'packages'     => array( 'type' => 'array' ),
			'capabilities' => array( 'type' => 'array' ),
		),
	);
}

/** @return array<string,mixed> */
private static function site_blueprint_artifact_input_schema(): array {
	return array(
		'type'        => 'object',
		'description' => 'Caller-owned pulled-site Playground blueprint artifact to compile into the browser sandbox before Codebox runs.',
		'properties'  => array(
			'schema'     => array( 'type' => 'string' ),
			'id'         => array( 'type' => 'string' ),
			'blueprint'  => array( 'type' => 'object' ),
			'provenance' => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function artifact_files_input_schema(): array {
	return array(
		'type'        => 'array',
		'description' => 'Optional text or base64 artifact files the browser should write into Playground.',
		'items'       => array(
			'type'       => 'object',
			'required'   => array( 'path' ),
			'properties' => array(
				'path'           => array( 'type' => 'string' ),
				'content'        => array( 'type' => 'string' ),
				'content_base64' => array( 'type' => 'string' ),
				'encoding'       => array( 'type' => 'string' ),
				'mime_type'      => array( 'type' => 'string' ),
				'kind'           => array( 'type' => 'string' ),
				'description'    => array( 'type' => 'string' ),
			),
		),
	);
}
}
