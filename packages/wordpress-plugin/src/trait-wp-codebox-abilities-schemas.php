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
				'enum' => array( 'fix_artifact', 'false_positive_artifact', 'noop_artifact', 'unable_to_remediate', 'fix_pr', 'false_positive_pr', 'provider_error', 'agent_no_pr_outcome', 'max_turns_exceeded' ),
			),
			'failure'               => array(
				'type' => 'string',
				'enum' => array( 'provider_error', 'agent_no_pr_outcome', 'max_turns_exceeded', '' ),
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
				'enum'        => array( 'sandbox-bypass' ),
				'description' => 'The generated browser runner bypasses agents/chat permission checks only inside the disposable Playground sandbox.',
			),
			'session'    => array( 'type' => 'object' ),
			'task_input' => self::task_input_schema(),
			'task_payload' => array( 'type' => 'object' ),
			'playground' => array( 'type' => 'object' ),
			'runtime'    => array( 'type' => 'object' ),
			'site_blueprint_artifact' => array( 'type' => 'object' ),
			'materialization' => array(
				'type'        => 'object',
				'description' => 'Generic browser materialization invocation contract and result capture shape produced by the generated Playground runner.',
			),
			'recipe'     => array( 'type' => 'object' ),
			'signals'    => array( 'type' => 'object' ),
			'artifacts'  => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_materializer_contract_schema(): array {
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
				'enum' => array( 'sandbox-bypass' ),
			),
			'session_id'       => array( 'type' => 'string' ),
			'authorization'    => array( 'type' => 'object' ),
			'task_input'       => self::task_input_schema(),
			'task_payload'     => array( 'type' => 'object' ),
			'materialization'  => array( 'type' => 'object' ),
			'recipe'           => array( 'type' => 'object' ),
			'playground'       => array( 'type' => 'object' ),
			'runtime'          => array( 'type' => 'object' ),
			'artifacts'        => array( 'type' => 'object' ),
		),
	);
}

/** @return array<string,mixed> */
private static function browser_session_authorization_schema(): array {
	return self::trusted_orchestrator_authorization_schema( self::BROWSER_SESSION_CREATE_SCOPE, 'Explicit trusted orchestrator authorization for browser session creation. Callers must provide a caller id and the browser-session:create scope; sites grant trust through wp_codebox_trusted_browser_session_callers.' );
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
				'description' => 'Stable caller id, for example studio-web.',
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
}
