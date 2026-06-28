<?php
/**
 * Runner workspace executor behavior.
 *
 * Shared tool-name -> engine mapping and workspace-root resolution for the
 * runner workspace executor. Kept in a trait so the executor can implement the
 * Agents API tool-executor interface only when that interface is loaded.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Runner_Workspace_Executor_Behavior {

	public const TARGET_ID = 'wp-codebox/runner-workspace';

	/** Constant a runner may define to pin its workspace root. */
	public const WORKSPACE_ROOT_CONSTANT = 'WP_CODEBOX_RUNNER_WORKSPACE_ROOT';

	/**
	 * Agent-facing tool names mapped to engine operations. Tool names are the
	 * codebox-native surface; engine methods do the real work.
	 *
	 * @return array<string,string>
	 */
	public static function tool_map(): array {
		return array(
			'workspace-read'                => 'read',
			'workspace-ls'                  => 'ls',
			'workspace-grep'                => 'grep',
			'workspace-write'               => 'write',
			'workspace-edit'                => 'edit',
			'workspace-apply-patch'         => 'apply_patch',
			'workspace-git-status'          => 'git_status',
			'workspace-git-diff'            => 'git_diff',
			'workspace-git-add'             => 'git_add',
			'workspace-git-commit'          => 'git_commit',
			'workspace-git-push'            => 'git_push',
			'create-github-pull-request'    => 'create_pull_request',
			'create-github-issue'           => 'create_issue',
			'comment-github-pull-request'   => 'comment_pull_request',
		);
	}

	/**
	 * Execute a tool call against the engine bound to the resolved workspace root.
	 *
	 * @param array<string,mixed> $parameters
	 * @param array<string,mixed> $context
	 * @return array<string,mixed>
	 */
	public function execute_tool( string $tool_name, array $parameters, array $context = array() ): array {
		$operation = self::tool_map()[ self::normalize_tool_name( $tool_name ) ] ?? '';
		if ( '' === $operation ) {
			return array(
				'success' => false,
				'error'   => array(
					'code'    => 'wp_codebox_runner_workspace_unknown_tool',
					'message' => sprintf( 'Runner workspace executor does not handle tool "%s".', $tool_name ),
				),
			);
		}

		$root = self::resolve_workspace_root( $parameters, $context );
		if ( '' === $root || ! is_dir( $root ) ) {
			return array(
				'success' => false,
				'error'   => array(
					'code'    => 'wp_codebox_runner_workspace_root_unavailable',
					'message' => 'Runner workspace root is not configured or does not exist.',
				),
			);
		}

		$engine = new WP_Codebox_Runner_Workspace_Tools( $root );
		/** @var callable $callable */
		$callable = array( $engine, $operation );
		return (array) $callable( $parameters );
	}

	private static function normalize_tool_name( string $tool_name ): string {
		$tool_name = trim( $tool_name );
		// Accept namespaced declarations like "wp-codebox/workspace-read".
		$slash = strrpos( $tool_name, '/' );
		return false !== $slash ? substr( $tool_name, $slash + 1 ) : $tool_name;
	}

	/**
	 * Resolve the workspace root the tools operate on. Explicit per-call input
	 * wins, then the runtime client context, then a runner-defined constant,
	 * then an integration filter.
	 *
	 * @param array<string,mixed> $parameters
	 * @param array<string,mixed> $context
	 */
	public static function resolve_workspace_root( array $parameters, array $context = array() ): string {
		$explicit = trim( (string) ( $parameters['workspace_root'] ?? $context['workspace_root'] ?? '' ) );
		if ( '' !== $explicit ) {
			return self::canonical_root( $explicit );
		}

		$from_context = self::workspace_root_from_context( $context );
		if ( '' !== $from_context ) {
			return self::canonical_root( $from_context );
		}

		if ( defined( self::WORKSPACE_ROOT_CONSTANT ) ) {
			$constant = (string) constant( self::WORKSPACE_ROOT_CONSTANT );
			if ( '' !== trim( $constant ) ) {
				return self::canonical_root( $constant );
			}
		}

		if ( function_exists( 'apply_filters' ) ) {
			$filtered = apply_filters( 'wp_codebox_runner_workspace_root', '', $parameters, $context );
			if ( is_string( $filtered ) && '' !== trim( $filtered ) ) {
				return self::canonical_root( $filtered );
			}
		}

		return '';
	}

	/** @param array<string,mixed> $context */
	private static function workspace_root_from_context( array $context ): string {
		$candidates = array(
			$context['default_workspace']['target'] ?? null,
			$context['sandbox_workspace']['root'] ?? null,
		);
		foreach ( is_array( $context['sandbox_workspace']['mounts'] ?? null ) ? $context['sandbox_workspace']['mounts'] : array() as $mount ) {
			if ( is_array( $mount ) && 'readwrite' === ( $mount['mode'] ?? '' ) && is_string( $mount['target'] ?? null ) ) {
				$candidates[] = $mount['target'];
			}
		}
		foreach ( $candidates as $candidate ) {
			if ( is_string( $candidate ) && '' !== trim( $candidate ) ) {
				return trim( $candidate );
			}
		}
		return '';
	}

	private static function canonical_root( string $root ): string {
		$resolved = realpath( $root );
		return false !== $resolved ? $resolved : rtrim( $root, '/' );
	}
}
