<?php
/**
 * Browser ability descriptors.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Provides browser runtime and artifact ability descriptors.
 */
final class WP_Codebox_Browser_Ability_Descriptors {

	/**
	 * @param array<string,mixed> $context Shared schemas assembled by WP_Codebox_Abilities.
	 * @return array<string,array<string,mixed>> Ability descriptors keyed by ability id.
	 */
	public static function descriptors( array $context ): array {
		$artifact_id_schema          = $context['artifact_id_schema'];
		$browser_contract_properties = $context['browser_contract_properties'];
		$browser_session_properties  = $context['browser_session_properties'];
		$browser_session_schema      = $context['browser_session_schema'];
		$inherit_schema              = $context['inherit_schema'];
		$session_input               = $context['session_input'];

		return array(
			'wp-codebox/hydrate-browser-blueprint-ref'      => array(
				'label'               => 'Hydrate Browser Blueprint Ref',
				'description'         => 'Resolve a product-safe prepared browser blueprint ref into an executable WordPress Playground blueprint without requiring consumers to store blueprint files.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'properties' => array(
						'ref'        => array( 'type' => 'string' ),
						'cache_key'  => array( 'type' => 'string' ),
						'input_hash' => array( 'type' => 'string' ),
					),
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'success'       => array( 'type' => 'boolean' ),
						'schema'        => array( 'type' => 'string', 'const' => 'wp-codebox/browser-blueprint-hydration/v1' ),
						'blueprint_ref' => array( 'type' => 'object' ),
						'blueprint'     => array( 'type' => 'object' ),
						'provenance'    => array( 'type' => 'object' ),
					),
				),
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'hydrate_browser_blueprint_ref' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_create_browser_playground_session' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/create-browser-playground-session'    => array(
				'label'               => 'Create Browser Playground Session',
				'description'         => 'Prepare a WP Codebox browser-executed WordPress Playground session without requiring the host to run the WP Codebox CLI or Node.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'required'   => array( 'goal' ),
					'properties' => $browser_session_properties,
				),
				'output_schema'       => $browser_session_schema,
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'create_browser_playground_session' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_create_browser_playground_session' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/create-browser-materializer-contract' => array(
				'label'               => 'Create Browser Materializer Contract',
				'description'         => 'Prepare the browser-executed Playground recipe and materialization contract for an already-created parent browser session.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'required'   => array( 'goal' ),
					'properties' => $browser_contract_properties,
				),
				'output_schema'       => $context['browser_materializer_contract_schema'],
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'create_browser_materializer_contract' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_create_browser_playground_session' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/create-browser-task-contract'         => array(
				'label'               => 'Create Browser Task Contract',
				'description'         => 'Prepare a product-facing multi-phase browser Playground task contract with a primary session and optional materializer phases.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'required'   => array( 'goal' ),
					'properties' => $browser_contract_properties + array(
						'execute_phases' => array(
							'type'        => 'boolean',
							'description' => 'When true, explicitly execute host-side fanout and host-delegation phase requests after preparing the browser task contract. Defaults to false so contract creation remains side-effect-light.',
							'default'     => false,
						),
						'phases'         => array(
							'type'        => 'array',
							'description' => 'Optional named browser task phases. Generic phases may carry wp-codebox/agent-fanout-request/v1 or wp-codebox/host-delegation-request/v1 in request/input for explicit WP Codebox execution when execute_phases is true; materializer phases may override any primary session input through input.',
							'items'       => array(
								'type'       => 'object',
								'properties' => array(
									'name'     => array( 'type' => 'string' ),
									'kind'     => array( 'type' => 'string', 'enum' => $context['browser_task_phase_kinds'] ),
									'label'    => array( 'type' => 'string' ),
									'status'   => array( 'type' => 'string' ),
									'metadata' => array( 'type' => 'object' ),
									'request'  => array( 'type' => 'object' ),
									'input'    => array( 'type' => 'object' ),
								),
							),
						),
						'materializers'  => array(
							'type'        => 'array',
							'description' => 'Convenience list of materializer input overrides. Prefer phases for named multi-phase contracts.',
							'items'       => array( 'type' => 'object' ),
						),
					),
				),
				'output_schema'       => $context['browser_task_contract_schema'],
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'create_browser_task_contract' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_create_browser_playground_session' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/get-browser-contained-site-status'    => array(
				'label'               => 'Get Browser Contained Site Status',
				'description'         => 'Resolve a durable browser-contained site handle into recoverable prepared-runtime status without creating a new Playground session.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'properties' => array(
						'contained_site' => $context['browser_contained_site_schema'],
						'site_id'       => array( 'type' => 'string' ),
						'cache_key'     => array( 'type' => 'string' ),
						'source_digest' => array( 'type' => 'string' ),
						'input_hash'    => array( 'type' => 'string' ),
					),
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'success'       => array( 'type' => 'boolean' ),
						'schema'        => array( 'type' => 'string', 'const' => 'wp-codebox/browser-contained-site-status/v1' ),
						'site_id'       => array( 'type' => 'string' ),
						'source_digest' => array( 'type' => 'object' ),
						'status'        => array( 'type' => 'string' ),
						'resolution'    => array( 'type' => 'object' ),
						'prepared_runtime' => array( 'type' => 'object' ),
						'blueprint_ref' => array( 'type' => 'object' ),
					),
				),
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'get_browser_contained_site_status' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_create_browser_playground_session' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/open-browser-contained-site'          => array(
				'label'               => 'Open Browser Contained Site',
				'description'         => 'Resolve a browser-contained site handle into a product-safe open/reuse envelope with preview boot, lease, blueprint ref, and session identity when available.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'properties' => array(
						'contained_site' => $context['browser_contained_site_schema'],
						'site_id'       => array( 'type' => 'string' ),
						'cache_key'     => array( 'type' => 'string' ),
						'source_digest' => array( 'description' => '64-character source digest string, or an object with a value field.' ),
						'input_hash'    => array( 'type' => 'string' ),
						'runtime_profile' => array( 'type' => 'object' ),
						'recovery'      => array( 'type' => 'object' ),
						'playground'    => array( 'type' => 'object' ),
						'preview_lease' => array( 'type' => 'object' ),
						'session_id'    => array( 'type' => 'string' ),
					),
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'success'       => array( 'type' => 'boolean' ),
						'schema'        => array( 'type' => 'string', 'const' => 'wp-codebox/browser-contained-site-open/v1' ),
						'site_id'       => array( 'type' => 'string' ),
						'status'        => array( 'type' => 'string' ),
						'resolution'    => array( 'type' => 'object' ),
						'contained_site' => $context['browser_contained_site_schema'],
						'source_digest' => array( 'type' => 'object' ),
						'prepared_runtime' => array( 'type' => 'object' ),
						'blueprint_ref' => array( 'type' => 'object' ),
						'preview_boot'  => array( 'type' => 'object' ),
						'preview_lease' => array( 'type' => 'object' ),
						'session'       => array( 'type' => 'object' ),
						'recovery'      => array( 'type' => 'object' ),
					),
				),
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'open_browser_contained_site' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_create_browser_playground_session' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/browser-connector-request'            => array(
				'label'               => 'Run Browser Connector Request',
				'description'         => 'Resolve connector credentials server-side and dispatch a generic browser connector request without exposing raw secrets to the browser sandbox.',
				'category'            => 'wp-codebox',
				'input_schema'        => $context['browser_connector_request_schema'],
				'output_schema'       => $context['browser_connector_response_schema'],
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'browser_connector_request' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_request_browser_connector' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/execute-browser-provider-request'     => array(
				'label'               => 'Execute Browser Provider Request',
				'description'         => 'Dispatch a connector-scoped browser provider request through the generic parent-side provider adapter hook without exposing raw provider credentials to the browser Playground.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'required'   => array( 'operation', 'request', 'inherit' ),
					'properties' => array(
						'operation'          => array(
							'type'        => 'string',
							'description' => 'Generic provider operation id, for example chat.completions. WP Codebox treats this as opaque adapter input.',
						),
						'provider'           => array( 'type' => 'string' ),
						'model'              => array( 'type' => 'string' ),
						'connector'          => array(
							'type'        => 'string',
							'description' => 'Optional connector name to select from the resolved inheritance connector set. Defaults to the first resolved connector.',
						),
						'inherit'            => $inherit_schema,
						'request'            => array(
							'type'        => 'object',
							'description' => 'Generic provider request payload. Secret-like fields are redacted before adapter/audit envelopes are returned.',
						),
						'sandbox_session_id' => $session_input['sandbox_session_id'],
						'session_id'         => array( 'type' => 'string' ),
						'caller_session_id'  => array( 'type' => 'string' ),
						'job_id'             => array( 'type' => 'string' ),
						'orchestrator'       => $session_input['orchestrator'],
						'authorization'      => $context['browser_connector_authorization_schema'],
					),
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'success'   => array( 'type' => 'boolean' ),
						'schema'    => array( 'type' => 'string', 'const' => 'wp-codebox/browser-provider-adapter-response/v1' ),
						'operation' => array( 'type' => 'string' ),
						'provider'  => array( 'type' => 'string' ),
						'model'     => array( 'type' => 'string' ),
						'connector' => array( 'type' => 'object' ),
						'response'  => array( 'type' => 'object' ),
						'audit'     => array( 'type' => 'object' ),
					),
				),
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'execute_browser_provider_request' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_request_browser_connector' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/list-artifacts'                       => array(
				'label'               => 'List WP Codebox Artifacts',
				'description'         => 'List artifact bundles under the configured WP Codebox artifact root.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'properties' => array(
						'artifacts_path' => $artifact_id_schema['artifacts_path'],
					),
				),
				'output_schema'       => array( 'type' => 'object' ),
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'list_artifacts' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/get-artifact'                        => array(
				'label'               => 'Get WP Codebox Artifact',
				'description'         => 'Read one WP Codebox artifact bundle by id.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'required'   => array( 'artifact_id' ),
					'properties' => $artifact_id_schema,
				),
				'output_schema'       => array( 'type' => 'object' ),
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'get_artifact' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/discard-artifact'                    => array(
				'label'               => 'Discard WP Codebox Artifact',
				'description'         => 'Delete one WP Codebox artifact bundle from the configured artifact root.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'required'   => array( 'artifact_id' ),
					'properties' => $artifact_id_schema,
				),
				'output_schema'       => array( 'type' => 'object' ),
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'discard_artifact' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/normalize-browser-artifact-bundle'   => array(
				'label'               => 'Normalize Browser Artifact Bundle',
				'description'         => 'Normalize and verify a caller-owned browser artifact bundle without interpreting product-specific roles or metadata.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'required'   => array( 'schema_id', 'entrypoint', 'files' ),
					'properties' => array(
						'schema_id'  => array(
							'type'        => 'string',
							'description' => 'Caller-owned schema id for the product artifact contract being normalized.',
						),
						'root'       => array(
							'type'        => 'string',
							'description' => 'Optional safe relative artifact root applied to entrypoint and file paths.',
						),
						'entrypoint' => array(
							'type'        => 'string',
							'description' => 'Safe relative entrypoint path that must exist in the normalized files.',
						),
						'roles'      => array(
							'type'        => 'object',
							'description' => 'Opaque caller role metadata preserved without product-specific interpretation.',
						),
						'provenance' => array(
							'type'        => 'object',
							'description' => 'Opaque caller provenance preserved on the normalized bundle.',
						),
						'metadata'   => array(
							'type'        => 'object',
							'description' => 'Opaque caller metadata preserved on the normalized bundle.',
						),
						'files'      => array(
							'type'        => 'array',
							'description' => 'Browser-produced artifact files to normalize.',
							'items'       => array(
								'type'       => 'object',
								'required'   => array( 'path' ),
								'properties' => array(
									'path'           => array( 'type' => 'string' ),
									'content'        => array( 'type' => 'string' ),
									'content_base64' => array( 'type' => 'string' ),
									'encoding'       => array( 'type' => 'string', 'enum' => array( 'utf-8', 'base64' ) ),
									'mime_type'      => array( 'type' => 'string' ),
									'kind'           => array( 'type' => 'string' ),
									'roles'          => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
								),
							),
						),
					),
				),
				'output_schema'       => array( 'type' => 'object' ),
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'normalize_browser_artifact_bundle' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
			'wp-codebox/persist-browser-artifact'            => array(
				'label'               => 'Persist Browser Artifact',
				'description'         => 'Persist browser-produced files from a disposable Playground session as a canonical WP Codebox artifact bundle.',
				'category'            => 'wp-codebox',
				'input_schema'        => array(
					'type'       => 'object',
					'required'   => array( 'files' ),
					'properties' => array(
						'artifacts_path'   => $artifact_id_schema['artifacts_path'],
						'authorization'    => $context['trusted_artifact_authorization_schema'],
						'session_id'       => array(
							'type'        => 'string',
							'description' => 'Optional browser Playground session id that produced the artifact files.',
						),
						'session'          => array(
							'type'        => 'object',
							'description' => 'Optional browser session metadata to preserve in artifact runtime provenance.',
						),
						'provenance'       => array(
							'type'        => 'object',
							'description' => 'Opaque caller provenance describing who requested the browser run and what produced these files.',
						),
						'caller'           => array(
							'type'        => 'object',
							'description' => 'Opaque caller-owned schema and metadata to preserve in the canonical artifact bundle.',
						),
						'caller_schema'    => array(
							'type'        => 'string',
							'description' => 'Optional caller schema URI or id preserved under metadata.caller.schema.',
						),
						'caller_schema_id' => array(
							'type'        => 'string',
							'description' => 'Optional caller schema id preserved under metadata.caller.schemaId.',
						),
						'caller_kind'      => array(
							'type'        => 'string',
							'description' => 'Optional caller artifact kind preserved under metadata.caller.kind.',
						),
						'caller_metadata'  => array(
							'type'        => 'object',
							'description' => 'Opaque caller-owned artifact bundle metadata preserved under metadata.caller.metadata.',
						),
						'materialization'  => array(
							'type'        => 'object',
							'description' => 'Opaque caller materialization metadata preserved under metadata.caller.materialization.',
						),
						'review_hints'     => array(
							'type'        => 'object',
							'description' => 'Optional caller review hints preserved in bundle metadata and review metadata.',
						),
						'apply_target'     => array(
							'type'        => 'object',
							'description' => 'Opaque caller apply target metadata preserved under metadata.caller.applyTarget.',
						),
						'files'            => array(
							'type'        => 'array',
							'description' => 'Browser-produced artifact files to store under files/browser/ in a canonical WP Codebox artifact bundle.',
							'items'       => array(
								'type'       => 'object',
								'required'   => array( 'path' ),
								'properties' => array(
									'path'           => array( 'type' => 'string' ),
									'content'        => array( 'type' => 'string' ),
									'content_base64' => array( 'type' => 'string' ),
									'encoding'       => array( 'type' => 'string', 'enum' => array( 'utf-8', 'base64' ) ),
									'mime_type'      => array( 'type' => 'string' ),
									'kind'           => array( 'type' => 'string' ),
								),
							),
						),
					),
				),
				'output_schema'       => array( 'type' => 'object' ),
				'execute_callback'    => array( WP_Codebox_Abilities::class, 'persist_browser_artifact' ),
				'permission_callback' => array( WP_Codebox_Abilities::class, 'can_persist_browser_artifact' ),
				'meta'                => array( 'show_in_rest' => true ),
			),
		);
	}
}
