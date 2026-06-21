<?php
/**
 * Runner workspace backend contract.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Runner_Workspace_Backend {
	public const SCHEMA = 'wp-codebox/runner-workspace-backend/v1';

	public const OPERATION_WORKSPACE_ADOPT          = 'workspace_adopt';
	public const OPERATION_WORKSPACE_SHOW           = 'workspace_show';
	public const OPERATION_WORKSPACE_CLONE          = 'workspace_clone';
	public const OPERATION_WORKSPACE_WORKTREE_ADD   = 'workspace_worktree_add';
	public const OPERATION_WORKSPACE_GIT_STATUS     = 'workspace_git_status';
	public const OPERATION_WORKSPACE_GIT_DIFF       = 'workspace_git_diff';
	public const OPERATION_RUN_WORKSPACE_COMMAND    = 'run_runner_workspace_command';
	public const OPERATION_PUBLISH_RUNNER_WORKSPACE = 'publish_runner_workspace';

	private const ABILITY_NAME_PATTERN = '#^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._/-]*$#i';

	/** @return list<string> */
	public static function operations(): array {
		return array(
			self::OPERATION_WORKSPACE_ADOPT,
			self::OPERATION_WORKSPACE_SHOW,
			self::OPERATION_WORKSPACE_CLONE,
			self::OPERATION_WORKSPACE_WORKTREE_ADD,
			self::OPERATION_WORKSPACE_GIT_STATUS,
			self::OPERATION_WORKSPACE_GIT_DIFF,
			self::OPERATION_RUN_WORKSPACE_COMMAND,
			self::OPERATION_PUBLISH_RUNNER_WORKSPACE,
		);
	}

	/** @return array{schema:string,id:string,workspace_root_constant:string,operations:array<string,string>} */
	public static function normalize( mixed $config ): array {
		$config = is_array( $config ) ? $config : array();

		return array(
			'schema'                  => self::SCHEMA,
			'id'                      => is_string( $config['id'] ?? null ) ? trim( $config['id'] ) : '',
			'workspace_root_constant' => is_string( $config['workspace_root_constant'] ?? null ) ? trim( $config['workspace_root_constant'] ) : '',
			'operations'              => self::normalize_operations( $config['operations'] ?? array() ),
		);
	}

	/** @return array<string,string> */
	private static function normalize_operations( mixed $operations ): array {
		if ( ! is_array( $operations ) ) {
			return array();
		}

		$normalized = array();
		foreach ( self::operations() as $operation ) {
			$value = $operations[ $operation ] ?? null;
			if ( is_array( $value ) ) {
				$value = $value['ability'] ?? null;
			}

			if ( ! is_string( $value ) ) {
				continue;
			}

			$value = trim( $value );
			if ( '' !== $value && self::valid_ability_name( $value ) ) {
				$normalized[ $operation ] = $value;
			}
		}

		return $normalized;
	}

	public static function valid_ability_name( string $ability_name ): bool {
		return '' !== $ability_name && 1 === preg_match( self::ABILITY_NAME_PATTERN, $ability_name );
	}
}
