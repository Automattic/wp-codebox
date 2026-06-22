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

	/** @var array<string,string> */
	private const ABILITY_METHODS = array(
		'wp-codebox/run-agent-task'                         => 'run_agent_task',
		'wp-codebox/run-agent-task-batch'                   => 'run_agent_task_batch',
		'wp-codebox/run-agent-task-fanout'                  => 'run_agent_task_fanout',
		'wp-codebox/run-runtime-task'                       => 'run_runtime_task',
		'wp-codebox/run-wordpress-workload'                 => 'run_wordpress_workload',
		'wp-codebox/run-runtime-package'                    => 'run_runtime_package',
		'wp-codebox/create-browser-playground-session'      => 'create_browser_session',
		'wp-codebox/create-sandbox-session'                 => 'create_browser_session',
		'wp-codebox/create-browser-task-contract'           => 'create_browser_task_contract',
		'wp-codebox/create-task-contract'                   => 'create_browser_task_contract',
		'wp-codebox/create-browser-materializer-contract'   => 'create_browser_materializer_contract',
		'wp-codebox/create-browser-contained-site-session'  => 'create_browser_contained_site_session',
		'wp-codebox/get-browser-contained-site-status'      => 'browser_contained_site_status',
		'wp-codebox/preview-reuse-decision'                 => 'preview_reuse_decision',
		'wp-codebox/open-browser-contained-site'            => 'open_browser_session',
		'wp-codebox/open-or-create-browser-contained-site'  => 'open_or_create_browser_contained_site',
		'wp-codebox/open-contained-runtime'                 => 'open_or_create_browser_contained_site',
		'wp-codebox/request-host-delegation'                => 'request_host_delegation',
		'wp-codebox/list-artifacts'                         => 'list_artifacts',
		'wp-codebox/get-artifact'                           => 'get_artifact',
		'wp-codebox/normalize-browser-artifact-bundle'      => 'normalize_artifact_bundle',
		'wp-codebox/persist-browser-artifact'               => 'persist_artifact',
		'wp-codebox/import-artifact-bundle'                 => 'import_artifact',
		'wp-codebox/reimport-artifact-bundle'               => 'reimport_artifact',
		'wp-codebox/apply-artifact-preflight'               => 'preflight_artifact_apply',
		'wp-codebox/stage-artifact-apply'                   => 'stage_artifact_apply',
		'wp-codebox/apply-approved-artifact'                => 'apply_approved_artifact',
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
