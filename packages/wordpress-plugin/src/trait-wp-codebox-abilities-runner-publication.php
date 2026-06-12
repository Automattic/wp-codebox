<?php
/**
 * WP_Codebox_Abilities_Runner_Publication implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Runner_Publication {
	/** @return array<string,mixed> */
	private static function runner_workspace_prepare_input_schema(): array {
		return array(
			'type'       => 'object',
			'required'   => array( 'repo' ),
			'properties' => array(
				'schema'                  => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-prepare-request/v1' ),
				'repo'                    => array( 'type' => 'string', 'description' => 'Target repository name or owner/name.' ),
				'target_repo'             => array( 'type' => 'string' ),
				'checkout_path'           => array( 'type' => 'string', 'description' => 'Mounted Actions checkout path visible to the WordPress runtime.' ),
				'mounted_path'            => array( 'type' => 'string' ),
				'clone_url'               => array( 'type' => 'string' ),
				'branch'                  => array( 'type' => 'string' ),
				'branch_prefix'           => array( 'type' => 'string' ),
				'from'                    => array( 'type' => 'string' ),
				'runner_workspace'        => array( 'type' => 'object' ),
				'runner_workspace_config' => array( 'type' => 'object' ),
				'github_token_env'        => array( 'type' => 'string' ),
				'workload_id'             => array( 'type' => 'string' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function runner_workspace_prepare_output_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'success'      => array( 'type' => 'boolean' ),
				'schema'       => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-prepare-result/v1' ),
				'status'       => array( 'type' => 'string', 'enum' => array( 'prepared', 'failed', 'unavailable' ) ),
				'handle'       => array( 'type' => 'string' ),
				'path'         => array( 'type' => 'string' ),
				'backend'      => array( 'type' => 'string' ),
				'branch'       => array( 'type' => 'string' ),
				'repo'         => array( 'type' => 'string' ),
				'capabilities' => array( 'type' => 'object' ),
				'failure_type' => array( 'type' => 'string' ),
				'error'        => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function runner_workspace_identity_schema(): array {
		return array(
			'workspace'         => array( 'type' => 'string', 'description' => 'Runner workspace handle. Alias: workspace_handle or handle.' ),
			'workspace_handle'  => array( 'type' => 'string' ),
			'handle'            => array( 'type' => 'string' ),
			'workspace_path'    => array( 'type' => 'string' ),
			'workspace_backend' => array( 'type' => 'string' ),
			'runner_workspace'  => array( 'type' => 'object', 'description' => 'Opaque runner workspace identity and provenance.' ),
			'repo'              => array( 'type' => 'string', 'description' => 'Target repository, for example Automattic/wp-codebox. Alias: target_repo.' ),
			'target_repo'       => array( 'type' => 'string' ),
		);
	}

	/** @return array<string,mixed> */
	private static function runner_workspace_publication_input_schema(): array {
		$string_array = array( 'type' => 'array', 'items' => array( 'type' => 'string' ) );

		return array(
			'type'       => 'object',
			'required'   => array( 'workspace', 'repo', 'commit_message', 'title', 'body' ),
			'properties' => self::runner_workspace_identity_schema() + array(
				'schema'                => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-publication-request/v1' ),
				'base'                  => array( 'type' => 'string' ),
				'base_branch'           => array( 'type' => 'string' ),
				'head'                  => array( 'type' => 'string' ),
				'head_branch'           => array( 'type' => 'string' ),
				'commit_message'        => array( 'type' => 'string' ),
				'title'                 => array( 'type' => 'string', 'description' => 'Pull request title. Alias: pr_title.' ),
				'pr_title'              => array( 'type' => 'string' ),
				'body'                  => array( 'type' => 'string', 'description' => 'Pull request body. Alias: pr_body.' ),
				'pr_body'               => array( 'type' => 'string' ),
				'labels'                => $string_array,
				'draft'                 => array( 'type' => 'boolean' ),
				'maintainer_can_modify' => array( 'type' => 'boolean' ),
				'paths'                 => $string_array,
				'changed_paths'         => $string_array,
				'evidence_context'      => array( 'type' => 'object' ),
				'artifact_context'      => array( 'type' => 'object' ),
				'context'               => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function runner_workspace_capture_input_schema(): array {
		return array(
			'type'       => 'object',
			'required'   => array( 'workspace' ),
			'properties' => self::runner_workspace_identity_schema() + array(
				'schema'       => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-capture-request/v1' ),
				'from'         => array( 'type' => 'string' ),
				'to'           => array( 'type' => 'string' ),
				'path'         => array( 'type' => 'string' ),
				'include_diff' => array( 'type' => 'boolean', 'default' => true ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function runner_workspace_capture_output_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'success'      => array( 'type' => 'boolean' ),
				'schema'       => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-capture-result/v1' ),
				'status'       => array( 'type' => 'object' ),
				'diff'         => array( 'type' => 'object' ),
				'changed'      => array( 'type' => 'boolean' ),
				'backend'      => array( 'type' => 'string' ),
				'workspace'    => array( 'type' => 'object' ),
				'failure_type' => array( 'type' => 'string' ),
				'error'        => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function runner_workspace_command_input_schema(): array {
		return array(
			'type'       => 'object',
			'required'   => array( 'workspace', 'command' ),
			'properties' => self::runner_workspace_identity_schema() + array(
				'schema'              => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-command-request/v1' ),
				'command'             => array( 'type' => 'string' ),
				'description'         => array( 'type' => 'string' ),
				'timeout_seconds'     => array( 'type' => 'integer', 'minimum' => 1, 'maximum' => 600 ),
				'env'                 => array( 'type' => 'object' ),
				'context'             => array( 'type' => 'object' ),
				'allow_local_fallback' => array( 'type' => 'boolean', 'default' => true ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function runner_workspace_command_output_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'success'      => array( 'type' => 'boolean' ),
				'schema'       => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-command-result/v1' ),
				'status'       => array( 'type' => 'string', 'enum' => array( 'completed', 'failed', 'unavailable' ) ),
				'command'      => array( 'type' => 'string' ),
				'description'  => array( 'type' => 'string' ),
				'exit_code'    => array( 'type' => 'integer' ),
				'stdout'       => array( 'type' => 'string' ),
				'stderr'       => array( 'type' => 'string' ),
				'elapsed_ms'   => array( 'type' => 'number' ),
				'backend'      => array( 'type' => 'string' ),
				'workspace'    => array( 'type' => 'object' ),
				'failure_type' => array( 'type' => 'string' ),
				'error'        => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function runner_workspace_publication_output_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'success'      => array( 'type' => 'boolean' ),
				'schema'       => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-publication-result/v1' ),
				'status'       => array( 'type' => 'string', 'enum' => array( 'published', 'failed', 'write_without_pr' ) ),
				'failure_type' => array( 'type' => 'string' ),
				'error'        => array( 'type' => 'object' ),
				'backend'      => array( 'type' => 'string' ),
				'workspace'    => array( 'type' => 'object' ),
				'branch'       => array( 'type' => 'object' ),
				'commit'       => array( 'type' => 'object' ),
				'pull_request' => array( 'type' => 'object' ),
				'reused'       => array( 'type' => 'boolean' ),
				'opened'       => array( 'type' => 'boolean' ),
				'evidence'     => array( 'type' => 'object' ),
				'artifacts'    => array( 'type' => 'object' ),
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	public static function prepare_runner_workspace( array $input ): array {
		$normalized = self::normalize_runner_workspace_prepare_input( $input );
		if ( is_array( $normalized['error'] ?? null ) ) {
			return self::runner_workspace_prepare_failure( 'invalid_request', $normalized['error'], 'failed', $normalized );
		}

		$checkout_path = (string) $normalized['checkout_path'];
		if ( '' !== $checkout_path && ! defined( 'DATAMACHINE_WORKSPACE_PATH' ) ) {
			define( 'DATAMACHINE_WORKSPACE_PATH', rtrim( dirname( $checkout_path ), '/' ) );
		}

		$required = '' !== $checkout_path
			? array( 'datamachine-code/workspace-adopt' )
			: array( 'datamachine-code/workspace-show', 'datamachine-code/workspace-clone', 'datamachine-code/workspace-worktree-add' );

		foreach ( $required as $ability_name ) {
			$ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( $ability_name ) : null;
			if ( ! $ability || ! is_callable( array( $ability, 'execute' ) ) ) {
				return self::runner_workspace_prepare_failure(
					'backend_unavailable',
					array( 'code' => 'wp_codebox_runner_workspace_prepare_backend_unavailable', 'message' => 'Runner workspace backend ability is not available for preparation.', 'ability' => $ability_name ),
					'unavailable',
					$normalized
				);
			}
		}

		if ( '' !== $checkout_path ) {
			$adopt = wp_get_ability( 'datamachine-code/workspace-adopt' )->execute( array( 'path' => $checkout_path, 'name' => $normalized['repo'] ) );
			if ( is_wp_error( $adopt ) ) {
				return self::runner_workspace_prepare_failure( 'backend_error', array( 'code' => $adopt->get_error_code(), 'message' => $adopt->get_error_message(), 'data' => $adopt->get_error_data() ), 'failed', $normalized );
			}
			if ( ! is_array( $adopt ) || empty( $adopt['success'] ) ) {
				return self::runner_workspace_prepare_failure( 'backend_failed', array( 'code' => 'wp_codebox_runner_workspace_prepare_adopt_failed', 'message' => 'Runner workspace backend could not adopt the mounted checkout.', 'result' => $adopt ), 'failed', $normalized );
			}

			return array_filter(
				array(
					'success'      => true,
					'schema'       => 'wp-codebox/runner-workspace-prepare-result/v1',
					'status'       => 'prepared',
					'backend'      => 'datamachine-code',
					'repo'         => $normalized['repo'],
					'branch'       => $normalized['branch'],
					'handle'       => (string) ( $adopt['handle'] ?? $adopt['name'] ?? $normalized['repo'] ),
					'path'         => (string) ( $adopt['path'] ?? $checkout_path ),
					'capabilities' => array( 'capture' => true, 'command' => true, 'publish' => true ),
					'input'        => array( 'path' => $checkout_path, 'name' => $normalized['repo'] ),
					'result'       => $adopt,
				),
				static fn( mixed $value ): bool => '' !== $value && array() !== $value && null !== $value
			);
		}

		$show = wp_get_ability( 'datamachine-code/workspace-show' )->execute( array( 'name' => $normalized['repo'] ) );
		if ( is_wp_error( $show ) ) {
			if ( '' === $normalized['clone_url'] ) {
				return self::runner_workspace_prepare_failure( 'clone_url_required', array( 'code' => 'wp_codebox_runner_workspace_prepare_clone_url_required', 'message' => 'Runner workspace primary is missing and clone_url is empty.' ), 'failed', $normalized );
			}

			$clone_input = array( 'url' => $normalized['clone_url'], 'name' => $normalized['repo'] );
			if ( '' !== $normalized['github_token_env'] && '' !== trim( (string) getenv( $normalized['github_token_env'] ) ) && preg_match( '#^https://github\.com/#', $normalized['clone_url'] ) ) {
				$clone_input['auth_token_env'] = $normalized['github_token_env'];
			}

			$clone = wp_get_ability( 'datamachine-code/workspace-clone' )->execute( array_filter( $clone_input, static fn( mixed $value ): bool => '' !== $value ) );
			if ( is_wp_error( $clone ) ) {
				return self::runner_workspace_prepare_failure( 'backend_error', array( 'code' => $clone->get_error_code(), 'message' => $clone->get_error_message(), 'data' => $clone->get_error_data() ), 'failed', $normalized );
			}
		}

		$worktree_input = array_filter(
			array(
				'repo'           => $normalized['repo'],
				'branch'         => $normalized['branch'],
				'from'           => $normalized['from'],
				'inject_context' => $normalized['inject_context'],
				'bootstrap'      => $normalized['bootstrap'],
				'allow_stale'    => $normalized['allow_stale'],
				'rebase_base'    => $normalized['rebase_base'],
				'force'          => $normalized['force'],
			),
			static fn( mixed $value ): bool => '' !== $value && null !== $value
		);

		$worktree = wp_get_ability( 'datamachine-code/workspace-worktree-add' )->execute( $worktree_input );
		if ( is_wp_error( $worktree ) ) {
			return self::runner_workspace_prepare_failure( 'backend_error', array( 'code' => $worktree->get_error_code(), 'message' => $worktree->get_error_message(), 'data' => $worktree->get_error_data() ), 'failed', $normalized );
		}
		if ( ! is_array( $worktree ) || empty( $worktree['success'] ) ) {
			return self::runner_workspace_prepare_failure( 'backend_failed', array( 'code' => 'wp_codebox_runner_workspace_prepare_worktree_failed', 'message' => 'Runner workspace backend could not create the worktree.', 'result' => $worktree ), 'failed', $normalized );
		}

		return array_filter(
			array(
				'success'      => true,
				'schema'       => 'wp-codebox/runner-workspace-prepare-result/v1',
				'status'       => 'prepared',
				'backend'      => 'datamachine-code',
				'repo'         => $normalized['repo'],
				'branch'       => (string) ( $worktree['branch'] ?? $normalized['branch'] ),
				'handle'       => (string) ( $worktree['handle'] ?? '' ),
				'path'         => (string) ( $worktree['path'] ?? '' ),
				'capabilities' => array( 'capture' => true, 'command' => true, 'publish' => true ),
				'input'        => $worktree_input,
				'result'       => $worktree,
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	public static function publish_runner_workspace( array $input ): array {
		$normalized = self::normalize_runner_workspace_publication_input( $input );
		if ( is_array( $normalized['error'] ?? null ) ) {
			return self::runner_workspace_publication_failure( 'invalid_request', $normalized['error'], 'write_without_pr', $normalized );
		}

		$ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( 'datamachine-code/publish-runner-workspace' ) : null;
		if ( ! $ability || ! is_callable( array( $ability, 'execute' ) ) ) {
			return self::runner_workspace_publication_failure(
				'publication_unavailable',
				array(
					'code'    => 'wp_codebox_runner_workspace_publication_unavailable',
					'message' => 'Runner workspace publication is not available in this WP Codebox runtime.',
				),
				'write_without_pr',
				$normalized
			);
		}

		$result = $ability->execute( self::runner_workspace_publication_backend_input( $normalized ) );
		if ( is_wp_error( $result ) ) {
			return self::runner_workspace_publication_failure(
				'backend_error',
				array(
					'code'    => $result->get_error_code(),
					'message' => $result->get_error_message(),
					'data'    => $result->get_error_data(),
				),
				'failed',
				$normalized
			);
		}

		if ( ! is_array( $result ) ) {
			return self::runner_workspace_publication_failure(
				'backend_invalid_response',
				array(
					'code'    => 'wp_codebox_runner_workspace_publication_invalid_response',
					'message' => 'Runner workspace publication backend returned an invalid response.',
				),
				'failed',
				$normalized
			);
		}

		if ( false === ( $result['success'] ?? true ) ) {
			$error = is_array( $result['error'] ?? null ) ? $result['error'] : array( 'message' => (string) ( $result['error'] ?? 'Runner workspace publication failed.' ) );
			return self::runner_workspace_publication_failure( (string) ( $result['failure_type'] ?? 'backend_failed' ), $error, 'failed', $normalized, $result );
		}

		return self::normalize_runner_workspace_publication_result( $result, $normalized );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	public static function capture_runner_workspace( array $input ): array {
		$normalized = self::normalize_runner_workspace_identity_input( $input );
		if ( is_array( $normalized['error'] ?? null ) ) {
			return self::runner_workspace_operation_failure( 'capture', 'invalid_request', $normalized['error'], 'failed', $normalized );
		}

		$status = self::execute_runner_workspace_backend_ability( 'datamachine-code/workspace-git-status', array( 'name' => $normalized['workspace'] ) );
		if ( is_array( $status['error'] ?? null ) ) {
			return self::runner_workspace_operation_failure( 'capture', (string) $status['failure_type'], $status['error'], 'unavailable', $normalized );
		}

		$status_result = is_array( $status['result'] ?? null ) ? $status['result'] : array();
		$files         = self::runner_publication_string_list( $status_result['files'] ?? array() );
		$dirty         = (int) ( $status_result['dirty'] ?? count( $files ) );
		$backend       = (string) ( $status_result['backend'] ?? $normalized['workspace_backend'] ?? 'datamachine-code' );
		$diff_result   = array();
		$include_diff  = false !== ( $input['include_diff'] ?? true );

		if ( $include_diff ) {
			$diff_input = array_filter(
				array(
					'name' => $normalized['workspace'],
					'from' => trim( (string) ( $input['from'] ?? '' ) ),
					'to'   => trim( (string) ( $input['to'] ?? '' ) ),
					'path' => trim( (string) ( $input['path'] ?? '' ) ),
				),
				static fn( mixed $value ): bool => '' !== $value
			);
			$diff = self::execute_runner_workspace_backend_ability( 'datamachine-code/workspace-git-diff', $diff_input );
			if ( is_array( $diff['error'] ?? null ) ) {
				return self::runner_workspace_operation_failure( 'capture', (string) $diff['failure_type'], $diff['error'], 'unavailable', $normalized, array( 'status' => $status_result ) );
			}

			$diff_result = is_array( $diff['result'] ?? null ) ? $diff['result'] : array();
		}

		return array_filter(
			array(
				'success'   => true,
				'schema'    => 'wp-codebox/runner-workspace-capture-result/v1',
				'backend'   => $backend,
				'changed'   => $dirty > 0 || array() !== $files,
				'workspace' => self::runner_workspace_identity_result( $normalized, $backend ),
				'status'    => array_filter(
					array(
						'handle'  => (string) ( $status_result['name'] ?? $normalized['workspace'] ),
						'name'    => (string) ( $status_result['name'] ?? $normalized['workspace'] ),
						'repo'    => (string) ( $status_result['repo'] ?? $normalized['repo'] ),
						'path'    => (string) ( $status_result['path'] ?? $normalized['workspace_path'] ),
						'branch'  => (string) ( $status_result['branch'] ?? '' ),
						'remote'  => (string) ( $status_result['remote'] ?? '' ),
						'commit'  => (string) ( $status_result['commit'] ?? '' ),
						'dirty'   => $dirty,
						'files'   => $files,
						'backend' => $backend,
					),
					static fn( mixed $value ): bool => '' !== $value && array() !== $value
				),
				'diff'      => array_filter(
					array(
						'diff'    => (string) ( $diff_result['diff'] ?? '' ),
						'name'    => (string) ( $diff_result['name'] ?? $normalized['workspace'] ),
						'backend' => (string) ( $diff_result['backend'] ?? $backend ),
					),
					static fn( mixed $value ): bool => '' !== $value
				),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	public static function run_runner_workspace_command( array $input ): array {
		$normalized = self::normalize_runner_workspace_identity_input( $input );
		$command    = trim( (string) ( $input['command'] ?? '' ) );
		if ( '' === $command ) {
			$normalized['error'] = array(
				'code'    => 'wp_codebox_runner_workspace_command_invalid_request',
				'message' => 'Runner workspace command execution requires a command.',
				'missing' => array( 'command' ),
			);
		}

		if ( is_array( $normalized['error'] ?? null ) ) {
			return self::runner_workspace_operation_failure( 'command', 'invalid_request', $normalized['error'], 'failed', $normalized );
		}

		$backend_input = array_filter(
			array(
				'workspace'         => $normalized['workspace'],
				'workspace_handle'  => $normalized['workspace'],
				'name'              => $normalized['workspace'],
				'workspace_path'    => $normalized['workspace_path'],
				'workspace_backend' => $normalized['workspace_backend'],
				'repo'              => $normalized['repo'],
				'target_repo'       => $normalized['repo'],
				'command'           => $command,
				'description'       => trim( (string) ( $input['description'] ?? '' ) ),
				'timeout_seconds'   => max( 1, min( 600, (int) ( $input['timeout_seconds'] ?? 120 ) ) ),
				'env'               => is_array( $input['env'] ?? null ) ? $input['env'] : array(),
				'context'           => is_array( $input['context'] ?? null ) ? $input['context'] : array(),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value && null !== $value
		);

		$backend = self::execute_runner_workspace_backend_ability( 'datamachine-code/run-runner-workspace-command', $backend_input );
		if ( ! is_array( $backend['error'] ?? null ) ) {
			$result = is_array( $backend['result'] ?? null ) ? $backend['result'] : array();
			return self::normalize_runner_workspace_command_result( $result, $normalized, $backend_input, (string) ( $result['backend'] ?? 'datamachine-code' ) );
		}

		if ( false !== ( $input['allow_local_fallback'] ?? true ) && '' !== $normalized['workspace_path'] && is_dir( $normalized['workspace_path'] ) ) {
			return self::run_local_runner_workspace_command( $command, $normalized, $backend_input );
		}

		return self::runner_workspace_operation_failure(
			'command',
			(string) $backend['failure_type'],
			$backend['error'],
			'unavailable',
			$normalized
		);
	}

	/** @param array<string,mixed> $input Raw ability input. @return array<string,mixed> */
	private static function normalize_runner_workspace_prepare_input( array $input ): array {
		$config        = is_array( $input['runner_workspace_config'] ?? null ) ? $input['runner_workspace_config'] : ( is_array( $input['runner_workspace'] ?? null ) ? $input['runner_workspace'] : array() );
		$repo          = self::normalize_runner_workspace_repo_name( (string) ( $input['repo'] ?? $input['target_repo'] ?? $config['repo'] ?? '' ) );
		$checkout_path = trim( (string) ( $input['checkout_path'] ?? $input['mounted_path'] ?? $config['checkout_path'] ?? $config['mounted_path'] ?? $config['local_seed_path'] ?? '' ) );
		$branch        = trim( (string) ( $input['branch'] ?? $config['branch'] ?? '' ) );

		if ( '' === $branch ) {
			$prefix = trim( (string) ( $input['branch_prefix'] ?? $config['branch_prefix'] ?? 'agent-run' ) );
			$seed   = self::runner_workspace_slug( (string) ( $input['workload_id'] ?? $config['workload_id'] ?? 'wp-codebox-runner' ) );
			$branch = rtrim( '' !== $prefix ? $prefix : 'agent-run', '/' ) . '/' . gmdate( 'Y-m-d-His' ) . ( '' !== $seed ? '-' . $seed : '' );
		}

		$normalized = array(
			'repo'             => $repo,
			'target_repo'      => (string) ( $input['target_repo'] ?? $input['repo'] ?? $config['repo'] ?? '' ),
			'checkout_path'    => $checkout_path,
			'clone_url'        => trim( (string) ( $input['clone_url'] ?? $config['clone_url'] ?? '' ) ),
			'branch'           => $branch,
			'from'             => trim( (string) ( $input['from'] ?? $config['from'] ?? 'origin/HEAD' ) ),
			'inject_context'   => self::runner_workspace_bool( $input, $config, 'inject_context', true ),
			'bootstrap'        => self::runner_workspace_bool( $input, $config, 'bootstrap', true ),
			'allow_stale'      => self::runner_workspace_bool( $input, $config, 'allow_stale', false ),
			'rebase_base'      => self::runner_workspace_bool( $input, $config, 'rebase_base', false ),
			'force'            => self::runner_workspace_bool( $input, $config, 'force', false ),
			'github_token_env' => trim( (string) ( $input['github_token_env'] ?? $config['github_token_env'] ?? 'GITHUB_TOKEN' ) ),
			'config'           => $config,
		);

		if ( '' === $repo ) {
			$normalized['error'] = array( 'code' => 'wp_codebox_runner_workspace_prepare_invalid_request', 'message' => 'Runner workspace preparation requires repo.', 'missing' => array( 'repo' ) );
		}

		return $normalized;
	}

	private static function normalize_runner_workspace_repo_name( string $repo ): string {
		$repo = trim( $repo );
		if ( str_contains( $repo, '/' ) ) {
			$repo = basename( $repo );
		}
		return preg_replace( '/\.git$/', '', $repo ) ?? $repo;
	}

	private static function runner_workspace_bool( array $input, array $config, string $key, bool $default ): bool {
		if ( array_key_exists( $key, $input ) ) {
			return filter_var( $input[ $key ], FILTER_VALIDATE_BOOLEAN );
		}

		if ( array_key_exists( $key, $config ) ) {
			return filter_var( $config[ $key ], FILTER_VALIDATE_BOOLEAN );
		}

		return $default;
	}

	private static function runner_workspace_slug( string $value ): string {
		$slug = strtolower( preg_replace( '/[^a-zA-Z0-9]+/', '-', $value ) ?? '' );
		return trim( $slug, '-' );
	}

	/** @param array<string,mixed> $error Error shape. @param array<string,mixed> $input Normalized input. @return array<string,mixed> */
	private static function runner_workspace_prepare_failure( string $failure_type, array $error, string $status, array $input ): array {
		return array_filter(
			array(
				'success'      => false,
				'schema'       => 'wp-codebox/runner-workspace-prepare-result/v1',
				'status'       => $status,
				'failure_type' => $failure_type,
				'error'        => $error,
				'backend'      => 'datamachine-code',
				'repo'         => (string) ( $input['repo'] ?? '' ),
				'branch'       => (string) ( $input['branch'] ?? '' ),
				'capabilities' => array( 'capture' => false, 'command' => false, 'publish' => false ),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $input Raw ability input. @return array<string,mixed> */
	private static function normalize_runner_workspace_publication_input( array $input ): array {
		$identity  = self::normalize_runner_workspace_identity_input( $input );
		$workspace = (string) $identity['workspace'];
		$repo      = (string) $identity['repo'];
		$title     = trim( (string) ( $input['title'] ?? $input['pr_title'] ?? '' ) );
		$body      = (string) ( $input['body'] ?? $input['pr_body'] ?? '' );
		$paths     = self::runner_publication_string_list( $input['paths'] ?? $input['changed_paths'] ?? array() );

		$normalized = array(
			'workspace'             => $workspace,
			'workspace_handle'      => $workspace,
			'workspace_path'        => (string) $identity['workspace_path'],
			'workspace_backend'     => (string) $identity['workspace_backend'],
			'runner_workspace'      => $identity['runner_workspace'],
			'repo'                  => $repo,
			'target_repo'           => $repo,
			'base'                  => trim( (string) ( $input['base'] ?? $input['base_branch'] ?? '' ) ),
			'head'                  => trim( (string) ( $input['head'] ?? $input['head_branch'] ?? '' ) ),
			'commit_message'        => trim( (string) ( $input['commit_message'] ?? '' ) ),
			'title'                 => $title,
			'pr_title'              => $title,
			'body'                  => $body,
			'pr_body'               => $body,
			'labels'                => self::runner_publication_string_list( $input['labels'] ?? array() ),
			'draft'                 => ! empty( $input['draft'] ),
			'maintainer_can_modify' => array_key_exists( 'maintainer_can_modify', $input ) ? (bool) $input['maintainer_can_modify'] : true,
			'paths'                 => $paths,
			'changed_paths'         => $paths,
			'evidence_context'      => is_array( $input['evidence_context'] ?? null ) ? $input['evidence_context'] : ( is_array( $input['context'] ?? null ) ? $input['context'] : array() ),
			'artifact_context'      => is_array( $input['artifact_context'] ?? null ) ? $input['artifact_context'] : array(),
			'context'               => is_array( $input['context'] ?? null ) ? $input['context'] : array(),
		);

		$missing = array();
		foreach ( array( 'workspace', 'repo', 'commit_message', 'title', 'body' ) as $field ) {
			if ( '' === (string) $normalized[ $field ] ) {
				$missing[] = $field;
			}
		}

		if ( array() !== $missing ) {
			$normalized['error'] = array(
				'code'    => 'wp_codebox_runner_workspace_publication_invalid_request',
				'message' => 'Runner workspace publication requires workspace, repo, commit_message, title, and body.',
				'missing' => $missing,
			);
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Raw ability input. @return array<string,mixed> */
	private static function normalize_runner_workspace_identity_input( array $input ): array {
		$runner_workspace = is_array( $input['runner_workspace'] ?? null ) ? $input['runner_workspace'] : array();
		$workspace        = trim( (string) ( $input['workspace'] ?? $input['workspace_handle'] ?? $input['handle'] ?? $runner_workspace['handle'] ?? $runner_workspace['name'] ?? '' ) );
		$repo             = trim( (string) ( $input['repo'] ?? $input['target_repo'] ?? $runner_workspace['repo'] ?? '' ) );
		$path             = trim( (string) ( $input['workspace_path'] ?? $runner_workspace['path'] ?? '' ) );
		$backend          = trim( (string) ( $input['workspace_backend'] ?? $runner_workspace['backend'] ?? '' ) );

		$normalized = array(
			'workspace'         => $workspace,
			'workspace_handle'  => $workspace,
			'workspace_path'    => $path,
			'workspace_backend' => $backend,
			'runner_workspace'  => $runner_workspace,
			'repo'              => $repo,
			'target_repo'       => $repo,
		);

		if ( '' === $workspace ) {
			$normalized['error'] = array(
				'code'    => 'wp_codebox_runner_workspace_identity_invalid_request',
				'message' => 'Runner workspace APIs require a workspace handle.',
				'missing' => array( 'workspace' ),
			);
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Normalized input. @return array<string,mixed> */
	private static function runner_workspace_publication_backend_input( array $input ): array {
		return array_filter(
			array(
				'workspace_handle'      => $input['workspace_handle'],
				'workspace'             => $input['workspace'],
				'workspace_path'        => $input['workspace_path'],
				'workspace_backend'     => $input['workspace_backend'],
				'runner_workspace'      => $input['runner_workspace'],
				'target_repo'           => $input['target_repo'],
				'repo'                  => $input['repo'],
				'base'                  => $input['base'],
				'head'                  => $input['head'],
				'commit_message'        => $input['commit_message'],
				'pr_title'              => $input['pr_title'],
				'title'                 => $input['title'],
				'pr_body'               => $input['pr_body'],
				'body'                  => $input['body'],
				'labels'                => $input['labels'],
				'draft'                 => $input['draft'],
				'maintainer_can_modify' => $input['maintainer_can_modify'],
				'changed_paths'         => $input['changed_paths'],
				'paths'                 => $input['paths'],
				'evidence_context'      => $input['evidence_context'],
				'artifact_context'      => $input['artifact_context'],
				'context'               => $input['context'],
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $result Backend response. @param array<string,mixed> $input Normalized input. @return array<string,mixed> */
	private static function normalize_runner_workspace_publication_result( array $result, array $input ): array {
		$workspace = is_array( $result['workspace'] ?? null ) ? $result['workspace'] : array();
		$branch    = is_array( $result['branch'] ?? null ) ? $result['branch'] : array();
		$commit    = is_array( $result['commit'] ?? null ) ? $result['commit'] : array();
		$pr        = is_array( $result['pull_request'] ?? null ) ? $result['pull_request'] : array();

		$backend = (string) ( $result['backend'] ?? $workspace['backend'] ?? $input['workspace_backend'] ?? 'unknown' );
		$sha     = (string) ( $commit['sha'] ?? $result['commit_sha'] ?? $result['commit'] ?? '' );
		$number  = (int) ( $pr['number'] ?? $result['pull_number'] ?? $result['pr_number'] ?? 0 );
		$url     = (string) ( $pr['url'] ?? $pr['html_url'] ?? $result['pr_url'] ?? $result['html_url'] ?? $result['url'] ?? '' );
		$reused  = (bool) ( $pr['reused'] ?? $result['reused'] ?? false );
		$opened  = array_key_exists( 'opened', $pr ) ? (bool) $pr['opened'] : ( array_key_exists( 'opened', $result ) ? (bool) $result['opened'] : ! $reused );

		return array_filter(
			array(
				'success'      => true,
				'schema'       => 'wp-codebox/runner-workspace-publication-result/v1',
				'status'       => 'published',
				'backend'      => $backend,
				'workspace'    => array_filter(
					array(
						'handle'  => (string) ( $workspace['handle'] ?? $workspace['name'] ?? $result['workspace_handle'] ?? $result['name'] ?? $input['workspace'] ),
						'path'    => (string) ( $workspace['path'] ?? $result['workspace_path'] ?? $input['workspace_path'] ),
						'backend' => $backend,
					),
					static fn( mixed $value ): bool => '' !== $value
				),
				'branch'       => array_filter(
					array(
						'base'   => (string) ( $branch['base'] ?? $result['base'] ?? $input['base'] ),
						'head'   => (string) ( $branch['head'] ?? $result['head'] ?? $input['head'] ),
						'name'   => (string) ( $branch['name'] ?? $result['branch'] ?? $input['head'] ),
						'remote' => (string) ( $branch['remote'] ?? $result['remote'] ?? '' ),
					),
					static fn( mixed $value ): bool => '' !== $value
				),
				'commit'       => array_filter( array( 'sha' => $sha, 'message' => (string) ( $commit['message'] ?? $input['commit_message'] ) ), static fn( mixed $value ): bool => '' !== $value ),
				'pull_request' => array_filter(
					array(
						'number' => $number > 0 ? $number : null,
						'url'    => $url,
						'reused' => $reused,
						'opened' => $opened,
					),
					static fn( mixed $value ): bool => null !== $value && '' !== $value
				),
				'reused'       => $reused,
				'opened'       => $opened,
				'evidence'     => $input['evidence_context'],
				'artifacts'    => $input['artifact_context'],
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $error Error shape. @param array<string,mixed> $input Normalized input. @param array<string,mixed> $raw_result Raw backend result. @return array<string,mixed> */
	private static function runner_workspace_publication_failure( string $failure_type, array $error, string $status, array $input, array $raw_result = array() ): array {
		return array_filter(
			array(
				'success'      => false,
				'schema'       => 'wp-codebox/runner-workspace-publication-result/v1',
				'status'       => $status,
				'failure_type' => $failure_type,
				'error'        => $error,
				'backend'      => (string) ( $raw_result['backend'] ?? $input['workspace_backend'] ?? 'unavailable' ),
				'workspace'    => array_filter( array( 'handle' => (string) ( $input['workspace'] ?? '' ), 'path' => (string) ( $input['workspace_path'] ?? '' ) ), static fn( mixed $value ): bool => '' !== $value ),
				'branch'       => array_filter( array( 'base' => (string) ( $input['base'] ?? '' ), 'head' => (string) ( $input['head'] ?? '' ) ), static fn( mixed $value ): bool => '' !== $value ),
				'reused'       => false,
				'opened'       => false,
				'evidence'     => is_array( $input['evidence_context'] ?? null ) ? $input['evidence_context'] : array(),
				'artifacts'    => is_array( $input['artifact_context'] ?? null ) ? $input['artifact_context'] : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array{result?:array<string,mixed>,failure_type?:string,error?:array<string,mixed>} */
	private static function execute_runner_workspace_backend_ability( string $ability_name, array $input ): array {
		$ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( $ability_name ) : null;
		if ( ! $ability || ! is_callable( array( $ability, 'execute' ) ) ) {
			return array(
				'failure_type' => 'backend_unavailable',
				'error'        => array(
					'code'    => 'wp_codebox_runner_workspace_backend_unavailable',
					'message' => 'Runner workspace backend ability is not available for this operation.',
					'ability' => $ability_name,
				),
			);
		}

		$result = $ability->execute( $input );
		if ( is_wp_error( $result ) ) {
			return array(
				'failure_type' => 'backend_error',
				'error'        => array(
					'code'    => $result->get_error_code(),
					'message' => $result->get_error_message(),
					'data'    => $result->get_error_data(),
					'ability' => $ability_name,
				),
			);
		}

		if ( ! is_array( $result ) ) {
			return array(
				'failure_type' => 'backend_invalid_response',
				'error'        => array(
					'code'    => 'wp_codebox_runner_workspace_backend_invalid_response',
					'message' => 'Runner workspace backend ability returned an invalid response.',
					'ability' => $ability_name,
				),
			);
		}

		if ( false === ( $result['success'] ?? true ) ) {
			return array(
				'failure_type' => (string) ( $result['failure_type'] ?? 'backend_failed' ),
				'error'        => is_array( $result['error'] ?? null ) ? $result['error'] : array( 'message' => (string) ( $result['error'] ?? 'Runner workspace backend operation failed.' ), 'ability' => $ability_name ),
			);
		}

		return array( 'result' => $result );
	}

	/** @param array<string,mixed> $input Normalized input. @param array<string,mixed> $extra Extra response fields. @return array<string,mixed> */
	private static function runner_workspace_operation_failure( string $operation, string $failure_type, array $error, string $status, array $input, array $extra = array() ): array {
		return array_filter(
			array_merge(
				array(
					'success'      => false,
					'schema'       => 'command' === $operation ? 'wp-codebox/runner-workspace-command-result/v1' : 'wp-codebox/runner-workspace-capture-result/v1',
					'status'       => $status,
					'failure_type' => $failure_type,
					'error'        => $error,
					'backend'      => (string) ( $input['workspace_backend'] ?? 'unavailable' ),
					'workspace'    => self::runner_workspace_identity_result( $input, (string) ( $input['workspace_backend'] ?? 'unavailable' ) ),
				),
				$extra
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $input Normalized input. @return array<string,mixed> */
	private static function runner_workspace_identity_result( array $input, string $backend ): array {
		return array_filter(
			array(
				'handle'  => (string) ( $input['workspace'] ?? '' ),
				'path'    => (string) ( $input['workspace_path'] ?? '' ),
				'repo'    => (string) ( $input['repo'] ?? '' ),
				'backend' => $backend,
			),
			static fn( mixed $value ): bool => '' !== $value
		);
	}

	/** @param array<string,mixed> $result Backend result. @param array<string,mixed> $input Normalized input. @param array<string,mixed> $command_input Command input. @return array<string,mixed> */
	private static function normalize_runner_workspace_command_result( array $result, array $input, array $command_input, string $backend ): array {
		$exit_code = (int) ( $result['exit_code'] ?? $result['code'] ?? 0 );

		return array_filter(
			array(
				'success'     => (bool) ( $result['success'] ?? 0 === $exit_code ),
				'schema'      => 'wp-codebox/runner-workspace-command-result/v1',
				'status'      => (bool) ( $result['success'] ?? 0 === $exit_code ) ? 'completed' : 'failed',
				'command'     => (string) ( $result['command'] ?? $command_input['command'] ?? '' ),
				'description' => (string) ( $result['description'] ?? $command_input['description'] ?? '' ),
				'exit_code'   => $exit_code,
				'stdout'      => (string) ( $result['stdout'] ?? '' ),
				'stderr'      => (string) ( $result['stderr'] ?? '' ),
				'elapsed_ms'  => (float) ( $result['elapsed_ms'] ?? 0 ),
				'backend'     => $backend,
				'workspace'   => self::runner_workspace_identity_result( $input, $backend ),
			),
			static fn( mixed $value ): bool => '' !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $input Normalized input. @param array<string,mixed> $command_input Command input. @return array<string,mixed> */
	private static function run_local_runner_workspace_command( string $command, array $input, array $command_input ): array {
		if ( ! function_exists( 'proc_open' ) ) {
			return self::runner_workspace_operation_failure(
				'command',
				'local_command_unavailable',
				array( 'code' => 'wp_codebox_runner_workspace_local_command_unavailable', 'message' => 'Local command execution is unavailable in this PHP runtime.' ),
				'unavailable',
				$input
			);
		}

		$started = hrtime( true );
		$env     = is_array( $command_input['env'] ?? null ) ? array_map( 'strval', $command_input['env'] ) : array();
		$process = proc_open(
			$command,
			array(
				1 => array( 'pipe', 'w' ),
				2 => array( 'pipe', 'w' ),
			),
			$pipes,
			(string) $input['workspace_path'],
			array() === $env ? null : $env
		);

		if ( ! is_resource( $process ) ) {
			return self::runner_workspace_operation_failure(
				'command',
				'local_command_failed',
				array( 'code' => 'wp_codebox_runner_workspace_local_command_failed', 'message' => 'Failed to start local runner workspace command.' ),
				'failed',
				$input
			);
		}

		$stdout    = stream_get_contents( $pipes[1] );
		$stderr    = stream_get_contents( $pipes[2] );
		fclose( $pipes[1] );
		fclose( $pipes[2] );
		$exit_code = proc_close( $process );

		return self::normalize_runner_workspace_command_result(
			array(
				'success'    => 0 === $exit_code,
				'exit_code'  => $exit_code,
				'stdout'     => is_string( $stdout ) ? trim( $stdout ) : '',
				'stderr'     => is_string( $stderr ) ? trim( $stderr ) : '',
				'elapsed_ms' => ( hrtime( true ) - $started ) / 1000000,
			),
			$input,
			$command_input,
			'local_path'
		);
	}

	/** @return array<int,string> */
	private static function runner_publication_string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		return array_values( array_filter( array_map( static fn( mixed $item ): string => trim( (string) $item ), $value ), static fn( string $item ): bool => '' !== $item ) );
	}
}
