<?php
/**
 * Runner workspace backend adapter.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Runner_Workspace_Adapter {
	public const BACKEND_SCHEMA  = 'wp-codebox/runner-workspace-backend/v1';
	public const BACKEND_VERSION = 1;

	private const ABILITY_KEYS = array(
		'workspace_adopt',
		'workspace_show',
		'workspace_clone',
		'workspace_worktree_add',
		'workspace_git_status',
		'workspace_git_diff',
		'run_runner_workspace_command',
		'publish_runner_workspace',
	);

	private const ABILITY_NAME_PATTERN = '#^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._/-]*$#i';
	private const BACKEND_ID_PATTERN = '#^[a-z0-9][a-z0-9._-]*$#i';

	/** @return array<string,mixed> */
	public static function backend_schema(): array {
		return array(
			'$id'        => self::BACKEND_SCHEMA,
			'type'       => 'object',
			'properties' => array(
				'schema'                  => array( 'type' => 'string', 'const' => self::BACKEND_SCHEMA ),
				'version'                 => array( 'type' => 'integer', 'const' => self::BACKEND_VERSION ),
				'id'                      => array( 'type' => 'string', 'description' => 'Opaque integration-owned backend id.' ),
				'workspace_root_constant' => array( 'type' => 'string', 'description' => 'Optional constant name used by the backend to find the workspace root.' ),
				'abilities'               => array(
					'type'                 => 'object',
					'additionalProperties' => array( 'type' => 'string' ),
					'description'          => 'Private backend operation map keyed by WP Codebox runner workspace operation names.',
				),
			),
		);
	}

	/** @return array<string,mixed> */
	public function prepare( array $input ): array {
		$abilities     = $this->abilities();
		$adopt_ability = (string) ( $abilities['workspace_adopt'] ?? '' );
		$show_ability  = (string) ( $abilities['workspace_show'] ?? '' );
		$clone_ability = (string) ( $abilities['workspace_clone'] ?? '' );
		$add_ability   = (string) ( $abilities['workspace_worktree_add'] ?? '' );

		$checkout_path           = (string) $input['checkout_path'];
		$workspace_root_constant = (string) ( $this->config()['workspace_root_constant'] ?? '' );
		if ( '' !== $checkout_path && '' !== $workspace_root_constant && ! defined( $workspace_root_constant ) ) {
			define( $workspace_root_constant, rtrim( dirname( $checkout_path ), '/' ) );
		}

		$required = '' !== $checkout_path ? array( $adopt_ability ) : array( $show_ability, $clone_ability, $add_ability );
		foreach ( $required as $ability_name ) {
			if ( ! $this->ability_available( $ability_name ) ) {
				return $this->failure( 'backend_unavailable', 'wp_codebox_runner_workspace_prepare_backend_unavailable', 'Runner workspace backend is not available for preparation.' );
			}
		}

		if ( '' !== $checkout_path ) {
			$adopt = $this->execute( $adopt_ability, array( 'path' => $checkout_path, 'name' => $input['repo'] ) );
			if ( empty( $adopt['success'] ) ) {
				return $adopt;
			}

			$result = is_array( $adopt['result'] ?? null ) ? $adopt['result'] : array();
			return array(
				'success' => true,
				'result'  => array(
					'repo'   => (string) $input['repo'],
					'branch' => (string) $input['branch'],
					'handle' => (string) ( $result['handle'] ?? $result['name'] ?? $input['repo'] ),
					'path'   => (string) ( $result['path'] ?? $checkout_path ),
				),
			);
		}

		$show = $this->execute( $show_ability, array( 'name' => $input['repo'] ) );
		if ( empty( $show['success'] ) ) {
			if ( '' === (string) $input['clone_url'] ) {
				return $this->failure( 'clone_url_required', 'wp_codebox_runner_workspace_prepare_clone_url_required', 'Runner workspace primary is missing and clone_url is empty.' );
			}

			$clone_input = array( 'url' => $input['clone_url'], 'name' => $input['repo'] );
			if ( '' !== (string) $input['github_token_env'] && '' !== trim( (string) getenv( (string) $input['github_token_env'] ) ) && preg_match( '#^https://github\.com/#', (string) $input['clone_url'] ) ) {
				$clone_input['auth_token_env'] = $input['github_token_env'];
			}

			$clone = $this->execute( $clone_ability, array_filter( $clone_input, static fn( mixed $value ): bool => '' !== $value ) );
			if ( empty( $clone['success'] ) ) {
				return $clone;
			}
		}

		$worktree_input = array_filter(
			array(
				'repo'           => $input['repo'],
				'branch'         => $input['branch'],
				'from'           => $input['from'],
				'inject_context' => $input['inject_context'],
				'bootstrap'      => $input['bootstrap'],
				'allow_stale'    => $input['allow_stale'],
				'rebase_base'    => $input['rebase_base'],
				'force'          => $input['force'],
			),
			static fn( mixed $value ): bool => '' !== $value && null !== $value
		);

		$worktree = $this->execute( $add_ability, $worktree_input );
		if ( empty( $worktree['success'] ) ) {
			return $worktree;
		}

		$result = is_array( $worktree['result'] ?? null ) ? $worktree['result'] : array();
		return array(
			'success' => true,
			'result'  => array(
				'repo'   => (string) $input['repo'],
				'branch' => (string) ( $result['branch'] ?? $input['branch'] ),
				'handle' => (string) ( $result['handle'] ?? '' ),
				'path'   => (string) ( $result['path'] ?? '' ),
			),
		);
	}

	/** @return array{success:bool,result?:array<string,mixed>,failure_type?:string,error?:array<string,mixed>} */
	public function publish( array $input ): array {
		return $this->execute_named( 'publish_runner_workspace', $input );
	}

	/** @return array{success:bool,result?:array<string,mixed>,failure_type?:string,error?:array<string,mixed>} */
	public function git_status( string $workspace ): array {
		return $this->execute_named( 'workspace_git_status', array( 'name' => $workspace ) );
	}

	/** @return array{success:bool,result?:array<string,mixed>,failure_type?:string,error?:array<string,mixed>} */
	public function git_diff( array $input ): array {
		return $this->execute_named( 'workspace_git_diff', $input );
	}

	/** @return array{success:bool,result?:array<string,mixed>,failure_type?:string,error?:array<string,mixed>} */
	public function run_command( array $input ): array {
		return $this->execute_named( 'run_runner_workspace_command', $input );
	}

	/** @return array<string,mixed> */
	private function config(): array {
		$config    = function_exists( 'apply_filters' ) ? apply_filters( 'wp_codebox_runner_workspace_backend', array() ) : array();
		$config    = is_array( $config ) ? $config : array();
		$issues    = self::backend_config_issues( $config );
		$abilities = $this->normalize_abilities( $config['abilities'] ?? null );

		return array(
			'schema'                  => self::BACKEND_SCHEMA,
			'version'                 => self::BACKEND_VERSION,
			'id'                      => is_string( $config['id'] ?? null ) ? trim( $config['id'] ) : '',
			'workspace_root_constant' => is_string( $config['workspace_root_constant'] ?? null ) ? trim( $config['workspace_root_constant'] ) : '',
			'abilities'               => $abilities,
			'issues'                  => $issues,
		);
	}

	/** @return array<string,mixed> */
	private function abilities(): array {
		$config = $this->config();
		if ( ! empty( $config['issues'] ) ) {
			return array();
		}

		return is_array( $config['abilities'] ?? null ) ? $config['abilities'] : array();
	}

	/** @param array<string,mixed> $config @return array<int,array<string,string>> */
	public static function backend_config_issues( array $config ): array {
		$issues = array();
		if ( isset( $config['schema'] ) && self::BACKEND_SCHEMA !== (string) $config['schema'] ) {
			$issues[] = array( 'field' => 'schema', 'message' => 'runner workspace backend schema must be ' . self::BACKEND_SCHEMA . '.' );
		}
		if ( isset( $config['version'] ) && self::BACKEND_VERSION !== (int) $config['version'] ) {
			$issues[] = array( 'field' => 'version', 'message' => 'runner workspace backend version must be ' . self::BACKEND_VERSION . '.' );
		}
		$id = is_string( $config['id'] ?? null ) ? trim( $config['id'] ) : '';
		if ( '' !== $id && 1 !== preg_match( self::BACKEND_ID_PATTERN, $id ) ) {
			$issues[] = array( 'field' => 'id', 'message' => 'runner workspace backend id must be a lowercase slug.' );
		}
		if ( isset( $config['workspace_root_constant'] ) && ! is_string( $config['workspace_root_constant'] ) ) {
			$issues[] = array( 'field' => 'workspace_root_constant', 'message' => 'runner workspace backend workspace_root_constant must be a string.' );
		}
		if ( isset( $config['abilities'] ) && ! is_array( $config['abilities'] ) ) {
			$issues[] = array( 'field' => 'abilities', 'message' => 'runner workspace backend abilities must be an object.' );
			return $issues;
		}

		foreach ( is_array( $config['abilities'] ?? null ) ? $config['abilities'] : array() as $key => $value ) {
			if ( ! in_array( (string) $key, self::ABILITY_KEYS, true ) ) {
				$issues[] = array( 'field' => 'abilities.' . (string) $key, 'message' => 'runner workspace backend ability key is not supported.' );
				continue;
			}
			if ( ! is_string( $value ) || '' === trim( $value ) || 1 !== preg_match( self::ABILITY_NAME_PATTERN, trim( $value ) ) ) {
				$issues[] = array( 'field' => 'abilities.' . (string) $key, 'message' => 'runner workspace backend ability value must be a namespace/name string.' );
			}
		}

		return $issues;
	}

	/** @return array{success:bool,result?:array<string,mixed>,failure_type?:string,error?:array<string,mixed>} */
	private function execute_named( string $key, array $input ): array {
		$abilities = $this->abilities();
		return $this->execute( (string) ( $abilities[ $key ] ?? '' ), $input );
	}

	/** @return array<string,string> */
	private function normalize_abilities( mixed $abilities ): array {
		if ( ! is_array( $abilities ) ) {
			return array();
		}

		$normalized = array();
		foreach ( self::ABILITY_KEYS as $key ) {
			$value = $abilities[ $key ] ?? null;
			if ( ! is_string( $value ) ) {
				continue;
			}

			$value = trim( $value );
			if ( '' !== $value && preg_match( self::ABILITY_NAME_PATTERN, $value ) ) {
				$normalized[ $key ] = $value;
			}
		}

		return $normalized;
	}

	/** @return array{success:bool,result?:array<string,mixed>,failure_type?:string,error?:array<string,mixed>} */
	private function execute( string $ability_name, array $input ): array {
		if ( ! $this->valid_ability_name( $ability_name ) ) {
			return $this->failure( 'backend_unavailable', 'wp_codebox_runner_workspace_backend_unavailable', 'Runner workspace backend is not available for this operation.' );
		}

		$ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( $ability_name ) : null;
		if ( ! $ability || ! is_callable( array( $ability, 'execute' ) ) ) {
			return $this->failure( 'backend_unavailable', 'wp_codebox_runner_workspace_backend_unavailable', 'Runner workspace backend is not available for this operation.' );
		}

		$result = $ability->execute( $input );
		if ( is_wp_error( $result ) ) {
			return array(
				'success'      => false,
				'failure_type' => 'backend_error',
				'error'        => array(
					'code'    => $result->get_error_code(),
					'message' => $result->get_error_message(),
					'data'    => $result->get_error_data(),
				),
			);
		}

		if ( ! is_array( $result ) ) {
			return $this->failure( 'backend_invalid_response', 'wp_codebox_runner_workspace_backend_invalid_response', 'Runner workspace backend returned an invalid response.' );
		}

		if ( false === ( $result['success'] ?? true ) ) {
			return array(
				'success'      => false,
				'failure_type' => (string) ( $result['failure_type'] ?? 'backend_failed' ),
				'error'        => is_array( $result['error'] ?? null ) ? $result['error'] : array( 'message' => (string) ( $result['error'] ?? 'Runner workspace backend operation failed.' ) ),
			);
		}

		return array( 'success' => true, 'result' => $result );
	}

	private function ability_available( string $ability_name ): bool {
		if ( ! $this->valid_ability_name( $ability_name ) ) {
			return false;
		}

		$ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( $ability_name ) : null;
		return $ability && is_callable( array( $ability, 'execute' ) );
	}

	private function valid_ability_name( string $ability_name ): bool {
		return '' !== $ability_name && 1 === preg_match( self::ABILITY_NAME_PATTERN, $ability_name );
	}

	/** @return array{success:bool,failure_type:string,error:array<string,string>} */
	private function failure( string $failure_type, string $code, string $message ): array {
		return array(
			'success'      => false,
			'failure_type' => $failure_type,
			'error'        => array(
				'code'    => $code,
				'message' => $message,
			),
		);
	}
}
