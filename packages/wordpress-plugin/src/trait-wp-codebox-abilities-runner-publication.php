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
				'exclude_paths' => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
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
		$prepared = self::runner_workspace_adapter()->prepare( $normalized );
		if ( empty( $prepared['success'] ) ) {
			return self::runner_workspace_prepare_failure( (string) ( $prepared['failure_type'] ?? 'backend_failed' ), is_array( $prepared['error'] ?? null ) ? $prepared['error'] : array( 'message' => 'Runner workspace preparation failed.' ), 'backend_unavailable' === (string) ( $prepared['failure_type'] ?? '' ) ? 'unavailable' : 'failed', $normalized );
		}

		$worktree = is_array( $prepared['result'] ?? null ) ? $prepared['result'] : array();

		return array_filter(
			array(
				'success'      => true,
				'schema'       => 'wp-codebox/runner-workspace-prepare-result/v1',
				'status'       => 'prepared',
				'repo'         => $normalized['repo'],
				'branch'       => (string) ( $worktree['branch'] ?? $normalized['branch'] ),
				'handle'       => (string) ( $worktree['handle'] ?? '' ),
				'path'         => (string) ( $worktree['path'] ?? '' ),
				'capabilities' => array( 'capture' => true, 'command' => true, 'publish' => true ),
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

		$backend = self::runner_workspace_adapter()->publish( self::runner_workspace_publication_backend_input( $normalized ) );
		if ( empty( $backend['success'] ) ) {
			$status = 'backend_unavailable' === (string) ( $backend['failure_type'] ?? '' ) ? 'write_without_pr' : 'failed';
			return self::runner_workspace_publication_failure( (string) ( $backend['failure_type'] ?? 'backend_failed' ), is_array( $backend['error'] ?? null ) ? $backend['error'] : array( 'message' => 'Runner workspace publication failed.' ), $status, $normalized );
		}

		$result = is_array( $backend['result'] ?? null ) ? $backend['result'] : array();
		return self::normalize_runner_workspace_publication_result( $result, $normalized );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	public static function capture_runner_workspace( array $input ): array {
		$normalized = self::normalize_runner_workspace_identity_input( $input );
		if ( is_array( $normalized['error'] ?? null ) ) {
			return self::runner_workspace_operation_failure( 'capture', 'invalid_request', $normalized['error'], 'failed', $normalized );
		}

		$status = self::runner_workspace_adapter()->git_status( (string) $normalized['workspace'] );
		if ( empty( $status['success'] ) ) {
			return self::runner_workspace_operation_failure( 'capture', (string) $status['failure_type'], $status['error'], 'unavailable', $normalized );
		}

		$status_result = is_array( $status['result'] ?? null ) ? $status['result'] : array();
		$exclude_paths = self::runner_publication_string_list( $input['exclude_paths'] ?? array() );
		$files         = self::filter_runner_workspace_capture_files( self::runner_publication_string_list( $status_result['files'] ?? array() ), $exclude_paths );
		$dirty         = count( $files );
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
			$diff = self::runner_workspace_adapter()->git_diff( $diff_input );
			if ( empty( $diff['success'] ) ) {
				return self::runner_workspace_operation_failure( 'capture', (string) $diff['failure_type'], $diff['error'], 'unavailable', $normalized );
			}

			$diff_result = is_array( $diff['result'] ?? null ) ? $diff['result'] : array();
			if ( ! empty( $exclude_paths ) && is_string( $diff_result['diff'] ?? null ) ) {
				$diff_result['diff'] = self::filter_runner_workspace_capture_diff( (string) $diff_result['diff'], $exclude_paths );
			}
		}

		return array_filter(
			array(
				'success'   => true,
				'schema'    => 'wp-codebox/runner-workspace-capture-result/v1',
				'changed'   => $dirty > 0 || array() !== $files,
				'workspace' => self::runner_workspace_identity_result( $normalized ),
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
					),
					static fn( mixed $value ): bool => '' !== $value && array() !== $value
				),
				'diff'      => array_filter(
					array(
						'diff'    => (string) ( $diff_result['diff'] ?? '' ),
						'name'    => (string) ( $diff_result['name'] ?? $normalized['workspace'] ),
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

		$backend = self::runner_workspace_adapter()->run_command( $backend_input );
		if ( ! empty( $backend['success'] ) ) {
			$result = is_array( $backend['result'] ?? null ) ? $backend['result'] : array();
			return self::normalize_runner_workspace_command_result( $result, $normalized, $backend_input );
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

	private static function runner_workspace_adapter(): WP_Codebox_Runner_Workspace_Adapter {
		static $adapter = null;
		if ( ! $adapter instanceof WP_Codebox_Runner_Workspace_Adapter ) {
			$adapter = new WP_Codebox_Runner_Workspace_Adapter();
		}

		return $adapter;
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
				'workspace'    => array_filter(
					array(
						'handle'  => (string) ( $workspace['handle'] ?? $workspace['name'] ?? $result['workspace_handle'] ?? $result['name'] ?? $input['workspace'] ),
						'path'    => (string) ( $workspace['path'] ?? $result['workspace_path'] ?? $input['workspace_path'] ),
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

	/** @param array<string,mixed> $error Error shape. @param array<string,mixed> $input Normalized input. @return array<string,mixed> */
	private static function runner_workspace_publication_failure( string $failure_type, array $error, string $status, array $input ): array {
		return array_filter(
			array(
				'success'      => false,
				'schema'       => 'wp-codebox/runner-workspace-publication-result/v1',
				'status'       => $status,
				'failure_type' => $failure_type,
				'error'        => $error,
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
					'workspace'    => self::runner_workspace_identity_result( $input ),
				),
				$extra
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $input Normalized input. @return array<string,mixed> */
	private static function runner_workspace_identity_result( array $input ): array {
		return array_filter(
			array(
				'handle'  => (string) ( $input['workspace'] ?? '' ),
				'path'    => (string) ( $input['workspace_path'] ?? '' ),
				'repo'    => (string) ( $input['repo'] ?? '' ),
			),
			static fn( mixed $value ): bool => '' !== $value
		);
	}

	/** @param array<string,mixed> $result Backend result. @param array<string,mixed> $input Normalized input. @param array<string,mixed> $command_input Command input. @return array<string,mixed> */
	private static function normalize_runner_workspace_command_result( array $result, array $input, array $command_input ): array {
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
				'workspace'   => self::runner_workspace_identity_result( $input ),
			),
			static fn( mixed $value ): bool => '' !== $value && null !== $value
		);
	}

	/** @return array<int,string> */
	private static function runner_publication_string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		return array_values( array_filter( array_map( static fn( mixed $item ): string => trim( (string) $item ), $value ), static fn( string $item ): bool => '' !== $item ) );
	}

	/** @param array<int,string> $files @param array<int,string> $exclude_paths @return array<int,string> */
	private static function filter_runner_workspace_capture_files( array $files, array $exclude_paths ): array {
		$filtered = array();
		foreach ( $files as $file ) {
			$path = self::runner_workspace_status_path( $file );
			if ( '' !== $path && ( empty( $exclude_paths ) || ! self::runner_workspace_capture_path_excluded( $path, $exclude_paths ) ) ) {
				$filtered[] = $path;
			}
		}

		return array_values( array_unique( $filtered ) );
	}

	/** @param array<int,string> $exclude_paths */
	private static function filter_runner_workspace_capture_diff( string $diff, array $exclude_paths ): string {
		if ( '' === $diff || empty( $exclude_paths ) ) {
			return $diff;
		}

		$sections = preg_split( '/(?=^diff --git )/m', $diff );
		if ( ! is_array( $sections ) ) {
			return $diff;
		}

		$kept = array();
		foreach ( $sections as $section ) {
			if ( '' === $section ) {
				continue;
			}
			if ( preg_match( '/^diff --git a\/(.*?) b\//m', $section, $matches ) && self::runner_workspace_capture_path_excluded( $matches[1], $exclude_paths ) ) {
				continue;
			}
			$kept[] = $section;
		}

		return implode( '', $kept );
	}

	private static function runner_workspace_status_path( string $status_line ): string {
		$line = trim( $status_line );
		if ( preg_match( '/^(?:[ MADRCU?!]{1,2})\s+(.+)$/', $line, $matches ) ) {
			$line = $matches[1];
		}
		if ( str_contains( $line, ' -> ' ) ) {
			$parts = explode( ' -> ', $line );
			$line  = (string) end( $parts );
		}

		return trim( $line, " \t\n\r\0\x0B\"'" );
	}

	/** @param array<int,string> $exclude_paths */
	private static function runner_workspace_capture_path_excluded( string $path, array $exclude_paths ): bool {
		$path = ltrim( trim( $path ), '/' );
		foreach ( $exclude_paths as $pattern ) {
			$pattern = ltrim( trim( $pattern ), '/' );
			if ( '' === $pattern ) {
				continue;
			}
			$prefix = str_ends_with( $pattern, '/**' ) ? substr( $pattern, 0, -3 ) : null;
			if ( null !== $prefix && ( $path === rtrim( $prefix, '/' ) || str_starts_with( $path, rtrim( $prefix, '/' ) . '/' ) ) ) {
				return true;
			}
			if ( $path === rtrim( $pattern, '/' ) || str_starts_with( $path, rtrim( $pattern, '/' ) . '/' ) ) {
				return true;
			}
		}

		return false;
	}
}
