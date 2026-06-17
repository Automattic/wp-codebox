<?php
/**
 * Host-side parent task request normalization for sandbox runner inputs.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Request_Normalizer {

	private const TASK_INPUT_SCHEMA = WP_Codebox_Agent_Task::INPUT_SCHEMA;

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function normalize( array $input ): array|WP_Error {
		$request = is_array( $input['parent_request'] ?? null ) ? $input['parent_request'] : $input;
		$schema  = (string) ( $request['schema'] ?? '' );
		if ( self::TASK_INPUT_SCHEMA !== $schema ) {
			return $input;
		}

		$goal = trim( (string) ( $request['goal'] ?? '' ) );
		if ( '' === $goal ) {
			return new WP_Error( 'wp_codebox_parent_task_missing', 'parent_request.goal is required.', array( 'status' => 400 ) );
		}

		$context = is_array( $request['context'] ?? null ) ? $request['context'] : array();
		foreach ( array( 'sandbox_session_id', 'group_key', 'audit_findings', 'orchestrator' ) as $context_key ) {
			if ( array_key_exists( $context_key, $request ) ) {
				$context[ $context_key ] = $request[ $context_key ];
			}
		}

		$normalized = array_merge(
			$input,
			array_filter(
				array(
					'goal'                   => $goal,
					'target'                 => is_array( $request['target'] ?? null ) ? $request['target'] : array(),
					'allowed_tools'          => is_array( $request['allowed_tools'] ?? null ) ? $request['allowed_tools'] : array(),
					'sandbox_tool_policy'    => is_array( $request['sandbox_tool_policy'] ?? null ) ? $request['sandbox_tool_policy'] : array(),
					'expected_artifacts'     => is_array( $request['expected_artifacts'] ?? null ) ? $request['expected_artifacts'] : array(),
					'policy'                 => is_array( $request['policy'] ?? null ) ? $request['policy'] : array(),
					'context'                => $context,
					'provider'               => (string) ( $input['provider'] ?? $request['provider'] ?? '' ),
					'model'                  => (string) ( $input['model'] ?? $request['model'] ?? '' ),
					'provider_plugin_paths'  => $this->merge_string_lists( $input['provider_plugin_paths'] ?? array(), $request['provider_plugin_paths'] ?? array() ),
					'agent_bundles'          => $this->agent_bundles( $input, $request ),
					'runtime_task'           => $this->runtime_task( $input, $request ),
					'component_contracts'    => $this->merge_array_lists( $input['component_contracts'] ?? array(), $request['component_contracts'] ?? array() ),
					'secret_env'             => $this->merge_string_lists( $input['secret_env'] ?? array(), $request['secret_env'] ?? array() ),
					'mounts'                 => $this->merge_array_lists( $input['mounts'] ?? array(), $request['mounts'] ?? array() ),
					'workspaces'             => $this->merge_array_lists( $input['workspaces'] ?? array(), $request['workspaces'] ?? array() ),
					'runtime_stack_mounts'   => $this->merge_array_lists( $input['runtime_stack_mounts'] ?? array(), $request['runtime_stack_mounts'] ?? array() ),
					'runtime_state_mounts'   => $this->merge_array_lists( $input['runtime_state_mounts'] ?? array(), $request['runtime_state_mounts'] ?? array() ),
					'runtime_config_mounts'  => $this->merge_array_lists( $input['runtime_config_mounts'] ?? array(), $request['runtime_config_mounts'] ?? array() ),
					'runtime_env'            => $this->merge_string_maps( $input['runtime_env'] ?? array(), $request['runtime_env'] ?? array() ),
					'runtime_overlays'       => $this->merge_array_lists( $input['runtime_overlays'] ?? array(), $request['runtime_overlays'] ?? array() ),
					'task_timeout_seconds'   => (int) ( $input['task_timeout_seconds'] ?? $request['task_timeout_seconds'] ?? 0 ),
					'max_turns'              => (int) ( $input['max_turns'] ?? $request['max_turns'] ?? 0 ),
					'sandbox_session_id'     => (string) ( $input['sandbox_session_id'] ?? $request['sandbox_session_id'] ?? '' ),
					'orchestrator'           => is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : ( is_array( $request['orchestrator'] ?? null ) ? $request['orchestrator'] : array() ),
					'artifacts_path'         => (string) ( $input['artifacts_path'] ?? $request['artifacts'] ?? '' ),
					'wp_codebox_bin'         => (string) ( $input['wp_codebox_bin'] ?? $request['wp_codebox_bin'] ?? '' ),
				),
				static fn( mixed $value ): bool => '' !== $value && array() !== $value && 0 !== $value
			)
		);

		unset( $normalized['parent_request'] );

		return $normalized;
	}

	/** @return string[] */
	private function string_list( mixed $values ): array {
		return WP_Codebox_Agent_Task::string_list( $values );
	}

	/** @return string[] */
	private function merge_string_lists( mixed ...$lists ): array {
		$merged = array();
		foreach ( $lists as $list ) {
			$merged = array_merge( $merged, $this->string_list( $list ) );
		}

		return array_values( array_unique( $merged ) );
	}

	/** @return array<string,string> */
	private function string_map( mixed $values ): array {
		if ( ! is_array( $values ) ) {
			return array();
		}

		$mapped = array();
		foreach ( $values as $name => $value ) {
			$name = trim( (string) $name );
			if ( '' !== $name && is_scalar( $value ) ) {
				$mapped[ $name ] = (string) $value;
			}
		}

		return $mapped;
	}

	/** @return array<string,string> */
	private function merge_string_maps( mixed ...$maps ): array {
		$merged = array();
		foreach ( $maps as $map ) {
			$merged = array_merge( $merged, $this->string_map( $map ) );
		}

		return $merged;
	}

	/** @return array<int,array<string,mixed>> */
	private function merge_array_lists( mixed ...$lists ): array {
		$merged = array();
		foreach ( $lists as $list ) {
			foreach ( is_array( $list ) ? $list : array() as $entry ) {
				if ( is_array( $entry ) ) {
					$merged[] = $entry;
				}
			}
		}

		return $merged;
	}

	/** @param array<string,mixed> $input Direct ability input. @param array<string,mixed> $request Parent request input. @return array<int,array<string,mixed>> */
	private function agent_bundles( array $input, array $request = array() ): array {
		$bundles    = $this->merge_array_lists( $input['agent_bundles'] ?? array(), $request['agent_bundles'] ?? array() );
		$normalized = array();
		foreach ( $bundles as $bundle ) {
			$source = isset( $bundle['source'] ) ? trim( (string) $bundle['source'] ) : '';
			$inline = is_array( $bundle['bundle'] ?? null ) ? $bundle['bundle'] : null;
			if ( '' === $source && null === $inline ) {
				continue;
			}

			$entry = array();
			if ( '' !== $source ) {
				$entry['source'] = $source;
			}
			if ( null !== $inline ) {
				$entry['bundle'] = $inline;
			}
			foreach ( array( 'slug', 'token_env' ) as $field ) {
				$value = isset( $bundle[ $field ] ) ? trim( (string) $bundle[ $field ] ) : '';
				if ( '' !== $value ) {
					$entry[ $field ] = $value;
				}
			}
			$on_conflict          = (string) ( $bundle['on_conflict'] ?? 'upgrade' );
			$entry['on_conflict'] = in_array( $on_conflict, array( 'error', 'skip', 'upgrade' ), true ) ? $on_conflict : 'upgrade';
			if ( isset( $bundle['owner_id'] ) && (int) $bundle['owner_id'] > 0 ) {
				$entry['owner_id'] = (int) $bundle['owner_id'];
			}
			if ( is_array( $bundle['import_principal'] ?? null ) ) {
				$entry['import_principal'] = $this->agent_bundle_import_principal( $bundle['import_principal'] );
			}

			$normalized[] = $entry;
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $request Parent request input. @return array<string,mixed> */
	private function runtime_task( array $input, array $request = array() ): array {
		$candidates = array(
			$input['runtime_task'] ?? $input['runtimeTask'] ?? null,
			$request['runtime_task'] ?? $request['runtimeTask'] ?? null,
		);

		foreach ( $candidates as $bundle ) {
			if ( is_array( $bundle ) ) {
				return $bundle;
			}
		}

		return array();
	}

	/** @param array<string,mixed> $principal Raw import principal. @return array<string,mixed> */
	private function agent_bundle_import_principal( array $principal ): array {
		$normalized = array();
		foreach ( array( 'agent_id', 'owner_id', 'token_id' ) as $field ) {
			if ( isset( $principal[ $field ] ) && (int) $principal[ $field ] > 0 ) {
				$normalized[ $field ] = (int) $principal[ $field ];
			}
		}

		$capabilities = $this->string_list( $principal['capabilities'] ?? array() );
		if ( ! empty( $capabilities ) ) {
			$normalized['capabilities'] = $capabilities;
		}
		if ( is_array( $principal['scope'] ?? null ) ) {
			$normalized['scope'] = $principal['scope'];
		}

		return $normalized;
	}
}
